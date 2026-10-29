import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';

const BATCH_SIZE = 150;
const COMMON = ['NumOperacion','TipoProceso','FechaCotizacion','Distribuidor','Sucursal','Vendedor','Ejecutivo','ModeloVehiculo','VersionVehiculo','ValorVehiculo','Promocion','PlazoCredito','NumContrato','MontoFinanciado','FechaPagare','FechaPrimeraCuota','UltimoVencimientoNoPagado','FormaPago','Rut','NombreCompleto','Comuna','Ciudad','Region','FechaCancelacion','MotivoCancelacion'];
export const SOURCE_COLUMNS = {
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
  let inserted = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const values = []; let param = 1;
    const tuples = rows.slice(start, start + BATCH_SIZE).map(row => {
      const record = { snapshot_date: date, source_type: type, ...row, source_file: filename, load_kind: 'DAILY_SNAPSHOT' };
      return `(${TARGET.map(column => { values.push(record[column] ?? null); return `$${param++}`; }).join(',')})`;
    });
    const result = await client.query(`INSERT INTO public.forum_funnel_raw (${TARGET.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (snapshot_date,source_type,numero_operacion) DO NOTHING`, values);
    inserted += result.rowCount;
  }
  return inserted;
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number(date.slice(0, 4)) > 0
    && Number.isFinite(Date.parse(date + 'T00:00:00Z'))
    && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
}

function requireAzure() {
  const url = process.env.AZURE_DATABASE_URL;
  assert.ok(url && /^postgres(?:ql)?:$/.test(new URL(url).protocol)
    && new URL(url).hostname.endsWith('.postgres.database.azure.com'), 'AZURE_DATABASE_URL must point to PostgreSQL Azure');
}

export async function loadForumDay({ date, container, pool } = {}) {
  assert.ok(validDate(date), 'A valid YYYY-MM-DD Forum date is required');
  if (!container) {
    const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
    assert.ok(connection, 'AZURE_STORAGE_CONNECTION_STRING is required');
    const service = BlobServiceClient.fromConnectionString(connection);
    assert.ok(service.url.startsWith('https://') && new URL(service.url).hostname.endsWith('.blob.core.windows.net'), 'Azure Blob HTTPS endpoint is required');
    container = service.getContainerClient(process.env.AZURE_CONTAINER || 'cidef');
  }
  const objects = [];
  for await (const blob of container.listBlobsFlat({ prefix: 'Forum/' })) objects.push(blob.name);
  const prefixes = { COTIZACION: 'Cotizacion', PRECURSE: 'Precurse', CURSE: 'Curse' };
  const sources = [];
  for (const [type, prefix] of Object.entries(prefixes)) {
    const filename = `${prefix}_Cidef_${date.replaceAll('-', '')}.csv`;
    const matches = objects.filter(name => path.posix.basename(name) === filename);
    assert.equal(matches.length, 1, `Expected exactly one ${type} CSV for ${date}`);
    const key = matches[0], blob = container.getBlobClient(key), properties = await blob.getProperties();
    assert.ok(properties.etag && properties.contentLength > 0, `Empty or unversioned ${type} CSV`);
    sources.push({ type, key, blob, etag: properties.etag });
  }
  // Parse all three original interfaces before acquiring a database connection.
  for (const source of sources) {
    const buffer = await source.blob.downloadToBuffer(undefined, undefined, { conditions: { ifMatch: source.etag } });
    source.rows = parseCsv(buffer, source.type);
  }
  if (!pool) { requireAzure(); pool = getAzurePool(); }
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    // Also coordinates with writers that do not know this CLI; ordinary reads remain available.
    await client.query('LOCK TABLE public.forum_funnel_raw IN SHARE ROW EXCLUSIVE MODE');
    for (const source of sources) {
      inserted += await insertRows(client, date, source.type, source.key, source.rows);
      const actual = await client.query(
        'SELECT numero_operacion::text AS id FROM public.forum_funnel_raw WHERE snapshot_date=$1::date AND source_type=$2',
        [date, source.type]);
      const expectedIds = new Set(source.rows.map(row => row.numero_operacion));
      const actualIds = new Set(actual.rows.map(row => row.id));
      assert.equal(actual.rows.length, source.rows.length, 'Forum row count differs from CSV for ' + source.type);
      assert.equal(actualIds.size, expectedIds.size, 'Forum distinct ID count differs for ' + source.type);
      for (const id of expectedIds) assert.ok(actualIds.has(id), 'Missing Forum operation ' + id + ' in ' + source.type);
    }
    await client.query('COMMIT');
    return { status: 'COMPLETE', mode: 'DAILY_SNAPSHOT', snapshot_date: date, inserted_rows: inserted,
      certification: sources.map(source => ({ source_type: source.type, source_file: source.key,
        source_etag: source.etag, rows: source.rows.length })) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function recoverManifest(manifestPath) {
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.ok(Array.isArray(manifest), 'Manifest must be a FORUM snapshot array');
if (manifest.length === 0) return { status: 'NO_FORUM_SNAPSHOT_FILES_IN_BLOB_MIRROR', files: [] };
requireAzure();
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
  return { status: 'COMPARED_AND_RECOVERED_FROM_AZURE_BLOB_MIRROR', date_semantics: 'snapshot_date/received_file_date comes from the file date; operation_date_field is parsed from the CSV business event date and is preserved separately', files: certified, recovered_rows: certified.reduce((sum, file) => sum + file.inserted_rows, 0) };
} finally { await closeAzurePool(); }
}

export async function main(argv = process.argv.slice(2)) {
  const daily = argv.length === 2 && argv[0] === '--date';
  assert.ok(daily || argv.length === 1 && !argv[0].startsWith('-'), 'Use --date YYYY-MM-DD or a local recovery manifest');
  if (daily) assert.ok(validDate(argv[1]), 'A valid YYYY-MM-DD Forum date is required');
  if (daily) requireAzure();
  try { return daily ? await loadForumDay({ date: argv[1] }) : await recoverManifest(argv[0]); }
  finally { await closeAzurePool(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ status: 'FAILED', code: error.code || error.name }));
    process.exitCode = 1;
  });
}
