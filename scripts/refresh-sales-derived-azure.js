import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getAzurePool, closeAzurePool, azureCompatibleSql } from '../lib/azure-postgres.js';
import { refreshVehiculoCanonicoV01 } from '../lib/canonical/refresh-vehiculo-canonico-v01.js';
import { refreshDealerSellout } from '../lib/data-floor/refreshDealerSellout.js';
import { validDate } from '../src/loaders/sales/source-io.js';

const LOCK = 'cidef_ventas_raw_neon_azure_sync';
const INPUTS = ['vehiculos_raw', 'ventas_raw', 'notas_venta_raw',
  'producto_aliases_v01', 'dealers_master', 'dealer_aliases',
  'sucursales_master', 'sucursal_aliases'];
const emit = value => console.log(JSON.stringify(value));
const sql = (client, text, values = []) =>
  client.query(azureCompatibleSql(text), values).then(result => result.rows);

async function fingerprint(client, tables) {
  const parts = [];
  for (const table of tables) {
    // Full source content, not timestamps or row counts: changed values invalidate a stage.
    const [row] = await sql(client, `SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS digest
      FROM (SELECT md5(to_jsonb(t)::text) AS h FROM public.${table} t) s`);
    parts.push([table, row.digest]);
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function runStage(client, date, stage, signature, work) {
  const [previous] = await sql(client, `SELECT result FROM public.sales_derived_refresh_stages
    WHERE source_date=$1::date AND stage=$2 AND input_signature=$3 AND status='COMPLETED'`,
  [date, stage, signature]);
  if (previous) {
    emit({ date, stage, status: 'SKIPPED', reason: 'UNCHANGED_SIGNATURE', signature });
    return;
  }
  emit({ date, stage, status: 'RUNNING', signature });
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await sql(client, "SET LOCAL statement_timeout = '600s'");
    const result = await work();
    await sql(client, `INSERT INTO public.sales_derived_refresh_stages
      (source_date,stage,input_signature,status,result,completed_at)
      VALUES ($1::date,$2,$3,'COMPLETED',$4::jsonb,now())
      ON CONFLICT (source_date,stage,input_signature) DO UPDATE
      SET status='COMPLETED',result=excluded.result,completed_at=now()`,
    [date, stage, signature, JSON.stringify(result)]);
    await client.query('COMMIT');
    emit({ date, stage, status: 'COMPLETED', signature, elapsed_ms: Date.now()-started,
      result });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await sql(client, `INSERT INTO public.sales_derived_refresh_stages
      (source_date,stage,input_signature,status,result)
      VALUES ($1::date,$2,$3,'FAILED',$4::jsonb)
      ON CONFLICT (source_date,stage,input_signature) DO UPDATE
      SET status='FAILED',result=excluded.result`,
    [date, stage, signature, JSON.stringify({ code: error.code || error.name })]);
    emit({ date, stage, status: 'FAILED', code: error.code || error.name });
    throw error;
  }
}

export async function refreshDerived({ sourceDates, pool = getAzurePool() }) {
  if (!Array.isArray(sourceDates) || !sourceDates.length ||
      sourceDates.some(d => !validDate(d)) || new Set(sourceDates).size !== sourceDates.length) {
    throw new Error('Expected distinct YYYY-MM-DD source dates');
  }
  const ordered = [...sourceDates].sort();
  const cutoff = ordered.at(-1);
  const client = await pool.connect();
  let locked = false;
  try {
    const [lock] = await sql(client, 'SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK]);
    locked = lock.ok;
    if (!locked) throw new Error('Another SALES refresh is running');
    const { rows } = await client.query(`SELECT source_date::text AS date, source_signature
      FROM public.sales_raw_refresh_runs WHERE source_date = ANY($1::date[])
      ORDER BY source_date, completed_at DESC`, [ordered]);
    const latest = new Map();
    for (const row of rows) if (!latest.has(row.date)) latest.set(row.date, row.source_signature);
    if (ordered.some(d => !latest.has(d))) throw new Error('RAW source date missing from ledger');
    const [max] = await sql(client, 'SELECT max(source_date)::text AS date FROM public.sales_raw_refresh_runs');
    if (max.date !== cutoff) throw new Error('Only the latest loaded RAW date can produce current-state derivations');
    for (const date of ordered) emit({ date, status: 'SOURCE_INCLUDED',
      signature: latest.get(date), historical_snapshot: false });
    await sql(client, `CREATE TABLE IF NOT EXISTS public.sales_derived_refresh_stages (
      source_date date NOT NULL, stage text NOT NULL, input_signature text NOT NULL,
      status text NOT NULL, result jsonb NOT NULL DEFAULT '{}'::jsonb,
      completed_at timestamptz, PRIMARY KEY(source_date,stage,input_signature))`);
    // The canonical processor operates on the entire current RAW state; it cannot replay an old day.
    const canonicalSignature = await fingerprint(client, INPUTS);
    await runStage(client, cutoff, 'vehiculo_canonico', canonicalSignature, async () => {
      const execute = (text, values) => sql(client, text, values);
      const preview = await refreshVehiculoCanonicoV01({ dry_run: true, execute });
      if (Number(preview.before.canonical_extra_before) !== 0)
        throw new Error('Canonical refresh would remove VINs');
      const result = await refreshVehiculoCanonicoV01({ dry_run: false, execute });
      if (Number(result.base.rows_deleted) !== 0) throw new Error('Canonical deleted VINs');
      return { rows_upserted: result.base.rows_upserted, rows_deleted: result.base.rows_deleted };
    });
    const selloutSignature = await fingerprint(client, ['vehiculo_canonico']);
    await runStage(client, cutoff, 'dealer_monthly_sellout_snapshots', selloutSignature,
      () => refreshDealerSellout((text, values) => sql(client, text, values)));
    return { status: 'COMPLETED', source_dates: ordered, current_state_date: cutoff };
  } finally {
    try { if (locked) await sql(client, 'SELECT pg_advisory_unlock(hashtext($1))', [LOCK]); }
    finally { client.release(); }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { dates: { type: 'string' } } });
  if (!values.dates) throw new Error('Use --dates YYYY-MM-DD[,YYYY-MM-DD]');
  const url = process.env.AZURE_DATABASE_URL;
  if (!url || new URL(url).hostname !== 'cidef-postgres-prod.postgres.database.azure.com')
    throw new Error('Production Azure PostgreSQL connection required');
  try { return await refreshDerived({ sourceDates: values.dates.split(',') }); }
  finally { await closeAzurePool(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { emit({ status: 'FAILED', code: error.code || error.name }); process.exitCode = 1; });
