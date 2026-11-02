import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import * as XLSX from 'xlsx';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';

const CONTAINER = 'cidef';
const SOURCE = 'finanzas/VIN VEND 10-26.xlsx';
const PERIOD = '2026-10';

export async function refreshFinanzas() {
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connection) throw new Error('Missing AZURE_STORAGE_CONNECTION_STRING');
  const service = BlobServiceClient.fromConnectionString(connection);
  if (!new URL(service.url).hostname.endsWith('.blob.core.windows.net')) throw new Error('Azure Blob endpoint required');
  const blob = service.getContainerClient(CONTAINER).getBlobClient(SOURCE);
  const props = await blob.getProperties();
  if (!props.etag || !props.contentLength) throw new Error('Empty or unversioned Finanzas file');
  const bytes = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: props.etag } });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const book = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellFormula: true });
  const sheets = book.SheetNames.map(name => {
    const sheet = book.Sheets[name];
    const cells = Object.entries(sheet).filter(([address]) => !address.startsWith('!'))
      .map(([address, cell]) => ({ address, type: cell.t ?? null, value: cell.v ?? null,
        formula: cell.f ?? null, format: cell.z ?? null, text: cell.w ?? null }));
    return { name, range: sheet['!ref'] ?? null, cells };
  });
  // La segunda hoja contiene el detalle; la primera es un resumen.
  const detail = book.Sheets['VIN VEND 10-2026'];
  if (!detail) throw new Error('Missing Finanzas detail sheet VIN VEND 10-2026');
  const matrix = XLSX.utils.sheet_to_json(detail, { header: 1, raw: true, defval: null });
  const headers = matrix[0].map(value => String(value ?? '').trim().toUpperCase());
  const required = ['EMPRESA', 'CANT', 'TIPO', 'NUMERO', 'FECHA', 'RUT', 'VIN',
    'MARCA', 'FACTURA', 'DESCRIPCION MODELO', 'SUCURSAL', 'NETO', 'IVA', 'TOTAL'];
  if (required.some(name => !headers.includes(name))) throw new Error('Invalid Finanzas detail headers');
  const at = (row, name) => row[headers.indexOf(name)];
  const clean = value => value == null ? '' : String(value).trim();
  const brands = new Set(['DFM', 'DFLM', 'FOTON']);
  const movements = [];
  for (let index = 1; index < matrix.length; index++) {
    const row = matrix[index], marca = clean(at(row, 'MARCA')).toUpperCase();
    if (!brands.has(marca)) continue;
    const tipo = clean(at(row, 'TIPO')), cantidad = Number(at(row, 'CANT'));
    const fecha = clean(at(row, 'FECHA'));
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha);
    const vin = clean(at(row, 'VIN')), numero = clean(at(row, 'NUMERO'));
    if (!match || !vin || !numero || !['FAC-EL', 'N/C-EL'].includes(tipo) ||
      cantidad !== (tipo === 'FAC-EL' ? 1 : -1)) {
      throw new Error('Invalid Finanzas movement at Excel row ' + (index + 1));
    }
    const isoDate = match[3] + '-' + match[2] + '-' + match[1];
    if (new Date(isoDate).toISOString().slice(0, 10) !== isoDate) {
      throw new Error('Invalid Finanzas date at Excel row ' + (index + 1));
    }
    movements.push({ fila_excel: index + 1, empresa: clean(at(row, 'EMPRESA')),
      tipo_documento: tipo, numero_documento: numero, fecha_documento: isoDate,
      rut: clean(at(row, 'RUT')) || null, vin, marca, cantidad,
      factura: clean(at(row, 'FACTURA')) || null,
      modelo: clean(at(row, 'DESCRIPCION MODELO')) || null,
      sucursal: clean(at(row, 'SUCURSAL')) || null,
      neto: at(row, 'NETO'), iva: at(row, 'IVA'), total: at(row, 'TOTAL') });
  }
  if (!movements.length) throw new Error('No valid Finanzas movements');
  const pool = getAzurePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = await readFile(new URL('../scripts/sql/finanzas-cierre-mensual.sql', import.meta.url), 'utf8');
    await client.query(schema);
    const old = await client.query('SELECT sha256 FROM finanzas_cierre_archivos WHERE periodo=$1 FOR UPDATE', [PERIOD]);
    const unchanged = old.rows[0]?.sha256 === sha256;
    if (!unchanged) {
    await client.query(`INSERT INTO finanzas_cierre_archivos(periodo,blob_path,blob_etag,sha256,archivo_bytes,hojas,actualizado_en)
      VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(periodo) DO UPDATE SET
      blob_path=EXCLUDED.blob_path,blob_etag=EXCLUDED.blob_etag,sha256=EXCLUDED.sha256,
      archivo_bytes=EXCLUDED.archivo_bytes,hojas=EXCLUDED.hojas,actualizado_en=now()`,
      [PERIOD,SOURCE,props.etag,sha256,bytes.length,sheets.length]);
    await client.query('DELETE FROM finanzas_cierre_hojas WHERE periodo=$1', [PERIOD]);
    for (let i=0; i<sheets.length; i++) {
      const s = sheets[i];
      await client.query(`INSERT INTO finanzas_cierre_hojas(periodo,orden_hoja,nombre_hoja,rango,celdas)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [PERIOD,i+1,s.name,s.range,JSON.stringify(s.cells)]);
    }
    }
    await client.query('DELETE FROM finanzas_ventas WHERE periodo=$1', [PERIOD]);
    await client.query(`INSERT INTO finanzas_ventas(
      periodo,fila_excel,empresa,tipo_documento,numero_documento,fecha_documento,
      rut,vin,marca,cantidad,factura,modelo,sucursal,neto,iva,total)
      SELECT $1,x.fila_excel,x.empresa,x.tipo_documento,x.numero_documento,
        x.fecha_documento::date,x.rut,x.vin,x.marca,x.cantidad,x.factura,
        x.modelo,x.sucursal,x.neto,x.iva,x.total
      FROM jsonb_to_recordset($2::jsonb) AS x(
        fila_excel int,empresa text,tipo_documento text,numero_documento text,
        fecha_documento text,rut text,vin text,marca text,cantidad int,
        factura text,modelo text,sucursal text,neto numeric,iva numeric,total numeric)`,
      [PERIOD, JSON.stringify(movements)]);
    await client.query('COMMIT');
    return { status: unchanged ? 'ALREADY_LOADED' : 'LOADED', period: PERIOD,
      sha256, sheets: sheets.length, movements: movements.length,
      net_units: movements.reduce((sum,row)=>sum+row.cantidad,0) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshFinanzas().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ status: 'FAILED', code: error.code || error.name })); process.exitCode=1; })
    .finally(() => closeAzurePool());
}
