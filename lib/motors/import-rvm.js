import { listRvmWorkbooks, downloadRvmWorkbook } from '../../src/loaders/rvm/source-io.js';
import { openRvmWorkbook } from '../rvm-xlsx-stream.js';
import {
  KEEP, appendStage, clearDocumentRange, clearPreliminaryCoveredByDocument,
  documentLoaded, documentPeriod, ensureFinalSchema, normalizeAndAppend, resetStage,
} from '../rvm-cleaner.js';
import { rvmDb, closeRvmDb } from '../rvm-db.js';
import { refreshRvmMarketAggregates } from '../rvm/refreshAzureMarketAggregates.js';

const BATCH_SIZE = 250;
const REQUIRED = ['mercado', ...KEEP];

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function headerMap(values) {
  const map = new Map(values.map((v, i) => [normalizeName(v), i]));
  const missing = REQUIRED.filter(c => !map.has(c));
  if (missing.length) throw new Error(`RVM missing columns: ${missing.join(', ')}`);
  return map;
}

async function stageFile(file, rowFrom, rowTo) {
  const buffer = await downloadRvmWorkbook(file);
  const workbook = await openRvmWorkbook(buffer);
  let map;
  let queue = [];
  let extracted = 0;

  await resetStage();
  for await (const row of workbook.rows()) {
    if (!map) { map = headerMap(row.values); continue; }
    if (row.number < rowFrom) continue;
    if (row.number > rowTo) break;

    const values = REQUIRED.map(c => row.values[map.get(c)] ?? null);
    if (values.every(v => v == null || v === '')) continue;
    queue.push([values[0], row.number, ...values.slice(1)]);
    if (queue.length >= BATCH_SIZE) {
      await appendStage(queue);
      extracted += queue.length;
      queue = [];
    }
  }
  if (queue.length) { await appendStage(queue); extracted += queue.length; }
  return extracted;
}

export async function run(input = {}) {
  const startedAt = Date.now();
  await ensureFinalSchema();
  try {

  const expectedYear = input.year == null ? null : Number(input.year);
  const expectedMonth = input.month == null ? null : Number(input.month);
  if (expectedYear != null && (!Number.isInteger(expectedYear) || expectedYear < 2000 || expectedYear > 2100)) {
    throw new Error(`Invalid RVM consolidated year: ${input.year}`);
  }
  if (expectedMonth != null && (!Number.isInteger(expectedMonth) || expectedMonth < 1 || expectedMonth > 12)) {
    throw new Error(`Invalid RVM consolidated month: ${input.month}`);
  }

  const chunked = input.rowFrom != null || input.rowTo != null;
  const rowFrom = Math.max(2, Number(input.rowFrom ?? 2));
  const rowTo = Math.max(rowFrom, Number(input.rowTo ?? Number.MAX_SAFE_INTEGER));

  const availableFiles = (await listRvmWorkbooks())
    .filter((file) => /\.xlsx?$/i.test(file.name ?? ''));
  let files = availableFiles
    .filter((file) => !process.env.AZURE_DATABASE_URL || input.fileName
      || !/^data.*\.xls[xmb]?$/i.test(file.name ?? ''))
    .sort((a, b) => new Date(b.modifiedTime ?? 0) - new Date(a.modifiedTime ?? 0));

  if (input.fileName) files = files.filter((file) => file.name === input.fileName);
  else files = files.slice(0, 1);

  if (!files.length) {
    throw new Error(`No RVM consolidated .xlsx file found in Azure Blob under RVM/; available workbooks: ${availableFiles.map((file) => file.name).join(', ') || '(none)'}`);
  }

  const results = [];

  for (const file of files) {
    if (!chunked && await documentLoaded(file.name)) {
      const periods = await documentPeriod(file.name);
      if (periods.length !== 1) {
        throw new Error(`RVM consolidated document period must be unique; found ${periods.map((p) => `${p.year}-${p.month}`).join(', ')}`);
      }
      const period = periods[0];
      if (expectedYear != null && Number(period.year) !== expectedYear) {
        throw new Error(`RVM consolidated year mismatch: expected ${expectedYear}, loaded document contains ${period.year}`);
      }
      if (expectedMonth != null && Number(period.month) !== expectedMonth) {
        throw new Error(`RVM consolidated month mismatch: expected ${expectedMonth}, loaded document contains ${period.month}`);
      }
      const aggregates = process.env.AZURE_DATABASE_URL
        ? await refreshRvmMarketAggregates({ year: period.year, month: period.month, dataStatus: 'CONSOLIDATED' })
        : null;
      results.push({ file: file.name, status: 'already_loaded', year: Number(period.year), month: Number(period.month), aggregates });
      continue;
    }

    if (chunked) await clearDocumentRange(file.name, rowFrom, rowTo);
    const staged = await stageFile(file, rowFrom, rowTo);

    let period = null;
    if (!chunked) {
      const sql = rvmDb();
      const periods = await sql.query(
        `SELECT DISTINCT NULLIF(trim(ano),'')::int AS year, NULLIF(trim(mes),'')::int AS month
         FROM rvm_stage_raw
         WHERE trim(mercado)='Livianos y Medianos'
         ORDER BY year, month`,
      );
      if (periods.length !== 1) {
        throw new Error(`RVM consolidated file must contain exactly one period; found ${periods.map((p) => `${p.year}-${p.month}`).join(', ')}`);
      }
      period = periods[0];
      if (expectedYear != null && Number(period.year) !== expectedYear) {
        throw new Error(`RVM consolidated year mismatch: expected ${expectedYear}, file contains ${period.year}`);
      }
      if (expectedMonth != null && Number(period.month) !== expectedMonth) {
        throw new Error(`RVM consolidated month mismatch: expected ${expectedMonth}, file contains ${period.month}`);
      }
    }

    const appended = await normalizeAndAppend(
      file,
      process.env.AZURE_DATABASE_URL && period ? { year: Number(period.year), month: Number(period.month) } : null,
    );
    const preliminaryRemoved = chunked || process.env.AZURE_DATABASE_URL
      ? 0
      : await clearPreliminaryCoveredByDocument(file.name);
    const aggregates = !chunked && process.env.AZURE_DATABASE_URL
      ? await refreshRvmMarketAggregates({
        year: Number(period.year),
        month: Number(period.month),
        dataStatus: 'CONSOLIDATED',
      })
      : null;
    results.push({
      file: file.name,
      status: chunked ? 'chunk_loaded' : 'loaded',
      year: period ? Number(period.year) : undefined,
      month: period ? Number(period.month) : undefined,
      rowFrom: chunked ? rowFrom : undefined,
      rowTo: chunked ? rowTo : undefined,
      staged,
      appended,
      preliminaryRemoved,
      aggregates,
    });
  }

  return {
    table: 'rvm_raw',
    files: results,
    elapsedMs: Date.now() - startedAt,
  };
  } finally {
    await closeRvmDb();
  }
}
