// SALES snapshot storage. Requires a trusted signature recorded by a successful SALES load.
// No RAW queries here; all metric values come from the existing certified P1/P3 generator.
import { getAzurePool } from '../lib/azure-postgres.js';
import { buildComoVamosSales } from './como-vamos.js';

export const SALES_ENGINE_SIGNATURE = 'cv-sales-company-p1-v1';

function validate(period, signature) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('INVALID_PERIOD');
  if (typeof signature !== 'string' || !signature.trim()) throw new Error('SALES_SOURCE_SIGNATURE_REQUIRED');
}

function checkCertified(result, period) {
  const indicator = result?.indicators?.find(x => x.id === 'sales');
  if (result?.period !== period || !indicator?.certified || !indicator.evidence_id ||
      !indicator.cutoff || !result.run_id || !Array.isArray(indicator.series) ||
      indicator.series.length !== 4) {
    throw new Error('SALES_SNAPSHOT_NOT_CERTIFIED');
  }
  const cutoff = indicator.cutoff.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || cutoff.slice(0, 7) !== period) {
    throw new Error('SALES_SNAPSHOT_INVALID_CUTOFF');
  }
  return cutoff;
}

async function cached(client, period, sourceSignature, engineSignature) {
  const { rows } = await client.query(
    `SELECT period, cutoff_date::text, scope, source_signature, engine_signature, payload,
            p3_run_id, generated_at
     FROM cv_sales_snapshots
     WHERE period=$1 AND scope='COMPANY' AND source_signature=$2 AND engine_signature=$3
     ORDER BY cutoff_date DESC LIMIT 1`,
    [period, sourceSignature, engineSignature],
  );
  return rows[0] || null;
}

// Read-through is shared by production and staging: one DB lock prevents duplicate generation.
// Source signature MUST originate from trusted post-load metadata, not the caller/browser.
export async function readOrBuildCompanySalesSnapshot({
  period, sourceSignature, engineSignature = SALES_ENGINE_SIGNATURE, build = buildComoVamosSales,
}) {
  validate(period, sourceSignature);
  if (!engineSignature) throw new Error('SALES_ENGINE_SIGNATURE_REQUIRED');
  const pool = getAzurePool();
  const first = await cached(pool, period, sourceSignature, engineSignature);
  if (first) return { cache: 'HIT', snapshot: first };

  const client = await pool.connect();
  let locked = false;
  try {
    // Session advisory lock; released in finally, including generator failure.
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
      ['cv_sales_snapshots', period]);
    locked = lock.rows[0]?.acquired === true;
    if (!locked) return { cache: 'BUILDING', snapshot: null };

    const second = await cached(client, period, sourceSignature, engineSignature);
    if (second) return { cache: 'HIT', snapshot: second };

    const payload = await build(period);
    const cutoffDate = checkCertified(payload, period);
    await client.query('BEGIN');
    try {
      const { rows } = await client.query(
        `INSERT INTO cv_sales_snapshots
          (period, cutoff_date, scope, source_signature, engine_signature, payload, p3_run_id)
         VALUES ($1,$2,'COMPANY',$3,$4,$5::jsonb,$6)
         ON CONFLICT (period, cutoff_date, scope) DO UPDATE SET
          source_signature=EXCLUDED.source_signature, engine_signature=EXCLUDED.engine_signature,
          payload=EXCLUDED.payload, p3_run_id=EXCLUDED.p3_run_id, generated_at=now()
         RETURNING period, cutoff_date::text, scope, source_signature, engine_signature,
                   payload, p3_run_id, generated_at`,
        [period, cutoffDate, sourceSignature, engineSignature, JSON.stringify(payload), payload.run_id],
      );
      await client.query('COMMIT');
      return { cache: 'BUILT', snapshot: rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))',
      ['cv_sales_snapshots', period]).catch(() => {});
    client.release();
  }
}
