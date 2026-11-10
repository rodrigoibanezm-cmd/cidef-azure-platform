import { parseAnacRvmJson } from './anac-json.js';
import { KEEP, ensureFinalSchema } from '../rvm-cleaner.js';
import { rvmDb, withAzureTransaction, closeRvmDb } from '../rvm-db.js';
import { refreshRvmMarketAggregates } from './refreshAzureMarketAggregates.js';
import { syncVehiculosFromRvm } from './sync-vehiculos-rvm.js';

const BATCH_SIZE = 150;
const COLS = [...KEEP, 'fecha', 'documento_origen', 'fecha_creacion_documento',
  'fecha_ingesta', 'source_row', 'data_status', 'snapshot_date'];
const NUMERIC = new Set(['ano', 'mes', 'dia', 'ano_fabricacion', 'n_puertas',
  'n_asientos', 'carga', 'ano_vin', 'cantidad', 'source_row']);

function normalize(value, column) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  return NUMERIC.has(column) || column === 'fecha' || column === 'snapshot_date' ||
    column === 'fecha_creacion_documento' || column === 'fecha_ingesta' ||
    column === 'documento_origen'
    ? text : text.replace(/\s+/g, ' ').toUpperCase();
}

export async function importAnacRvm(bytes, { kind, year, month, blob }) {
  const parsed = parseAnacRvmJson(JSON.parse(bytes.toString('utf8')), {
    year, ...(kind === 'consolidated' ? { month } : {}),
  });
  if (kind === 'consolidated' && (parsed.year !== Number(year) ||
      parsed.month !== Number(month))) throw Error('ANAC consolidated period mismatch');
  if (!['preliminary', 'consolidated'].includes(kind)) throw Error('Invalid ANAC load kind');
  const status = kind === 'preliminary' ? 'PRELIMINARY' : 'CONSOLIDATED';
  const file = blob.split('/').at(-1);
  const ingestedAt = new Date().toISOString();
  const sql = rvmDb();
  try {
    await ensureFinalSchema();
    const loaded = await withAzureTransaction(async () => {
      await sql.query(`DELETE FROM public.rvm_raw
        WHERE ano=$1 AND mes=$2 AND data_status=$3`, [parsed.year, parsed.month, status]);
      for (let offset = 0; offset < parsed.rows.length; offset += BATCH_SIZE) {
        const batch = parsed.rows.slice(offset, offset + BATCH_SIZE);
        const values = [];
        const tuples = batch.map(row => {
          const source = { ...row, documento_origen: blob, fecha_creacion_documento: ingestedAt,
            fecha_ingesta: ingestedAt, data_status: status,
            snapshot_date: status === 'PRELIMINARY' ? parsed.snapshot_date : null };
          const cells = COLS.map(col => {
            values.push(normalize(source[col], col));
            return '$' + values.length;
          });
          return '(' + cells.join(',') + ')';
        });
        await sql.query(`INSERT INTO public.rvm_raw (${COLS.map(c => '"'+c+'"').join(',')})
          VALUES ${tuples.join(',')}`, values);
      }
      const [result] = await sql.query(`SELECT COUNT(*)::int AS rows, SUM(cantidad)::bigint AS units
        FROM public.rvm_raw WHERE ano=$1 AND mes=$2 AND data_status=$3`,
        [parsed.year, parsed.month, status]);
      if (Number(result.rows) !== parsed.rows.length) throw Error('ANAC loaded row count mismatch');
      return result;
    });
    const [table] = await sql.query("SELECT to_regclass('public.vehiculos_raw') IS NOT NULL AS present");
    const vehicles = table.present ? await syncVehiculosFromRvm() : { status: 'table_missing' };
    const aggregates = await refreshRvmMarketAggregates({
      year: parsed.year, month: parsed.month, dataStatus: status,
      ...(status === 'PRELIMINARY' ? { snapshotDate: parsed.snapshot_date } : {}),
    });
    return { event: 'RVM_LOADED', status: 'loaded', kind, year: parsed.year,
      month: parsed.month, snapshot_date: status === 'PRELIMINARY' ? parsed.snapshot_date : null,
      source_file: file, rows_loaded: Number(loaded.rows), quantity_total: Number(loaded.units),
      vehicle_sync: vehicles, aggregates };
  } finally {
    await closeRvmDb();
  }
}
