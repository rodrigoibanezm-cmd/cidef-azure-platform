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
    const queries = [];
    const timedExecute = async (sql, values = []) => {
      const started = performance.now();
      const rows = await execute(sql, values);
      // Log only static SQL identifiers, never parameters or data.
      const normalized = sql.trim().replace(/\s+/g, ' ');
      const operation = normalized.match(/^(?:WITH\s+(?:RECURSIVE\s+)?[\w]+|SELECT|ALTER TABLE\s+[\w.]+|UPDATE\s+[\w.]+|INSERT INTO\s+[\w.]+)/i)?.[0] || 'OTHER';
      const tables = [...new Set([...normalized.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?([a-z_][a-z_0-9]*)\b/gi)].map(m => m[1]))].slice(0, 12);
      queries.push({ sequence: queries.length + 1, operation, tables,
        elapsed_ms: Math.round(performance.now() - started) });
      return rows;
    };
    const result = await refreshVehiculoCanonicoV01({ execute: timedExecute, affectedVins });
    const elapsed_ms = Math.round(performance.now() - start);
    const sql_ms = queries.reduce((sum, q) => sum + q.elapsed_ms, 0);
    console.log(JSON.stringify({ profile: affectedVins === null ? 'full' : 'incremental',
      elapsed_ms, sql_ms, non_sql_ms: Math.max(0, elapsed_ms - sql_ms),
      queries: queries.sort((a, b) => b.elapsed_ms - a.elapsed_ms) }, null, 2));
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
  // Establish the same complete baseline on the isolated real-data copy.
  // Controlled changes are NOT a replay of a historical production refresh.
  await refreshVehiculoCanonicoV01({ execute, affectedVins: null });
  const baseline = new Map((await snapshot()).map(r => [r.vin, r.digest]));
  const { RAW_VIN_SIGNATURE_SQL, captureRawVinDelta } =
    await import('../src/loaders/sales/refresh.js');
  await client.query('CREATE TEMP TABLE sales_raw_vin_before ON COMMIT DROP AS ' +
    RAW_VIN_SIGNATURE_SQL);
  const sampleSize = Number(process.env.SALES_PARITY_SAMPLE_SIZE || '100');
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 2 || sampleSize > 10000)
    throw new Error('Invalid sample size');
  // Use existing VINs and observed data. Exercise both stock and sale recognition.
  const stock = await execute(`
    WITH candidates AS (
      SELECT v.vin, r.color
      FROM public.vehiculo_canonico v JOIN public.vehiculos_raw r
        ON upper(btrim(r.vin_chasis)) = v.vin
      WHERE NOT v.vendido AND nullif(btrim(r.color), '') IS NOT NULL
      ORDER BY v.vin LIMIT $1
    )
    UPDATE public.vehiculos_raw r
      SET color = (SELECT other.color FROM public.vehiculos_raw other
                   WHERE nullif(btrim(other.color),'') IS NOT NULL
                     AND other.color IS DISTINCT FROM r.color
                   ORDER BY other.color LIMIT 1)
    FROM candidates c
    WHERE upper(btrim(r.vin_chasis)) = c.vin
    RETURNING c.vin
  `, [Math.floor(sampleSize / 2)]);
  const sales = await execute(`
    WITH candidates AS (
      SELECT v.vin FROM public.vehiculo_canonico v
      WHERE v.vendido AND EXISTS (SELECT 1 FROM public.ventas_raw r
        WHERE upper(btrim(r.nro_vin_chasis)) = v.vin)
      ORDER BY v.vin LIMIT $1
    )
    DELETE FROM public.ventas_raw r USING candidates c
      WHERE upper(btrim(r.nro_vin_chasis)) = c.vin
    RETURNING c.vin
  `, [Math.ceil(sampleSize / 2)]);
  if (!stock.length || !sales.length) throw new Error('Missing representative stock or sales rows');
  const delta = await captureRawVinDelta(execute);
  if (delta.requiresFull || !delta.changedVins.length)
    throw new Error('Controlled changes did not produce a valid VIN delta');
  const scope = delta.changedVins.sort();
  const incremental = await run(scope);
  const full = await run(null);
  const a = new Map(incremental.rows.map(r => [r.vin, r.digest]));
  const b = new Map(full.rows.map(r => [r.vin, r.digest]));
  const differences = [...new Set([...a.keys(), ...b.keys()])]
    .filter(vin => a.get(vin) !== b.get(vin));
  const changedResults = full.rows.filter(r => baseline.get(r.vin) !== r.digest).length;
  if (!changedResults) throw new Error('Controlled changes did not affect canonical results');
  console.log(JSON.stringify({
    status: differences.length ? 'FAIL' : 'PASS',
    scope: 'canonical_only', scenario: 'controlled_delta_on_real_copy',
    changed_vins: scope.length, changed_canonical_rows: changedResults,
    stock_rows_modified: stock.length, sales_rows_removed: sales.length,
    full_rows: b.size, incremental_rows: a.size,
    differences: differences.length,
    full_ms: full.elapsed_ms, incremental_ms: incremental.elapsed_ms,
    full_upserted: full.result.base.rows_upserted,
    incremental_upserted: incremental.result.base.rows_upserted,
    ignored_fields: ['vehiculo_id', 'canonicalized_at']
  }, null, 2));
  if (differences.length) process.exitCode = 1;
} catch (error) {
  // No source data, SQL parameters or row-level error details in Actions logs.
  console.error(JSON.stringify({ status: 'ERROR', code: error.code || error.name }));
  process.exitCode = 1;
} finally {
  await client.query('ROLLBACK').finally(() => client.end());
}
