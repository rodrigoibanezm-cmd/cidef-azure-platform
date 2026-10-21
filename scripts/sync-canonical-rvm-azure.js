import { fileURLToPath } from 'node:url';
import { getAzurePool } from '../lib/azure-postgres.js';

const TARGET_HOST = 'cidef-postgres-prod.postgres.database.azure.com';
const AUDIT_SQL = `
  SELECT count(*)::int AS pending,
         count(*) FILTER (WHERE r.fecha_inscripcion_rvm >= DATE '2026-10-01')::int AS october,
         max(r.fecha_inscripcion_rvm)::text AS latest_source,
         count(*) FILTER (WHERE c.fecha_inscripcion_rvm IS NOT NULL)::int AS conflicts
  FROM public.vehiculos_raw r
  JOIN public.vehiculo_canonico c ON c.vin = upper(btrim(r.vin_chasis))
  WHERE r.fecha_inscripcion_rvm IS NOT NULL
    AND c.fecha_inscripcion_rvm IS DISTINCT FROM r.fecha_inscripcion_rvm
`;

export async function syncCanonicalRvm({ apply = false, pool = getAzurePool() } = {}) {
  const url = process.env.AZURE_DATABASE_URL;
  if (!url || new URL(url).hostname !== TARGET_HOST) throw new Error('Azure production PostgreSQL required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const before = (await client.query(AUDIT_SQL)).rows[0];
    if (before.conflicts !== 0) throw new Error('Conflicting non-null canonical RVM dates: investigate before applying');
    if (!apply) {
      await client.query('ROLLBACK');
      return { mode: 'dry_run', before };
    }
    const updated = await client.query(`
      UPDATE public.vehiculo_canonico c
         SET fecha_inscripcion_rvm = r.fecha_inscripcion_rvm
        FROM public.vehiculos_raw r
       WHERE c.vin = upper(btrim(r.vin_chasis))
         AND r.fecha_inscripcion_rvm IS NOT NULL
         AND c.fecha_inscripcion_rvm IS NULL
      RETURNING c.vin
    `);
    const after = (await client.query(AUDIT_SQL)).rows[0];
    if (after.pending !== 0 || updated.rowCount !== before.pending) {
      throw new Error('RVM parity validation failed; rolling back');
    }
    await client.query('COMMIT');
    return { mode: 'apply', updated: updated.rowCount, before, after };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncCanonicalRvm({ apply: process.env.APPLY_CANONICAL_RVM === 'true' })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => getAzurePool().end());
}
