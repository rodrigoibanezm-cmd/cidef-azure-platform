// Adapted from cidef-data-loader; only Azure I/O changes.
import { findDailyXlsx, downloadBlobObject, blobSource } from './source-io.js';
import { parseSheet } from './xlsx.js';
import { queryDb, replaceTableSnapshot } from './db.js';

const FILE_PREFIX = 'ventas/Estadisticas_de_Venta_por_Vista_';
const SHEET_NAME = 'Ventas';
const TABLE_NAME = 'ventas_raw';

const ALLOWED_BRANDS = new Set(['DFLM', 'DFM', 'FOTON', 'ZNA', 'ZNA DONGFENG']);
const COMMERCIAL_CUSTOMER_CATEGORIES = new Set(['Cliente General', 'Concesionaria']);

const AUGUST_2026_VIN_OVERRIDES = [
  'LVAV2MAB2TU485673',
  'LGJE5EE01TM514771',
  'LVAV2MAB9TU488506',
  'LGJE5EE09TM529146',
  'LVAV2JVBXTE321994',
  'LGJE5EE06TM521408',
  'LVAV2JVB3TE322341',
  'LVAV2JVB6TE322656',
  'LMXA14AG6VZ352968',
  'LVAV2MAB9TU490143',
  'LVAV2MAB3TU485424',
  'LVAV2MAB8TU490148',
  'LGJE1EE24TM534185',
  'LVAV2AVB3TE354755',
  'LVAV2MAB7TU460042',
  'LVAV2MAB9TU486237',
  'LVAV2AVB2TE222571',
  'LVAV2AVB5TE355163',
  'LVAV2AVB9TE322327',
  'LMXA14AG6VZ352954',
  'LVAV2MAB8TU485435',
  'LVAV2MAB2TU485429',
  'LMXA14AG9VZ357825',
  'LVAV2MAB3TU451953',
  'LVAV2MAB1TU486734',
  'LGJE1EE26TM554003',
  'LVAV2JVB4TE321229',
  'LMXA14AG7VZ357726',
  'LVAV2MAB2TU475726',
  'LVAV2AVBXTE322188',
  'LVAV2MAB6TU486230',
  'LVAV2MAB0TU490144',
  'LVAV2JVBXTE353649',
  'LVAV2MAB1TU486703',
  'LGJE5EE09TM429810',
  'LMXA14AF4VZ354807',
  'LGJE5EE09TM521404',
  'LVAV2JVB2TE321231',
  'LMXA14AG1VZ352943',
  'LMXA14AG7VZ352977',
  'LMXA14AF2VZ354806',
  'LMXA14AG5VZ352931',
  'LGJE1EE22TM554001',
  'LVAV2JVB9TE321906',
  'LVAV2MAB8TU480610',
  'LVAV2AVB4TE321408',
  'LMXA14AF0TZ350217',
  'LGJE5EE00TM529147',
  'LVAV2JVB8TE321413',
  'LVAV2MAB5TU484422',
];
const AUGUST_2026_OPERATIONAL_DATE = '2026-08-31 00:00:00';

const SEPTEMBER_2026_VIN_OVERRIDES = [
  'LGJE5EE06TM529038',
];
const SEPTEMBER_2026_OPERATIONAL_DATE = '2026-09-01 00:00:00';

const OPERATIONAL_DATE_OVERRIDES = [
  {
    label: 'August 2026',
    vins: AUGUST_2026_VIN_OVERRIDES,
    operationalDate: AUGUST_2026_OPERATIONAL_DATE,
  },
  {
    label: 'September 2026',
    vins: SEPTEMBER_2026_VIN_OVERRIDES,
    operationalDate: SEPTEMBER_2026_OPERATIONAL_DATE,
  },
];

const KEEP_COLUMNS = [
  'id', 'nro_operacion', 'razon_social', 'cliente', 'ciudad', 'region',
  'articulo', 'desc_articulo', 'nro_vin_chasis', 'nombre_usuario',
  'fecha_factura', 'precio_vta', 'precio_vta_pesos_con_iva',
  'id_sucursal_vta', 'desc_sucursal_vta', 'id_mae_marca', 'desc_mae_marca',
  'id_tipo_operacion', 'desc_tipo_oper', 'nro_propuesta', 'fecha_propuesta',
  'factura', 'nro_factura', 'fecha_eta', 'categoria_cliente', 'entidad_financiera',
  'comision_entidad_finan',
];

function normalizeExcelDate(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (/^\d{5}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) throw new Error(`Invalid Excel date serial: ${text}`);
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
  }
  return text;
}

function normalizeBrand(value) {
  const brand = String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  return brand === 'DFLM' ? 'DFM' : brand;
}

function normalizeCustomerCategory(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

async function applyOperationalDateOverride({ label, vins, operationalDate }) {
  const placeholders = vins.map((_, index) => '$' + (index + 2)).join(', ');
  const updated = await queryDb(
    'UPDATE ventas_raw SET fecha_factura = $1 WHERE upper(btrim(nro_vin_chasis)) IN (' + placeholders + ') RETURNING nro_vin_chasis',
    [operationalDate, ...vins],
  );
  if (updated.length !== vins.length) {
    const updatedVins = new Set(updated.map((row) => String(row.nro_vin_chasis ?? '').trim().toUpperCase()));
    const missingVins = vins.filter((vin) => !updatedVins.has(vin));
    console.warn(
      `${label} operational date override partial: expected ${vins.length}, updated ${updated.length}, missing: ${missingVins.join(', ')}`
    );
  }
  return updated.length;
}

async function applyOperationalDateOverrides() {
  let updatedTotal = 0;
  for (const override of OPERATIONAL_DATE_OVERRIDES) {
    updatedTotal += await applyOperationalDateOverride(override);
  }
  return updatedTotal;
}

export async function run() {
  const startedAt = Date.now();
  const file = await findDailyXlsx(FILE_PREFIX);
  const buffer = await downloadBlobObject(file.Key);
  const parsed = parseSheet(buffer, SHEET_NAME);
  const indexByColumn = new Map(parsed.columns.map((column, index) => [column, index]));
  const missing = KEEP_COLUMNS.filter((column) => !indexByColumn.has(column));
  if (missing.length) throw new Error(`Missing required sales columns: ${missing.join(', ')}`);

  const brandIndex = indexByColumn.get('desc_mae_marca');
  const categoryIndex = indexByColumn.get('categoria_cliente');
  const keepIndexes = KEEP_COLUMNS.map((column) => indexByColumn.get(column));
  const brandOutputIndex = KEEP_COLUMNS.indexOf('desc_mae_marca');
  const saleDateOutputIndex = KEEP_COLUMNS.indexOf('fecha_factura');

  // Build the final snapshot in one pass. The previous implementation created
  // brandFiltered + filtered + rows arrays over the same full XLS snapshot,
  // retaining multiple large intermediate arrays until the database write.
  const rows = [];
  let rowsExcludedByBrand = 0;
  let rowsExcludedByCustomerCategory = 0;
  for (const row of parsed.rows) {
    const brand = normalizeBrand(row[brandIndex]);
    if (!ALLOWED_BRANDS.has(brand)) {
      rowsExcludedByBrand += 1;
      continue;
    }
    if (!COMMERCIAL_CUSTOMER_CATEGORIES.has(normalizeCustomerCategory(row[categoryIndex]))) {
      rowsExcludedByCustomerCategory += 1;
      continue;
    }

    const output = keepIndexes.map((index) => row[index]);
    output[brandOutputIndex] = brand;
    output[saleDateOutputIndex] = normalizeExcelDate(output[saleDateOutputIndex]);
    rows.push(output);
  }

  const result = await replaceTableSnapshot(TABLE_NAME, KEEP_COLUMNS, rows);
  const operationalDateOverridesApplied = await applyOperationalDateOverrides();

  return {
    source: blobSource(file),
    sheet: SHEET_NAME,
    table: TABLE_NAME,
    strategy: 'FULL_SNAPSHOT_REPLACE',
    rowsLoaded: parsed.rows.length,
    rowsExcludedByBrand,
    rowsExcludedByCustomerCategory,
    rowsFinal: rows.length,
    columnsSource: parsed.columns.length,
    columnsFinal: KEEP_COLUMNS.length,
    allowedBrands: [...ALLOWED_BRANDS],
    allowedCustomerCategories: [...COMMERCIAL_CUSTOMER_CATEGORIES],
    operationalDateOverridesApplied,
    batchSize: result.batchSize,
    keptColumns: KEEP_COLUMNS,
    elapsedMs: Date.now() - startedAt,
  };
}
