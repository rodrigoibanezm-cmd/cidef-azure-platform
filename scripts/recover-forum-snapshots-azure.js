import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';

const BATCH_SIZE = 150;
const COMMON = ['NumOperacion','TipoProceso','FechaCotizacion','Distribuidor','Sucursal','Vendedor','Ejecutivo','ModeloVehiculo','VersionVehiculo','ValorVehiculo','Promocion','PlazoCredito','NumContrato','MontoFinanciado','FechaPagare','FechaPrimeraCuota','UltimoVencimientoNoPagado','FormaPago','Rut','NombreCompleto','Comuna','Ciudad','Region','FechaCancelacion','MotivoCancelacion'];
const SOURCE_COLUMNS = {
  COTIZACION: COMMON,
  PRECURSE: [...COMMON, 'CantVehiculo', 'FechaPrecurse'],
  CURSE: [...COMMON, 'CantVehiculo', 'FechaCurse'],
};
const TARGET = ['snapshot_date','source_type','numero_operacion','tipo_proceso','fecha_cotizacion','distribuidor','sucursal','vendedor','ejecutivo','modelo_vehiculo','version_vehiculo','valor_vehiculo','promocion','plazo_credito','numero_contrato','monto_financiado','fecha_pagare','fecha_primera_cuota','ultimo_vencimiento_no_pagado','forma_pago','rut','nombre_completo','comuna','ciudad','region','fecha_cancelacion','motivo_cancelacion','cantidad_vehiculo','fecha_precurse','fecha_curse','source_file','load_kind'];

function csvMatrix(buffer) {
  const input = new TextDecoder('windows-1252').decode(buffer).replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ';') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new Error('Malformed CSV: unclosed quoted field');
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(x => !(x.length === 1 && x[0] === ''));
}
function text(value) { value = (value ?? '').trim(); return !value || value.toUpperCase() === 'NULL' ? null : value; }
function integer(value, column, line, required = false) {
  value = text(value);
  if (value == null) { if (required) throw new Error(`Empty ${column} at data row ${line}`); return null; }
  if (!/^-?\d+$/.test(value)) throw new Error(`Invalid ${column} at data row ${line}: ${value}`);
  return value;
}
function datetime(value, column, line, preserveInvalid = false) {
  value = text(value); if (!value) return null;
  let match = value.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]} ${match[4] || '00'}:${match[5] || '00'}:${match[6] || '00'}`;
  match = value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4] || '00'}:${match[5] || '00'}:${match[6] || '00'}`;
  if (preserveInvalid) return value;
  throw new Error(`Invalid ${column} at data row ${line}: ${value}`);
}
function parseCsv(buffer, type) {
  const expected = SOURCE_COLUMNS[type]; assert.ok(expected, `Unsupported FORUM source type: ${type}`);
  const matrix = csvMatrix(buffer); assert.ok(matrix.length, `FORUM ${type} CSV is empty`);
  const headers = matrix[0].map(value => value.trim());
  assert.deepEqual(headers, expected, `FORUM ${type} CSV schema mismatch`);
  const seen = new Set();
  const rows = matrix.slice(1).map((values, i) => {
    const line = i + 2; assert.equal(values.length, expected.length, `Invalid column count at data row ${line}`);
    const source = Object.fromEntries(expected.map((key, j) => [key, values[j]]));
    const operation = integer(source.NumOperacion, 'NumOperacion', line, true);
    assert.ok(!seen.has(operation), `Duplicate NumOperacion ${operation} at data row ${line}`); seen.add(operation);
    return {
      numero_operacion: operation, tipo_proceso: text(source.TipoProceso),
      fecha_cotizacion: datetime(source.FechaCotizacion, 'FechaCotizacion', line),
      distribuidor: text(source.Distribuidor), sucursal: text(source.Sucursal), vendedor: text(source.Vendedor), ejecutivo: text(source.Ejecutivo),
      modelo_vehiculo: text(source.ModeloVehiculo), version_vehiculo: text(source.VersionVehiculo),
      valor_vehiculo: integer(source.ValorVehiculo, 'ValorVehiculo', line), promocion: text(source.Promocion),
      plazo_credito: integer(source.PlazoCredito, 'PlazoCredito', line), numero_contrato: text(source.NumContrato),
      monto_financiado: integer(source.MontoFinanciado, 'MontoFinanciado', line),
      fecha_pagare: datetime(source.FechaPagare, 'FechaPagare', line),
      fecha_primera_cuota: datetime(source.FechaPrimeraCuota, 'FechaPrimeraCuota', line, true),
      ultimo_vencimiento_no_pagado: datetime(source.UltimoVencimientoNoPagado, 'UltimoVencimientoNoPagado', line, true),
      forma_pago: text(source.FormaPago), rut: text(source.Rut), nombre_completo: text(source.NombreCompleto),
      comuna: text(source.Comuna), ciudad: text(source.Ciudad), region: text(source.Region),
      fecha_cancelacion: datetime(source.FechaCancelacion, 'FechaCancelacion', line),
      motivo_cancelacion: text(source.MotivoCancelacion),
      cantidad_vehiculo: integer(source.CantVehiculo, 'CantVehiculo', line),
      fecha_precurse: datetime(source.FechaPrecurse, 'FechaPrecurse', line),
      fecha_curse: datetime(source.FechaCurse, 'FechaCurse', line),
    };
  });
  return rows;
}
async function insertRows(client, date, type, filename, rows) {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const values = []; let param = 1;
    const tuples = rows.slice(start, start + BATCH_SIZE).map(row => {
      const record = { snapshot_date: date, source_type: type, ...row, source_file: filename, load_kind: 'DAILY_SNAPSHOT' };
      return `(${TARGET.map(column => { values.push(record[column] ?? null); return `$${param++}`; }).join(',')})`;
    });
    await client.query(`INSERT INTO public.forum_funnel_raw (${TARGET.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (snapshot_date,source_type,numero_operacion) DO NOTHING`, values);
  }
}

const manifestPath = process.argv[2];
assert.ok(manifestPath, 'Manifest path is required');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.ok(Array.isArray(manifest), 'Manifest must be a FORUM snapshot array');
if (manifest.length === 0) { console.log(JSON.stringify({ status: 'NO_FORUM_SNAPSHOT_FILES_IN_BLOB_MIRROR', files: [] })); process.exit(0); }
const certified = [];
const pool = getAzurePool();
try {
  for (const item of manifest) {
    assert.match(item.snapshot_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(SOURCE_COLUMNS[item.source_type], `Invalid source type: ${item.source_type}`);
    const filename = path.basename(item.file);
    const filenameMatch = filename.match(/^((Cotizacion_Cidef)|(Precurse_Cidef)|(Curse_Cidef))_(\d{4})(\d{2})(\d{2})\.csv$/);
    assert.ok(filenameMatch, `Invalid FORUM snapshot filename: ${filename}`);
    const receivedFileDate = `${filenameMatch[5]}-${filenameMatch[6]}-${filenameMatch[7]}`;
    assert.equal(item.snapshot_date, receivedFileDate, `snapshot_date must match the file receipt date in ${filename}`);
    const operationDateField = { COTIZACION: 'fecha_cotizacion', PRECURSE: 'fecha_precurse', CURSE: 'fecha_curse' }[item.source_type];
    const rows = parseCsv(await readFile(item.file), item.source_type);
    const client = await pool.connect();
    let existing; let beforeCount; let afterCount;
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT numero_operacion::text AS numero_operacion FROM public.forum_funnel_raw WHERE snapshot_date=$1 AND source_type=$2 AND load_kind='DAILY_SNAPSHOT' FOR UPDATE`, [item.snapshot_date, item.source_type]);
      existing = new Set(current.rows.map(row => row.numero_operacion));
      beforeCount = existing.size;
      const sourceOperations = new Set(rows.map(row => row.numero_operacion));
      const extra = [...existing].filter(operation => !sourceOperations.has(operation));
      assert.equal(extra.length, 0, `Azure has operations absent from the original R2 CSV for ${item.snapshot_date} ${item.source_type}: ${extra.slice(0, 10).join(',')}`);
      const missingRows = rows.filter(row => !existing.has(row.numero_operacion));
      if (missingRows.length) await insertRows(client, item.snapshot_date, item.source_type, item.blob_name, missingRows);
      const after = await client.query(`SELECT numero_operacion::text AS numero_operacion FROM public.forum_funnel_raw WHERE snapshot_date=$1 AND source_type=$2 AND load_kind='DAILY_SNAPSHOT'`, [item.snapshot_date, item.source_type]);
      const actualOperations = new Set(after.rows.map(row => row.numero_operacion));
      const unresolved = [...sourceOperations].filter(operation => !actualOperations.has(operation));
      assert.equal(unresolved.length, 0, `Could not insert R2 operations for ${item.snapshot_date} ${item.source_type}: ${unresolved.slice(0, 10).join(',')}`);
      afterCount = actualOperations.size;
      assert.equal(afterCount, sourceOperations.size, `Snapshot row count differs from source for ${item.snapshot_date} ${item.source_type}`);
      await client.query('COMMIT');
      certified.push({ snapshot_date: item.snapshot_date, received_file_date: receivedFileDate, operation_date_field: operationDateField, source_type: item.source_type, source_rows: rows.length, rows_before: beforeCount, inserted_rows: missingRows.length, inserted_operations: missingRows.map(row => row.numero_operacion), rows_after: afterCount, blob_name: item.blob_name });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    assert.equal(afterCount, rows.length, `Snapshot operation certification failed for ${item.snapshot_date} ${item.source_type}`);
  }
  console.log(JSON.stringify({ status: 'COMPARED_AND_RECOVERED_FROM_AZURE_BLOB_MIRROR', date_semantics: 'snapshot_date/received_file_date comes from the file date; operation_date_field is parsed from the CSV business event date and is preserved separately', files: certified, recovered_rows: certified.reduce((sum, file) => sum + file.inserted_rows, 0) }));
} finally { await closeAzurePool(); }
