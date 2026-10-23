// Adapted from cidef-data-loader; only Azure I/O changes.
import XLSX from 'xlsx';
import { findDailyXlsx, downloadBlobObject, blobSource } from './source-io.js';
import { appendTableData, queryDb } from './db.js';

const DEFAULT_FILE_PREFIX = 'ventas/NC_DFM_';
const SHEET_NAME = 'Datos';
const TABLE_NAME = 'notas_credito_raw';

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

export function snapshotDateFromKey(key) {
  const match = String(key ?? '').match(/(\d{4})_(\d{2})_(\d{2})\.xlsx$/i);
  if (!match) throw new Error(`Credit-note snapshot date not found in source key: ${key}`);
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function parseCreditNoteSnapshot(buffer, sheetName = SHEET_NAME) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: false,
  });

  const headerIndex = matrix.findIndex((row) => {
    const names = new Set(row.map((value, index) => normalizeName(value, index)));
    return names.has('tipo') && names.has('numero') && names.has('fecha') && names.has('nfactura');
  });
  if (headerIndex < 0) throw new Error('Credit-note header row not found');

  const width = matrix.slice(headerIndex).reduce((max, row) => Math.max(max, row.length), 0);
  const header = Array.from({ length: width }, (_, index) => matrix[headerIndex]?.[index] ?? null);
  const columns = uniqueColumns(header);
  const rows = matrix.slice(headerIndex + 1)
    .filter((row) => row.some((value) => value !== null && value !== ''))
    .map((row) => columns.map((_, index) => {
      const value = row[index];
      return value === null || value === undefined || value === '' ? null : String(value);
    }));

  const required = ['tipo', 'numero', 'fecha', 'nfactura'];
  const missing = required.filter((column) => !columns.includes(column));
  if (missing.length) throw new Error(`Missing required credit-note columns: ${missing.join(', ')}`);

  return {
    columns,
    rows,
    headerRow: headerIndex + 1,
  };
}

export async function run() {
  const startedAt = Date.now();
  const filePrefix = DEFAULT_FILE_PREFIX;
  const file = await findDailyXlsx(filePrefix);
  const buffer = await downloadBlobObject(file.Key);
  const parsed = parseCreditNoteSnapshot(buffer);
  const snapshotDate = snapshotDateFromKey(file.Key);
  const sourceModifiedTime = file.LastModified?.toISOString?.() ?? String(file.LastModified ?? '');
  const sourceEtag = String(file.ETag ?? '').replace(/^"|"$/g, '');

  const metadataColumns = [
    'snapshot_date',
    'source_key',
    'source_modified_time',
    'source_etag',
    'source_row_number',
  ];
  const columns = [...metadataColumns, ...parsed.columns];

  // Initialize/validate the raw table schema without inserting data.
  await appendTableData(TABLE_NAME, columns, []);

  if (sourceEtag) {
    const existing = await queryDb(
      `SELECT count(*)::int AS rows FROM ${TABLE_NAME} WHERE source_key = $1 AND source_etag = $2`,
      [file.Key, sourceEtag],
    );
    if (Number(existing[0]?.rows ?? 0) > 0) {
      return {
        source: blobSource(file),
        sheet: SHEET_NAME,
        table: TABLE_NAME,
        strategy: 'APPEND_ONLY_SNAPSHOT',
        status: 'ALREADY_LOADED',
        snapshotDate,
        rowsFinal: Number(existing[0].rows),
        columnsFinal: columns.length,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  const rows = parsed.rows.map((row, index) => [
    snapshotDate,
    file.Key,
    sourceModifiedTime || null,
    sourceEtag || null,
    String(parsed.headerRow + index + 1),
    ...row,
  ]);

  const result = await appendTableData(TABLE_NAME, columns, rows);

  return {
    source: blobSource(file),
    sheet: SHEET_NAME,
    table: TABLE_NAME,
    strategy: 'APPEND_ONLY_SNAPSHOT',
    status: 'LOADED',
    snapshotDate,
    headerRow: parsed.headerRow,
    rowsFinal: rows.length,
    columnsSource: parsed.columns.length,
    columnsFinal: columns.length,
    sourceEtag: sourceEtag || null,
    batchSize: result.batchSize,
    elapsedMs: Date.now() - startedAt,
  };
}
