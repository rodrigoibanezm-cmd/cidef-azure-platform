import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { getAzurePool } from '../../../lib/azure-postgres.js';
import { refreshVehiculoCanonicoV01 } from '../../../lib/canonical/refresh-vehiculo-canonico-v01.js';
import { run as vehicles } from './import-vehiculos.js';
import { run as sales } from './import-estadisticas-venta.js';
import { run as salesNotes } from './import-notas-venta.js';
import { run as creditNotes } from './import-notas-credito.js';
import { queryDb } from './db.js';
import { createContainer, inspectDay, validDate, withSourceContext } from './source-io.js';

const TABLES = ['vehiculos_raw', 'ventas_raw', 'notas_venta_raw', 'notas_credito_raw'];
const LOADERS = [vehicles, sales, salesNotes, creditNotes];
// Also coordinates with the existing legacy Azure RAW synchronization.
const LOCK_NAME = 'cidef_ventas_raw_neon_azure_sync';

export function normalizeDates(dates) {
  if (!Array.isArray(dates) || !dates.length || dates.some(d => !validDate(d))) {
    throw new Error('At least one explicit YYYY-MM-DD source date is required');
  }
  if (new Set(dates).size !== dates.length) throw new Error('Duplicate SALES dates');
  return [...dates].sort();
}

export function sourceSignature(files) {
  return createHash('sha256').update(JSON.stringify(files.map(f => [f.Key, f.ETag, f.size]))).digest('hex');
}

export async function refreshDay({ client, container, date, loaders = LOADERS,
  refreshCanonical = refreshVehiculoCanonicoV01, runId = randomUUID() }) {
  const files = await inspectDay(container, date);
  const signature = sourceSignature(files);
  const startedAt = Date.now();
  await client.query('BEGIN');
  try {
    return await withSourceContext({ client, container, date, files }, async () => {
      await queryDb(`CREATE TABLE IF NOT EXISTS public.sales_refresh_runs (
        source_date date NOT NULL, source_signature text NOT NULL, run_id uuid NOT NULL,
        sources jsonb NOT NULL, result jsonb NOT NULL, vin_changes jsonb NOT NULL,
        completed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source_date, source_signature)
      )`);
      const previous = await queryDb(`SELECT result FROM public.sales_refresh_runs
        WHERE source_date=$1::date AND source_signature=$2`, [date, signature]);
      if (previous.length) {
        await client.query('COMMIT');
        return { date, runId, signature, status: 'ALREADY_LOADED', previous: previous[0].result };
      }
      const [latest] = await queryDb("SELECT max(source_date)::text AS date FROM public.sales_refresh_runs");
      if (latest.date && date < latest.date) {
        throw new Error('Historical replacement blocked: process corrections separately before ' + latest.date);
      }
      await queryDb('LOCK TABLE public.vehiculos_raw, public.ventas_raw, public.notas_venta_raw, public.notas_credito_raw, public.vehiculo_canonico IN SHARE ROW EXCLUSIVE MODE');
      await queryDb(`CREATE TEMP TABLE sales_canonical_before ON COMMIT DROP AS
        SELECT vin, to_jsonb(v) AS payload FROM public.vehiculo_canonico v`);
      const sources = {};
      for (let index = 0; index < LOADERS.length; index++) {
        sources[TABLES[index]] = await loaders[index]();
      }
      // Existing canonical SQL and recognition/resolution rules, on this same transaction.
      const preview = await refreshCanonical({ dry_run: true, execute: queryDb });
      assert.equal(Number(preview.before.canonical_extra_before), 0, 'Refresh would delete canonical VINs; blocked');
      const canonical = await refreshCanonical({ dry_run: false, execute: queryDb });
      assert.equal(Number(canonical.base.rows_deleted), 0, 'Canonical refresh deleted records');
      const result = { engine: 'refresh_sales_sources_v01', version: 'azure-1', date, runId,
        signature, status: 'LOADED', strategy: 'FOUR_SOURCE_REFRESH_THEN_CANONICALIZE',
        sources, canonical, elapsedMs: Date.now() - startedAt };
      const [history] = await queryDb(`WITH changes AS (
        SELECT coalesce(b.vin, a.vin) AS vin, b.payload AS before, to_jsonb(a) AS after
        FROM sales_canonical_before b FULL JOIN public.vehiculo_canonico a USING(vin)
        WHERE (b.payload - 'canonicalized_at') IS DISTINCT FROM (to_jsonb(a) - 'canonicalized_at')
      ), inserted AS (
        INSERT INTO public.sales_refresh_runs (source_date, source_signature, run_id, sources, result, vin_changes)
        SELECT $1::date, $2, $3::uuid, $4::jsonb, $5::jsonb,
          coalesce(jsonb_agg(to_jsonb(changes) ORDER BY vin), '[]'::jsonb) FROM changes
        RETURNING jsonb_array_length(vin_changes) AS changed_vins
      ) SELECT changed_vins FROM inserted`,
      [date, signature, runId, JSON.stringify(files), JSON.stringify(result)]);
      await client.query('COMMIT');
      return { ...result, changedVins: history.changed_vins };
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function runSalesRefresh({ dates, container, pool, log = () => {},
  loaders, refreshCanonical } = {}) {
  const ordered = normalizeDates(dates);
  container ||= createContainer();
  if (!pool) {
    const connection = process.env.AZURE_DATABASE_URL;
    if (!connection || !new URL(connection).hostname.endsWith('.postgres.database.azure.com')) {
      throw new Error('AZURE_DATABASE_URL must point to PostgreSQL Azure; no database fallback');
    }
    pool = getAzurePool();
  }
  const client = await pool.connect();
  let locked = false;
  const results = [];
  const runId = randomUUID();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_NAME]);
    locked = lock.rows[0].locked;
    if (!locked) throw new Error('Another SALES refresh/synchronization is running');
    for (const date of ordered) {
      log({ runId, date, status: 'RUNNING' });
      try {
        const result = await refreshDay({ client, container, date, loaders, refreshCanonical, runId });
        results.push(result);
        log(result);
      } catch (error) {
        log({ runId, date, status: 'FAILED', completedDates: results.map(r => r.date) });
        throw Object.assign(error, { sourceDate: date, completedDates: results.map(r => r.date) });
      }
    }
    return results;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
      client.release();
    } catch (error) {
      // Never put a connection that may still own a session lock back into the pool.
      client.release(error);
    }
  }
}
