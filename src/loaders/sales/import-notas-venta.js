// Adapted from cidef-data-loader; only Azure I/O changes.
import { findDailyXlsx, downloadBlobObject, blobSource } from './source-io.js';
import { parseSheet } from './xlsx.js';
import { replaceTableSnapshot } from './db.js';

const FILE_PREFIX = 'ventas/Listado_Notas_de_Venta_';
const SHEET_NAME = 'Hoja1';
const TABLE_NAME = 'notas_venta_raw';

const ALLOWED_BRANDS = new Set(['DFLM', 'DFM', 'FOTON', 'ZNA', 'ZNA DONGFENG']);

const KEEP_COLUMNS = [
  'chasis',
  'nro_operacion',
  'nota_de_venta',
  'fecha_nota_de_venta',
  'fecha_creacion_nv',
  'desc_sucursal_vta',
  'vendedor',
  'tiene_operacion',
  'esta_autorizado',
  'esta_pendiente_entrega',
  'razon_social',
  'cliente',
  'region',
  'comuna',
  'ciudad',
  'email',
  'modelo',
  'modelo_comercial',
  'deposito_unidad',
  'desc_mae_marca',
  'factura',
  'fecha_factura',
  'precio_vta',
  'precio_vta_pesos_con_iva',
  'reserva',
  'numero_recibo',
  'importe',
  'etapa',
  'entidad_financiera',
  'comision_entidad_finan',
  'comentario',
];

export async function run() {
  const startedAt = Date.now();
  const file = await findDailyXlsx(FILE_PREFIX);
  const buffer = await downloadBlobObject(file.Key);
  const parsed = parseSheet(buffer, SHEET_NAME);

  const indexByColumn = new Map(parsed.columns.map((column, index) => [column, index]));
  const missing = KEEP_COLUMNS.filter((column) => !indexByColumn.has(column));
  if (missing.length) throw new Error(`Missing required sales-note columns: ${missing.join(', ')}`);

  const brandIndex = indexByColumn.get('desc_mae_marca');
  const filtered = parsed.rows.filter((row) => ALLOWED_BRANDS.has(String(row[brandIndex] ?? '').trim().toUpperCase()));
  const rows = filtered.map((row) => KEEP_COLUMNS.map((column) => row[indexByColumn.get(column)]));
  const result = await replaceTableSnapshot(TABLE_NAME, KEEP_COLUMNS, rows);

  return {
    source: blobSource(file),
    sheet: SHEET_NAME,
    table: TABLE_NAME,
    strategy: 'FULL_SNAPSHOT_REPLACE',
    rowsLoaded: parsed.rows.length,
    rowsExcludedByBrand: parsed.rows.length - rows.length,
    rowsFinal: rows.length,
    columnsSource: parsed.columns.length,
    columnsFinal: KEEP_COLUMNS.length,
    allowedBrands: [...ALLOWED_BRANDS],
    batchSize: result.batchSize,
    keptColumns: KEEP_COLUMNS,
    elapsedMs: Date.now() - startedAt,
  };
}
