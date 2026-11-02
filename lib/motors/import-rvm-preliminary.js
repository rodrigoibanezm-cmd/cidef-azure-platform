import { rvmDb, closeRvmDb } from '../rvm-db.js';
import { listRvmWorkbooks, downloadRvmWorkbook } from '../../src/loaders/rvm/source-io.js';
import { openRvmWorkbook } from '../rvm-xlsx-stream.js';
import { KEEP } from '../rvm-cleaner.js';
import { parsePreliminaryRows } from '../rvm-preliminary.js';
import { syncVehiculosFromRvm } from '../rvm/sync-vehiculos-rvm.js';
import { refreshRvmMarketAggregates } from '../rvm/refreshAzureMarketAggregates.js';

const FINAL = 'public.rvm_raw';
const BATCH_SIZE = 250;

function db() {
  return rvmDb();
}

async function ensureSchema(sql) {
  await sql.query(`ALTER TABLE ${FINAL} ADD COLUMN IF NOT EXISTS data_status text`);
  await sql.query(`ALTER TABLE ${FINAL} ADD COLUMN IF NOT EXISTS snapshot_date date`);
  await sql.query(`UPDATE ${FINAL} SET data_status='CONSOLIDATED' WHERE data_status IS NULL`);
}

function sqlRows(rows, file, snapshotDate, ingestedAt) {
  return rows.map((row) => [
    ...KEEP.map((column) => row[column] ?? null),
    row.fecha,
    file.name,
    file.createdTime ?? file.modifiedTime ?? null,
    ingestedAt,
    row.source_row,
    'PRELIMINARY',
    snapshotDate,
  ]);
}

async function replaceSnapshot(sql, parsed, file, hooks = {}) {
  const beforeConsolidated = await sql.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(cantidad),0)::bigint AS quantity
     FROM ${FINAL} WHERE ano=$1 AND mes=$2 AND data_status='CONSOLIDATED'`,
    [parsed.year, parsed.month],
  );

  await sql.query('BEGIN');
  try {
    await sql.query(
      `DELETE FROM ${FINAL} WHERE ano=$1 AND mes=$2 AND data_status='PRELIMINARY'`,
      [parsed.year, parsed.month],
    );

    const cols = [...KEEP, 'fecha','documento_origen','fecha_creacion_documento','fecha_ingesta','source_row','data_status','snapshot_date'];
    const ingestedAt = new Date().toISOString();
    const data = sqlRows(parsed.rows, file, parsed.snapshot_date, ingestedAt);

    for (const row of data) {
      if (row.length !== cols.length) {
        throw new Error(`RVM preliminary insert arity mismatch: columns=${cols.length}, values=${row.length}`);
      }
    }

    for (let offset = 0; offset < data.length; offset += BATCH_SIZE) {
      const batch = data.slice(offset, offset + BATCH_SIZE);
      const values = [];
      let p = 1;
      const tuples = batch.map((row) => {
        const placeholders = cols.map((_, index) => {
          values.push(row[index] ?? null);
          return `$${p++}`;
        });
        return `(${placeholders.join(',')})`;
      });
      await sql.query(
        `INSERT INTO ${FINAL} (${cols.map((c) => `"${c}"`).join(',')})
         VALUES ${tuples.join(',')}`,
        values,
      );
      if (hooks.afterBatch) await hooks.afterBatch(offset / BATCH_SIZE, batch.length);
    }
    await sql.query('COMMIT');
  } catch (error) {
    await sql.query('ROLLBACK');
    throw error;
  }

  const [post] = await sql.query(
    `SELECT COUNT(*)::int AS rows_loaded,
            COALESCE(SUM(cantidad),0)::bigint AS quantity_total,
            MIN(fecha)::text AS min_date,
            MAX(fecha)::text AS max_date,
            COUNT(DISTINCT marca)::int AS brands_count,
            COUNT(DISTINCT descripcion_segmento)::int AS segments_count,
            COUNT(DISTINCT snapshot_date)::int AS snapshot_dates,
            MIN(snapshot_date)::text AS snapshot_date
     FROM ${FINAL}
     WHERE ano=$1 AND mes=$2 AND data_status='PRELIMINARY'`,
    [parsed.year, parsed.month],
  );
  const currentSnapshot = post;
  const [oldSnapshots] = await sql.query(
    `SELECT COUNT(*)::int AS count FROM ${FINAL}
     WHERE ano=$1 AND mes=$2 AND data_status='PRELIMINARY' AND snapshot_date<>$3::date`,
    [parsed.year, parsed.month, parsed.snapshot_date],
  );
  const [afterConsolidated] = await sql.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(cantidad),0)::bigint AS quantity
     FROM ${FINAL} WHERE ano=$1 AND mes=$2 AND data_status='CONSOLIDATED'`,
    [parsed.year, parsed.month],
  );

  const before = beforeConsolidated[0];
  if (Number(currentSnapshot.rows_loaded) !== parsed.rows.length) {
    throw new Error(`Post-load row count mismatch: expected ${parsed.rows.length}, got ${currentSnapshot.rows_loaded}`);
  }
  if (Number(post.snapshot_dates) !== 1 || post.snapshot_date !== parsed.snapshot_date) {
    throw new Error('Post-load snapshot_date is not uniform');
  }
  if (Number(oldSnapshots.count) !== 0) throw new Error('Previous PRELIMINARY snapshot rows remain');
  if (Number(before.count) !== Number(afterConsolidated.count) || String(before.quantity) !== String(afterConsolidated.quantity)) {
    throw new Error('CONSOLIDATED rows changed during preliminary load');
  }
  return post;
}

export async function run(input = {}) {
  const startedAt = Date.now();
  if (input.fileName) throw new Error('RVM preliminary fileName override is not supported');
  const file = (await listRvmWorkbooks()).find(item => /^data.*\.xlsx?$/i.test(item.name));
  if (!file) throw new Error('No preliminary RVM data*.xlsx in Azure Blob RVM/');
  const buffer = await downloadRvmWorkbook(file);
  const workbook = await openRvmWorkbook(buffer, { sheetName: 'Export' });
  const iterator = workbook.rows();
  const first = await iterator.next();
  if (first.done) throw new Error('RVM preliminary workbook has no rows');
  const remaining = [];
  for await (const row of iterator) remaining.push(row);
  const parsed = parsePreliminaryRows(remaining, first.value.values, file, input);

  const sql = db();
  try {
    await ensureSchema(sql);
    const post = await replaceSnapshot(sql, parsed, file);
    const vehicleSync = process.env.AZURE_DATABASE_URL
      ? (await sql.query(`SELECT to_regclass('public.vehiculos_raw') IS NOT NULL AS present`))[0].present
        ? await syncVehiculosFromRvm()
        : { status: 'skipped_table_missing', table: 'public.vehiculos_raw' }
      : await syncVehiculosFromRvm();
    const aggregates = process.env.AZURE_DATABASE_URL
      ? await refreshRvmMarketAggregates({
        year: parsed.year,
        month: parsed.month,
        dataStatus: 'PRELIMINARY',
        snapshotDate: parsed.snapshot_date,
      })
      : null;

    return {
    status: 'loaded',
    source_file: file.name,
    year: parsed.year,
    month: parsed.month,
    snapshot_date: parsed.snapshot_date,
    data_status: 'PRELIMINARY',
    rows_loaded: Number(process.env.AZURE_DATABASE_URL ? parsed.rows.length : post.rows_loaded),
    quantity_total: Number(process.env.AZURE_DATABASE_URL ? (await sql.query(
      `SELECT COALESCE(SUM(cantidad),0)::bigint AS total FROM ${FINAL}
       WHERE ano=$1 AND mes=$2 AND data_status='PRELIMINARY' AND snapshot_date=$3::date`,
      [parsed.year, parsed.month, parsed.snapshot_date],
    ))[0].total : post.quantity_total),
    aggregates,
    vehicle_sync: vehicleSync,
    min_date: post.min_date,
    max_date: post.max_date,
    brands_count: Number(post.brands_count),
    segments_count: Number(post.segments_count),
    warnings: [],
    elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    await closeRvmDb();
  }
}

export { replaceSnapshot };
