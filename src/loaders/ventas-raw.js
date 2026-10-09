import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import ExcelJS from 'exceljs';

const { Client } = pg;

const FILE_PATH = process.env.AZURE_SALES_XLSX_PATH;
const DATABASE_URL = process.env.AZURE_DATABASE_URL;
const STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const AZURE_CONTAINER = process.env.AZURE_CONTAINER || 'cidef';
const AZURE_SALES_PREFIX = process.env.AZURE_SALES_PREFIX || 'ventas/Estadisticas_de_Venta_por_Vista_';
const SHEET_NAME = 'Ventas';
const TABLE_NAME = process.env.AZURE_SALES_TARGET_TABLE || 'ventas_raw_azure_validation';
if (TABLE_NAME !== 'ventas_raw_azure_validation') {
  throw new Error('Isolated loader only permits ventas_raw_azure_validation; production table is protected');
}

const ALLOWED_BRANDS = new Set(['DFLM', 'DFM', 'FOTON', 'ZNA', 'ZNA DONGFENG']);
const COMMERCIAL_CUSTOMER_CATEGORIES = new Set(['Cliente General', 'Concesionaria']);

const KEEP_COLUMNS = [
  'id', 'nro_operacion', 'razon_social', 'cliente', 'ciudad', 'region',
  'articulo', 'desc_articulo', 'nro_vin_chasis', 'nombre_usuario',
  'fecha_factura', 'precio_vta', 'precio_vta_pesos_con_iva',
  'id_sucursal_vta', 'desc_sucursal_vta', 'id_mae_marca', 'desc_mae_marca',
  'id_tipo_operacion', 'desc_tipo_oper', 'nro_propuesta', 'fecha_propuesta',
  'factura', 'nro_factura', 'fecha_eta', 'categoria_cliente', 'entidad_financiera',
  'comision_entidad_finan',
];

const OPERATIONAL_DATE_OVERRIDES = [
  {
    label: 'August 2026',
    operationalDate: '2026-08-31 00:00:00',
    vins: [
      'LVAV2MAB2TU485673','LGJE5EE01TM514771','LVAV2MAB9TU488506','LGJE5EE09TM529146',
      'LVAV2JVBXTE321994','LGJE5EE06TM521408','LVAV2JVB3TE322341','LVAV2JVB6TE322656',
      'LMXA14AG6VZ352968','LVAV2MAB9TU490143','LVAV2MAB3TU485424','LVAV2MAB8TU490148',
      'LGJE1EE24TM534185','LVAV2AVB3TE354755','LVAV2MAB7TU460042','LVAV2MAB9TU486237',
      'LVAV2AVB2TE222571','LVAV2AVB5TE355163','LVAV2AVB9TE322327','LMXA14AG6VZ352954',
      'LVAV2MAB8TU485435','LVAV2MAB2TU485429','LMXA14AG9VZ357825','LVAV2MAB3TU451953',
      'LGJE1EE22TM553981','LVAV2MAB1TU486734','LGJE1EE26TM554003','LVAV2JVB4TE321229',
      'LMXA14AG7VZ357726','LVAV2MAB2TU475726','LVAV2AVBXTE322188','LVAV2MAB6TU486230',
      'LVAV2MAB0TU490144','LVAV2JVBXTE353649','LVAV2MAB1TU486703','LGJE5EE09TM429810',
      'LMXA14AF4VZ354807','LGJE5EE09TM521404','LVAV2JVB2TE321231','LMXA14AG1VZ352943',
      'LMXA14AG7VZ352977','LMXA14AF2VZ354806','LMXA14AG5VZ352931','LGJE1EE22TM554001',
      'LVAV2JVB9TE321906','LVAV2MAB8TU480610','LVAV2AVB4TE321408','LMXA14AF0TZ350217',
      'LGJE5EE00TM529147','LVAV2JVB8TE321413','LVAV2MAB5TU484422',
    ],
  },
  {
    label: 'September 2026',
    operationalDate: '2026-09-01 00:00:00',
    vins: ['LGJE5EE06TM529038'],
  },
];

async function resolveSalesWorkbookPath() {
  if (FILE_PATH) return { filePath: FILE_PATH, sourceFile: FILE_PATH, cleanup: false };
  if (!STORAGE_CONNECTION_STRING) throw new Error('Missing AZURE_STORAGE_CONNECTION_STRING');

  const service = BlobServiceClient.fromConnectionString(STORAGE_CONNECTION_STRING);
  const container = service.getContainerClient(AZURE_CONTAINER);
  let latest = null;

  for await (const blob of container.listBlobsFlat({ prefix: AZURE_SALES_PREFIX })) {
    if (!blob.name.toLowerCase().endsWith('.xlsx')) continue;
    const modified = blob.properties.lastModified?.getTime() ?? 0;
    if (!latest || modified > latest.modified) latest = { name: blob.name, modified };
  }

  if (!latest) throw new Error(`No Azure SALES workbook found for prefix ${AZURE_SALES_PREFIX}`);
  const filePath = path.join(os.tmpdir(), `cidef-sales-${Date.now()}.xlsx`);
  const response = await container.getBlobClient(latest.name).download();
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    response.readableStreamBody.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    response.readableStreamBody.pipe(output);
  });
  return { filePath, sourceFile: `azure://${AZURE_CONTAINER}/${latest.name}`, cleanup: true };
}

function normalizeName(value, index) {
  const base = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || `col_${index + 1}`;
}

function uniqueColumns(headers) {
  const seen = new Map();
  return headers.map((header, index) => {
    const base = normalizeName(header, index);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function excelCellText(cell) {
  if (cell.value === null || cell.value === undefined || cell.value === '') return null;
  const text = cell.text;
  return text === '' ? null : String(text);
}

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

function quoteIdent(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

async function insertRows(client, tableName, columns, rows) {
  const maxParams = 8000;
  const batchSize = Math.max(1, Math.min(50, Math.floor(maxParams / columns.length)));
  const columnList = columns.map(quoteIdent).join(', ');

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    let param = 1;
    const tuples = batch.map((row) => '(' + row.map((value) => {
      values.push(value);
      return '$' + param++;
    }).join(', ') + ')');
    await client.query(
      `INSERT INTO ${quoteIdent(tableName)} (${columnList}) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
  return batchSize;
}

async function applyOperationalDateOverrides(client) {
  let total = 0;
  for (const override of OPERATIONAL_DATE_OVERRIDES) {
    const params = [override.operationalDate, ...override.vins];
    const placeholders = override.vins.map((_, i) => '$' + (i + 2)).join(', ');
    const result = await client.query(
      `UPDATE ${quoteIdent(TABLE_NAME)} SET fecha_factura = $1 WHERE upper(btrim(nro_vin_chasis)) IN (${placeholders}) RETURNING nro_vin_chasis`,
      params,
    );
    total += result.rowCount;
    if (result.rowCount !== override.vins.length) {
      const updated = new Set(result.rows.map((row) => String(row.nro_vin_chasis ?? '').trim().toUpperCase()));
      const missing = override.vins.filter((vin) => !updated.has(vin));
      console.warn(`${override.label} operational date override partial: expected ${override.vins.length}, updated ${result.rowCount}, missing: ${missing.join(', ')}`);
    }
  }
  return total;
}

async function main() {
  if (!DATABASE_URL) throw new Error('Missing AZURE_DATABASE_URL');

  const workbookFile = await resolveSalesWorkbookPath();
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const staging = `${TABLE_NAME}__azure_loading_${Date.now()}`;
  let stagingCreated = false;

  try {
    await client.connect();

    const columnSql = KEEP_COLUMNS.map((name) => `${quoteIdent(name)} TEXT`).join(', ');
    await client.query(`CREATE TABLE ${quoteIdent(staging)} (${columnSql})`);
    stagingCreated = true;

    const reader = new ExcelJS.stream.xlsx.WorkbookReader(workbookFile.filePath, {
      worksheets: 'emit',
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      entries: 'emit',
    });

    console.log(`[sales-loader] Source workbook: ${workbookFile.sourceFile}`);
    let foundSheet = false;
    const discoveredSheets = [];
    let columns = null;
    let indexByColumn = null;
    let brandIndex;
    let categoryIndex;
    let keepIndexes;
    let brandOutputIndex;
    let saleDateOutputIndex;
    let pending = [];
    let rowsLoaded = 0;
    let rowsFinal = 0;
    let rowsExcludedByBrand = 0;
    let rowsExcludedByCustomerCategory = 0;
    let batchSize = 0;

    for await (const worksheet of reader) {
      const sheetInfo = { id: worksheet.id ?? null, name: worksheet.name ?? null };
      discoveredSheets.push(sheetInfo);
      console.log('[sales-loader] Worksheet discovered:', JSON.stringify(sheetInfo));
      // Some XLSX producers use absolute worksheet relationship targets.
      // ExcelJS streaming may expose a generated name (e.g. Sheet1) instead
      // of the workbook's visible tab name. The source sales workbook has
      // exactly one worksheet; accept that sole worksheet by position.
      if (worksheet.name !== SHEET_NAME) {
        if (discoveredSheets.length !== 1 || String(worksheet.id) !== '1') continue;
        console.warn(`[sales-loader] Using first worksheet despite name mismatch: expected=${SHEET_NAME}, actual=${worksheet.name}`);
      }
      foundSheet = true;

      for await (const row of worksheet) {
        const values = [];
        for (let i = 1; i <= row.cellCount; i += 1) values.push(excelCellText(row.getCell(i)));

        if (!columns) {
          columns = uniqueColumns(values);
          indexByColumn = new Map(columns.map((column, index) => [column, index]));
          const missing = KEEP_COLUMNS.filter((column) => !indexByColumn.has(column));
          if (missing.length) throw new Error(`Missing required sales columns: ${missing.join(', ')}`);
          brandIndex = indexByColumn.get('desc_mae_marca');
          categoryIndex = indexByColumn.get('categoria_cliente');
          keepIndexes = KEEP_COLUMNS.map((column) => indexByColumn.get(column));
          brandOutputIndex = KEEP_COLUMNS.indexOf('desc_mae_marca');
          saleDateOutputIndex = KEEP_COLUMNS.indexOf('fecha_factura');
          continue;
        }

        if (!values.some((value) => value !== null && value !== '')) continue;
        rowsLoaded += 1;

        const brand = normalizeBrand(values[brandIndex]);
        if (!ALLOWED_BRANDS.has(brand)) {
          rowsExcludedByBrand += 1;
          continue;
        }
        if (!COMMERCIAL_CUSTOMER_CATEGORIES.has(normalizeCustomerCategory(values[categoryIndex]))) {
          rowsExcludedByCustomerCategory += 1;
          continue;
        }

        const output = keepIndexes.map((index) => values[index] ?? null);
        output[brandOutputIndex] = brand;
        output[saleDateOutputIndex] = normalizeExcelDate(output[saleDateOutputIndex]);
        pending.push(output);
        rowsFinal += 1;

        if (pending.length >= 500) {
          batchSize = await insertRows(client, staging, KEEP_COLUMNS, pending);
          pending = [];
        }
      }
      break;
    }

    if (!foundSheet) throw new Error(`Sheet not found: ${SHEET_NAME}; discovered: ${JSON.stringify(discoveredSheets)}`);
    if (!columns) throw new Error(`Sheet has no data: ${SHEET_NAME}`);
    if (pending.length) batchSize = await insertRows(client, staging, KEEP_COLUMNS, pending);

    await client.query('BEGIN');
    try {
      await client.query(`DROP TABLE IF EXISTS ${quoteIdent(TABLE_NAME)}`);
      await client.query(`ALTER TABLE ${quoteIdent(staging)} RENAME TO ${quoteIdent(TABLE_NAME)}`);
      await client.query('COMMIT');
      stagingCreated = false;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const operationalDateOverridesApplied = await applyOperationalDateOverrides(client);
    const audit = await client.query(`
      SELECT
        count(*)::int AS rows,
        count(DISTINCT upper(btrim(nro_vin_chasis)))::int AS distinct_vins,
        count(*) FILTER (WHERE categoria_cliente = 'Cliente General')::int AS cliente_general,
        count(*) FILTER (WHERE categoria_cliente = 'Concesionaria')::int AS concesionaria
      FROM ${quoteIdent(TABLE_NAME)}
    `);

    console.log(JSON.stringify({
      sourceFile: workbookFile.sourceFile,
      sheet: SHEET_NAME,
      table: TABLE_NAME,
      strategy: 'AZURE_STREAMING_SNAPSHOT_REPLACE',
      rowsLoaded,
      rowsExcludedByBrand,
      rowsExcludedByCustomerCategory,
      rowsFinal,
      operationalDateOverridesApplied,
      batchSize,
      audit: audit.rows[0],
    }, null, 2));
  } finally {
    if (stagingCreated) await client.query(`DROP TABLE IF EXISTS ${quoteIdent(staging)}`).catch(() => {});
    await client.end().catch(() => {});
    if (workbookFile.cleanup) await fsp.unlink(workbookFile.filePath).catch(() => {});
  }
}
await main();
