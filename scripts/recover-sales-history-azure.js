// One-time recovery: add missing historical SALES rows, never update or delete existing rows.
import { createContainer, validDate } from '../src/loaders/sales/source-io.js';
import { parseSheet } from '../src/loaders/sales/xlsx.js';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';

const date = process.argv[2];
if (!validDate(date)) throw new Error('Usage: node scripts/recover-sales-history-azure.js YYYY-MM-DD');
const key = 'ventas/Estadisticas_de_Venta_por_Vista_' + date.replaceAll('-', '_') + '.xlsx';
const names = [
  'id', 'nro_operacion', 'razon_social', 'cliente', 'ciudad', 'region',
  'articulo', 'desc_articulo', 'nro_vin_chasis', 'nombre_usuario',
  'fecha_factura', 'precio_vta', 'precio_vta_pesos_con_iva',
  'id_sucursal_vta', 'desc_sucursal_vta', 'id_mae_marca', 'desc_mae_marca',
  'id_tipo_operacion', 'desc_tipo_oper', 'nro_propuesta', 'fecha_propuesta',
  'factura', 'nro_factura', 'fecha_eta', 'categoria_cliente', 'entidad_financiera',
  'comision_entidad_finan',
];
const brands = new Set(['DFM', 'FOTON', 'ZNA', 'ZNA DONGFENG']);
const categories = new Set(['Cliente General', 'Concesionaria']);
const ident = s => '"' + s.replaceAll('"', '""') + '"';
function saleDate(value) {
  const s = String(value ?? '').trim();
  if (/^\\d{5}(?:\\.\\d+)?$/.test(s)) {
    const n = Number(s);
    if (n < 20000 || n > 80000) throw new Error('Invalid Excel date');
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}
const connection = process.env.AZURE_DATABASE_URL;
if (!connection || !new URL(connection).hostname.endsWith('.postgres.database.azure.com')) {
  throw new Error('AZURE_DATABASE_URL must point to Azure PostgreSQL');
}
const container = createContainer();
const blob = container.getBlobClient(key);
const props = await blob.getProperties();
if (!props.etag || !props.contentLength) throw new Error('Missing or empty source: ' + key);
const workbook = await blob.downloadToBuffer(undefined, undefined, { conditions: { ifMatch: props.etag } });
const sheet = parseSheet(workbook, 'Ventas');
const indexes = names.map(n => sheet.columns.indexOf(n));
if (indexes.some(n => n < 0)) throw new Error('Missing SALES source columns');
const rows = [];
const ids = new Set();
for (const input of sheet.rows) {
  const row = indexes.map(i => input[i]);
  const brand = String(row[16] ?? '').trim().replace(/\\s+/g, ' ').toUpperCase().replace(/^DFLM$/, 'DFM');
  const category = String(row[24] ?? '').trim().replace(/\\s+/g, ' ');
  if (!brands.has(brand) || !categories.has(category)) continue;
  const invoiceDate = saleDate(row[10]);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(invoiceDate) || invoiceDate > '2024-12-31') continue;
  const id = String(row[0] ?? '').trim();
  if (!id || ids.has(id)) throw new Error('Missing/duplicate historical SALES id: ' + id);
  ids.add(id);
  row[16] = brand;
  row[10] = invoiceDate;
  rows.push(row);
}
if (!rows.length) throw new Error('No historical SALES rows found');
const pool = getAzurePool();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('cidef_ventas_raw_neon_azure_sync')) AS locked");
  if (!lock.rows[0].locked) throw new Error('Another SALES load is running');
  const cols = await client.query(`SELECT attname AS name, format_type(atttypid,atttypmod) AS type
    FROM pg_attribute WHERE attrelid='public.ventas_raw'::regclass AND attnum>0 AND NOT attisdropped`);
  const types = new Map(cols.rows.map(c => [c.name, c.type]));
  if (names.some(n => !types.has(n))) throw new Error('SALES RAW column mismatch');
  await client.query(`CREATE TEMP TABLE recover_sales (${names.map(n => ident(n) + ' text').join(',')}) ON COMMIT DROP`);
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    const placeholders = batch.map((r, i) => '(' + r.map((_, j) => '$' + (i * names.length + j + 1)).join(',') + ')').join(',');
    await client.query(`INSERT INTO recover_sales (${names.map(ident).join(',')}) VALUES ${placeholders}`, batch.flat());
  }
  const fields = names.map(ident).join(',');
  const selected = names.map(n => 's.' + ident(n) + '::' + types.get(n)).join(',');
  const inserted = await client.query(`INSERT INTO public.ventas_raw (${fields})
    SELECT ${selected} FROM recover_sales s
    WHERE NOT EXISTS (SELECT 1 FROM public.ventas_raw t WHERE t.id::text = s.id)`);
  await client.query('COMMIT');
  console.log(JSON.stringify({ source: key, historicalRows: rows.length, inserted: inserted.rowCount, existingPreserved: true }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await closeAzurePool();
}
