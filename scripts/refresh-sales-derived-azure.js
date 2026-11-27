import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { getAzurePool, closeAzurePool, azureCompatibleSql } from '../lib/azure-postgres.js';
import { refreshVehiculoCanonicoV01 } from '../lib/canonical/refresh-vehiculo-canonico-v01.js';
import { refreshDealerSellout } from '../lib/data-floor/refreshDealerSellout.js';
import { validDate } from '../src/loaders/sales/source-io.js';
import { syncVehiculosFromRvm } from '../src/loaders/sales/sync-vehiculos-rvm.js';
import { publishCurrentDealerSellin, RAW_STATE_SIGNATURE_SQL } from '../src/loaders/sales/refresh.js';
import { engineSignature } from '../lib/forum-snapshot/incremental.js';

const LOCK = 'cidef_ventas_raw_neon_azure_sync';
const INPUTS = ['vehiculos_raw', 'ventas_raw', 'notas_venta_raw',
  'producto_aliases_v01', 'dealers_master', 'dealer_groups', 'dealer_aliases',
  'sucursales_master', 'sucursal_aliases'];
const emit = value => console.log(JSON.stringify(value));
const FORUM_INPUTS = ['forum_funnel_raw', 'ventas_raw', 'vehiculos_raw',
  'sucursales_master','dealers_master','dealer_groups','dealer_aliases',
  'sucursal_aliases','producto_aliases_v01','marcas_master_v01','modelos_master_v01',
  'versiones_master_v01','personas_master','persona_aliases','persona_roles','persona_sucursal'];
async function publishForumSnapshot() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/refresh-forum-ventas-snapshot-azure.js', '--publish-sales'], {
      stdio: 'inherit', env: { ...process.env, FORUM_SNAPSHOT_PUBLISHER: 'azure-platform' },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() :
      reject(new Error('FORUM_SNAPSHOT_NOT_PUBLISHED: ' + (signal || code))));
  });
  return { published: true };
}
const sql = (client, text, values = []) =>
  client.query(azureCompatibleSql(text), values).then(result => result.rows);

async function fingerprint(client, tables) {
  const parts = [];
  for (const table of tables) {
    // Full source content, not timestamps or row counts: changed values invalidate a stage.
    emit({ stage: 'fingerprint', table, status: 'RUNNING' });
    const started = Date.now();
    // Fingerprint the massive RVM source from PostgreSQL mutation metadata,
    // not a full scan/hash of millions of rows (previously timed out at 120s).
    // Physical relfilenode identifies rewrites; mutation counters detect inserts,
    // updates, deletes and truncation between executions.
    const query = table === 'rvm_raw'
      ? `SELECT c.relfilenode::text AS storage_id,
          s.n_tup_ins::text AS inserted, s.n_tup_upd::text AS updated,
          s.n_tup_del::text AS deleted, s.n_tup_hot_upd::text AS hot_updated,
          s.n_live_tup::text AS live_estimate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
         WHERE n.nspname = 'public' AND c.relname = 'rvm_raw'`
      : `SELECT md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS digest
         FROM (SELECT md5(to_jsonb(t)::text) AS h FROM public.${table} t) s`;
    const [row] = await sql(client, query);
    if (table === 'rvm_raw' && !row) throw new Error('RVM source metadata unavailable');
    parts.push([table, row]);
    emit({ stage: 'fingerprint', table, status: 'COMPLETED', elapsed_ms: Date.now() - started });
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function runStage(client, date, stage, signature, work) {
  const [previous] = await sql(client, `SELECT result FROM public.sales_derived_refresh_stages
    WHERE source_date=$1::date AND stage=$2 AND input_signature=$3 AND status='COMPLETED'`,
  [date, stage, signature]);
  if (previous) {
    emit({ date, stage, status: 'SKIPPED', reason: 'UNCHANGED_SIGNATURE', signature });
    return { skipped: true, result: previous.result };
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
    return { skipped: false, result };
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

// Only a complete, continuous and unchanged RAW fingerprint chain is safe to scope.
export async function planCanonicalScope(client, { masterSignature, codeSignature,
    currentRawSignature, rvmStage }) {
  const full = reason => ({ affectedVins: null, reason });
  if (!rvmStage?.skipped && Number(rvmStage?.result?.rows_updated || 0) !== 0)
    return full('RVM_UPDATED');
  const [baseline] = await sql(client, `SELECT completed_at, result
    FROM public.sales_derived_refresh_stages
    WHERE stage='vehiculo_canonico' AND status='COMPLETED'
    ORDER BY completed_at DESC LIMIT 1`);
  if (!baseline?.result?.raw_state_signature ||
      baseline.result.master_signature !== masterSignature ||
      baseline.result.code_signature !== codeSignature)
    return full('NO_COMPATIBLE_BASELINE');
  const runs = await sql(client, `SELECT result FROM public.sales_raw_refresh_runs
    WHERE completed_at > $1::timestamptz ORDER BY completed_at, run_id`,
    [baseline.completed_at]);
  if (!runs.length) return full('NO_NEW_RAW_CHANGE_SET');
  let previousHash = baseline.result.raw_state_signature;
  const changed = new Set();
  for (const { result } of runs) {
    const delta = result?.rawDelta;
    if (!delta || delta.requiresFull !== false || !Array.isArray(delta.changedVins) ||
        !delta.rawBeforeSignature || !delta.rawStateSignature ||
        delta.rawBeforeSignature !== previousHash)
      return full('RAW_CHAIN_NOT_CERTIFIED');
    for (const vin of delta.changedVins) {
      if (typeof vin !== 'string' || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))
        return full('INVALID_CHANGED_VIN');
      changed.add(vin);
    }
    previousHash = delta.rawStateSignature;
  }
  if (previousHash !== currentRawSignature) return full('RAW_CHANGED_OUTSIDE_LEDGER');
  return { affectedVins: [...changed].sort(), reason: 'VERIFIED_RAW_DELTA' };
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
    // RAW-only SALES explicitly skips RVM; synchronize lifecycle before canonical.
    // Change-only updates avoid invalidating downstream stages on an unchanged retry.
    const incrementalEnabled = process.env.SALES_CANONICAL_INCREMENTAL_ENABLED === 'true';
    const rawBeforeRvm = incrementalEnabled
      ? (await sql(client, RAW_STATE_SIGNATURE_SQL))[0]?.signature : null;
    const rvmSignature = await fingerprint(client, ['rvm_raw', 'vehiculos_raw']);
    const rvmStage = await runStage(client, cutoff, 'vehiculos_raw_rvm_sync', rvmSignature, async () => {
      const synced = await syncVehiculosFromRvm((text, values) => sql(client, text, values),
        { onlyChanged: true });
      const [dates] = await sql(client, `SELECT
        (SELECT max(fecha)::text FROM public.rvm_raw) AS latest_rvm_registration,
        (SELECT max(fecha_ingesta)::text FROM public.rvm_raw) AS latest_rvm_ingestion,
        (SELECT max(fecha_actualizacion_rvm)::text FROM public.vehiculos_raw)
          AS latest_vehicle_rvm_sync`);
      return { ...synced, ...dates };
    });
    // Current-state canonical may use a verified VIN scope; legacy/full remains the safe fallback.
    // A change in current SALES recognition must invalidate the canonical stage
    // even when all daily XLS inputs are byte-identical.
    const canonicalCodeSignature = createHash('sha256');
    for (const path of [
      '../lib/ventas/loadVentasRows.js',
      '../lib/canonical/vehiculo-salida-v01.js',
      '../lib/canonical/refresh-vehiculo-canonico-v01.js',
      '../lib/ventas/resolveVentasRecognition.js',
      '../lib/ventas/ventasContextUtils.js',
      '../lib/ventas/parseFechaFactura.js',
    ]) canonicalCodeSignature.update(readFileSync(new URL(path, import.meta.url)));
    const codeSignature = canonicalCodeSignature.digest('hex');
    const canonicalSignature = createHash('sha256')
      .update(await fingerprint(client, INPUTS))
      .update(codeSignature).digest('hex');
    let scope = { affectedVins: null, reason: 'INCREMENTAL_DISABLED' };
    let masterSignature = null;
    let rawAfterRvm = null;
    if (incrementalEnabled) {
      masterSignature = await fingerprint(client, [
        'producto_aliases_v01','dealers_master','dealer_aliases',
        'sucursales_master','sucursal_aliases','dealer_groups',
      ]);
      const rvmChanged = !rvmStage.skipped && Number(rvmStage.result?.rows_updated || 0) !== 0;
      rawAfterRvm = rvmChanged
        ? (await sql(client, RAW_STATE_SIGNATURE_SQL))[0]?.signature
        : rawBeforeRvm;
      if (!rawBeforeRvm || !rawAfterRvm) throw new Error('RAW_STATE_SIGNATURE_MISSING');
      scope = await planCanonicalScope(client, {
        masterSignature, codeSignature, currentRawSignature: rawBeforeRvm, rvmStage,
      });
    }
    emit({ date: cutoff, stage: 'canonical_scope', reason: scope.reason,
      affected_vin_count: scope.affectedVins?.length ?? null });
    await runStage(client, cutoff, 'vehiculo_canonico', canonicalSignature, async () => {
      const execute = (text, values) => sql(client, text, values);
      const affectedVins = scope.affectedVins;
      const preview = await refreshVehiculoCanonicoV01({ dry_run: true, execute, affectedVins });
      if (Number(preview.before.canonical_extra_before) !== 0)
        throw new Error('Canonical refresh would remove VINs');
      const result = await refreshVehiculoCanonicoV01({ dry_run: false, execute, affectedVins });
      if (Number(result.base.rows_deleted) !== 0) throw new Error('Canonical deleted VINs');
      return { rows_upserted: result.base.rows_upserted, rows_deleted: result.base.rows_deleted,
        strategy: result.strategy, affected_vin_count: affectedVins?.length ?? null,
        scope_reason: scope.reason, code_signature: codeSignature,
        master_signature: masterSignature, raw_state_signature: rawAfterRvm };
    });
    const selloutSignature = await fingerprint(client, ['vehiculo_canonico']);
    await runStage(client, cutoff, 'dealer_monthly_sellout_snapshots', selloutSignature,
      () => refreshDealerSellout((text, values) => sql(client, text, values)));
    const month = cutoff.slice(0, 7);
    const sellinSignature = await fingerprint(client, ['ventas_raw','vehiculo_canonico',
      'dealers_master','dealer_groups','producto_aliases_v01']);
    await runStage(client, cutoff, 'dealer_monthly_model_sellin_snapshots', sellinSignature,
      () => publishCurrentDealerSellin(month, cutoff, pool, client));
    // The existing publisher already performs certified P1 reconciliation, per-bundle
    // signatures, selective rebuild and atomic publication. Never duplicate its formulas.
    const optionalFinance = (await sql(client, `SELECT to_regclass('public.finanzas_ventas') AS t`))[0].t
      ? ['finanzas_ventas','finanzas_cierre_archivos'] : [];
    const forumDataSignature = await fingerprint(client, [...FORUM_INPUTS, 'vehiculo_canonico',
      'dealer_monthly_model_sellin_snapshots', ...optionalFinance]);
    const forumSignature = createHash('sha256').update(forumDataSignature +
      await engineSignature()).digest('hex');
    await runStage(client, cutoff, 'forum_ventas_snapshot_v01', forumSignature,
      () => publishForumSnapshot());
    return { status: 'COMPLETED', source_dates: ordered, current_state_date: cutoff,
      stages: ['vehiculos_raw_rvm_sync','vehiculo_canonico','dealer_monthly_sellout_snapshots',
        'dealer_monthly_model_sellin_snapshots','forum_ventas_snapshot_v01'] };
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
