// Compare canonical strategies on an isolated PostgreSQL copy. Never commits.
import pg from 'pg';
import { performance } from 'node:perf_hooks';
import { azureCompatibleSql } from '../lib/azure-postgres.js';
import { refreshVehiculoCanonicoV01 } from '../lib/canonical/refresh-vehiculo-canonico-v01.js';

const url = new URL(process.env.SALES_PARITY_DATABASE_URL || 'invalid:');
const database = decodeURIComponent(url.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^sales_parity_[a-z0-9_]+$/.test(database))
  throw new Error('Use a local isolated database named sales_parity_*');
process.env.AZURE_DATABASE_URL = url.href;
const client = new pg.Client({ connectionString: url.href });
const execute = async (sql, values = []) =>
  (await client.query(azureCompatibleSql(sql), values)).rows;
const snapshot = () => execute(`
  SELECT vin, md5((to_jsonb(c) - 'vehiculo_id' - 'canonicalized_at')::text) AS digest
  FROM public.vehiculo_canonico c ORDER BY vin
`);

async function run(affectedVins) {
  await client.query('SAVEPOINT parity_case');
  try {
    const start = performance.now();
    const result = await refreshVehiculoCanonicoV01({ execute, affectedVins });
    const elapsed_ms = Math.round(performance.now() - start);
    return { elapsed_ms, result, rows: await snapshot() };
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT parity_case');
    await client.query('RELEASE SAVEPOINT parity_case');
  }
}

await client.connect();
try {
  const [identity] = await execute('SELECT current_database() AS name');
  if (identity.name !== database) throw new Error('Unexpected database');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await client.query("SET LOCAL statement_timeout = '600s'");
  const [baseline] = await execute(`
    SELECT completed_at, result FROM public.sales_derived_refresh_stages
    WHERE stage='vehiculo_canonico' AND status='COMPLETED'
    ORDER BY completed_at DESC LIMIT 1
  `);
  if (!baseline) throw new Error('Missing canonical baseline');
  const runs = await execute(`
    SELECT result FROM public.sales_raw_refresh_runs
    WHERE completed_at > $1::timestamptz ORDER BY completed_at, run_id
  `, [baseline.completed_at]);
  if (!runs.length) throw new Error('Copy must contain RAW updates after canonical baseline');
  const vins = new Set();
  let signature = baseline.result?.raw_state_signature;
  for (const { result } of runs) {
    const d = result?.rawDelta;
    if (!signature || d?.requiresFull !== false || d.rawBeforeSignature !== signature ||
        !d.rawStateSignature || !Array.isArray(d.changedVins))
      throw new Error('No certified incremental RAW chain in copy');
    for (const vin of d.changedVins) vins.add(vin);
    signature = d.rawStateSignature;
  }
  if (!vins.size) throw new Error('No changed VINs to benchmark');
  const { RAW_STATE_SIGNATURE_SQL } = await import('../src/loaders/sales/refresh.js');
  const [current] = await execute(RAW_STATE_SIGNATURE_SQL);
  if (current.signature !== signature) throw new Error('RAW state differs from ledger');
  const scope = [...vins].sort();
  const incremental = await run(scope);
  const full = await run(null);
  const a = new Map(incremental.rows.map(r => [r.vin, r.digest]));
  const b = new Map(full.rows.map(r => [r.vin, r.digest]));
  const differences = [...new Set([...a.keys(), ...b.keys()])]
    .filter(vin => a.get(vin) !== b.get(vin));
  console.log(JSON.stringify({
    status: differences.length ? 'FAIL' : 'PASS',
    scope: 'canonical_only', changed_vins: scope.length,
    full_rows: b.size, incremental_rows: a.size,
    differences: differences.length,
    full_ms: full.elapsed_ms, incremental_ms: incremental.elapsed_ms,
    full_upserted: full.result.base.rows_upserted,
    incremental_upserted: incremental.result.base.rows_upserted,
    ignored_fields: ['vehiculo_id', 'canonicalized_at']
  }, null, 2));
  if (differences.length) process.exitCode = 1;
} finally {
  await client.query('ROLLBACK').finally(() => client.end());
}
