import { refreshDealerSellout } from '../../../lib/data-floor/refreshDealerSellout.js';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { getAzurePool } from '../../../lib/azure-postgres.js';
import { refreshVehiculoCanonicoV01 } from '../../../lib/canonical/refresh-vehiculo-canonico-v01.js';
import { fetchDataSource, observeDataSource } from '../../../lib/data-floor/registry.js';
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
  let stage = 'begin_transaction';
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
        stage = 'load_' + TABLES[index];
        sources[TABLES[index]] = await loaders[index]();
      }
      // Existing canonical SQL and recognition/resolution rules, on this same transaction.
      stage = 'canonical_preview';
      const preview = await refreshCanonical({ dry_run: true, execute: queryDb });
      assert.equal(Number(preview.before.canonical_extra_before), 0, 'Refresh would delete canonical VINs; blocked');
      stage = 'canonical_refresh';
      const canonical = await refreshCanonical({ dry_run: false, execute: queryDb });
      assert.equal(Number(canonical.base.rows_deleted), 0, 'Canonical refresh deleted records');
      const result = { engine: 'refresh_sales_sources_v01', version: 'azure-1', date, runId,
        signature, status: 'LOADED', strategy: 'FOUR_SOURCE_REFRESH_THEN_CANONICALIZE',
        sources, canonical, elapsedMs: Date.now() - startedAt };
      stage = 'refresh_dealer_sellout';
      const sellout = await refreshDealerSellout(queryDb);
      result.sellout = sellout;
      stage = 'save_sales_history';
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
      stage = 'commit';
      await client.query('COMMIT');
      return { ...result, changedVins: history.changed_vins };
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw Object.assign(error, { salesStage: stage });
  }
}


// Raw row signatures, grouped by VIN; unkeyed changes trigger full fallback.
export const RAW_VIN_SIGNATURE_SQL = `
 SELECT source, vin, md5(string_agg(row_hash, '' ORDER BY row_hash)) AS signature FROM (
 SELECT 'vehiculos_raw'::text source, coalesce(upper(btrim(vin_chasis)),'') vin, md5(to_jsonb(v)::text) row_hash FROM public.vehiculos_raw v
 UNION ALL SELECT 'ventas_raw', coalesce(upper(btrim(nro_vin_chasis)),''), md5(to_jsonb(v)::text) FROM public.ventas_raw v
 UNION ALL SELECT 'notas_venta_raw', coalesce(upper(btrim(chasis)),''), md5(to_jsonb(n)::text) FROM public.notas_venta_raw n
 UNION ALL SELECT 'notas_credito_raw', ''::text, md5(to_jsonb(n)::text) FROM public.notas_credito_raw n
 ) raw_rows GROUP BY source, vin
`;
export const RAW_STATE_SIGNATURE_SQL = `
 WITH current_state AS (${RAW_VIN_SIGNATURE_SQL})
 SELECT md5(coalesce(string_agg(source||':'||vin||':'||signature, '' ORDER BY source,vin),'')) signature
 FROM current_state
`;
export async function captureRawVinDelta(execute = queryDb) {
 const [delta] = await execute(`
 WITH current_state AS (${RAW_VIN_SIGNATURE_SQL}),
 changed AS (SELECT coalesce(b.vin,c.vin) vin FROM sales_raw_vin_before b
 FULL JOIN current_state c ON b.source=c.source AND b.vin=c.vin
 WHERE b.signature IS DISTINCT FROM c.signature)
 SELECT coalesce(array_agg(DISTINCT vin) FILTER (WHERE length(vin)=17 AND vin ~ '^[A-HJ-NPR-Z0-9]{17}$'), ARRAY[]::text[]) changed_vins,
 coalesce(bool_or(length(vin)<>17 OR vin !~ '^[A-HJ-NPR-Z0-9]{17}$'),false) requires_full,
 (SELECT md5(coalesce(string_agg(source||':'||vin||':'||signature, '' ORDER BY source,vin),'')) FROM current_state) raw_state_signature,
 (SELECT md5(coalesce(string_agg(source||':'||vin||':'||signature, '' ORDER BY source,vin),'')) FROM sales_raw_vin_before) raw_before_signature
 FROM changed`);
 if (!delta || !Array.isArray(delta.changed_vins) || !delta.raw_state_signature || !delta.raw_before_signature) throw new Error('RAW VIN delta calculation failed');
 return { changedVins: delta.changed_vins, requiresFull: delta.requires_full === true,
   rawStateSignature: delta.raw_state_signature,
   rawBeforeSignature: delta.raw_before_signature };
}
// RAW-only mode deliberately has independent idempotence from full SALES refresh.
export async function refreshRawDay({ client, container, date, loaders = LOADERS, runId }) {
  const files = await inspectDay(container, date);
  const signature = sourceSignature(files);
  const startedAt = Date.now();
  let stage = 'begin_transaction';
  await client.query('BEGIN');
  try {
    return await withSourceContext({ client, container, date, files }, async () => {
      await queryDb(`CREATE TABLE IF NOT EXISTS public.sales_raw_refresh_runs (
        source_date date NOT NULL, source_signature text NOT NULL, run_id uuid NOT NULL,
        sources jsonb NOT NULL, result jsonb NOT NULL,
        completed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source_date, source_signature)
      )`);
      const previous = await queryDb(`SELECT result FROM public.sales_raw_refresh_runs
        WHERE source_date=$1::date AND source_signature=$2`, [date, signature]);
      if (previous.length) {
        await client.query('COMMIT');
        return { date, runId, signature, status: 'ALREADY_LOADED', previous: previous[0].result };
      }
      const [latest] = await queryDb('SELECT max(source_date)::text AS date FROM public.sales_raw_refresh_runs');
      if (latest.date && date < latest.date) {
        throw new Error('Historical RAW replacement blocked: ' + date + ' before ' + latest.date);
      }
      stage = 'load_raw';
      await queryDb('LOCK TABLE public.vehiculos_raw, public.ventas_raw, public.notas_venta_raw, public.notas_credito_raw IN SHARE ROW EXCLUSIVE MODE');
      await queryDb(`CREATE TEMP TABLE sales_raw_vin_before ON COMMIT DROP AS ${RAW_VIN_SIGNATURE_SQL}`);
      const sources = {};
      for (let index = 0; index < TABLES.length; index++) {
        stage = 'load_' + TABLES[index];
        sources[TABLES[index]] = await loaders[index](index === 0 ? { skipRvmSync: true } : undefined);
      }
      const rawDelta = await captureRawVinDelta(queryDb);
      const result = { engine: 'refresh_sales_raw_v01', date, runId, signature,
        status: 'LOADED', sources, rawDelta, elapsedMs: Date.now() - startedAt };
      stage = 'save_raw_history';
      await queryDb(`INSERT INTO public.sales_raw_refresh_runs
        (source_date, source_signature, run_id, sources, result)
        VALUES ($1::date,$2,$3::uuid,$4::jsonb,$5::jsonb)`,
      [date, signature, runId, JSON.stringify(files), JSON.stringify(result)]);
      stage = 'commit';
      await client.query('COMMIT');
      return result;
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw Object.assign(error, { salesStage: stage });
  }
}

export async function runSalesRawRefresh({ dates, container, pool, log = () => {}, loaders } = {}) {
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
  const runId = randomUUID();
  let locked = false;
  const results = [];
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_NAME]);
    locked = lock.rows[0].locked;
    if (!locked) throw new Error('Another SALES refresh/synchronization is running');
    for (const date of ordered) {
      log({ runId, date, status: 'RUNNING', mode: 'RAW_ONLY' });
      try {
        const result = await refreshRawDay({ client, container, date, loaders, runId });
        results.push(result);
        log(result);
      } catch (error) {
        log({ runId, date, status: 'FAILED', stage: error.salesStage, mode: 'RAW_ONLY' });
        throw Object.assign(error, { sourceDate: date, completedDates: results.map(r => r.date) });
      }
    }
    return results;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
      client.release();
    } catch (error) { client.release(error); }
  }
}

export async function publishCurrentDealerSellin(period, cutoff, pool, transactionClient = null) {
  const filters = { commercial_universe: 'DEALERS', sales_source: 'SALES',
    date_from: period + '-01', date_to: cutoff };
  const evidence = await observeDataSource('SALES', { measure: 'VIN_SALES', filters });
  const fetched = await fetchDataSource('SALES', {
    filters, fields: ['sale_date', 'dealer_group_id', 'brand_id', 'model_id', 'quantity'],
  });
  if (evidence.status !== 'CERTIFIED' || evidence.authority !== 'P1_CERTIFIED' ||
      !evidence.evidence_id || !fetched.quality?.validation?.valid ||
      fetched.rows.reduce((sum, row) => sum + Number(row.quantity), 0) !== evidence.payload.value) {
    throw new Error('P1_SALES_NOT_RECONCILED: ' + period);
  }
  const groups = new Map();
  let unresolvedModels = 0;
  for (const sale of fetched.rows) {
    const dealer = sale.dealer_group_id == null ? 0 : Number(sale.dealer_group_id);
    // 0 is an explicit unresolved-model bucket, not a fabricated model identity.
    const brand = Number(sale.brand_id);
    const model = sale.model_id == null ? 0 : Number(sale.model_id);
    if (String(sale.sale_date).slice(0, 7) !== period || !Number.isSafeInteger(dealer) ||
        !Number.isSafeInteger(brand) || brand <= 0 ||
        !Number.isSafeInteger(model) || model < 0) {
      throw new Error('INVALID_SELLIN_DIMENSIONS: ' + period);
    }
    if (model === 0) unresolvedModels += Number(sale.quantity);
    const key = [dealer, brand, model].join('|');
    groups.set(key, (groups.get(key) || 0) + Number(sale.quantity));
  }
  const client = transactionClient || await pool.connect();
  try {
    if (!transactionClient) await client.query('BEGIN');
    await client.query('DELETE FROM dealer_monthly_model_sellin_snapshots WHERE period=$1', [period]);
    for (const [key, units] of groups) {
      const [dealer, brand, model] = key.split('|').map(Number);
      await client.query(`INSERT INTO dealer_monthly_model_sellin_snapshots
        (period, dealer_group_id, brand_id, model_id, vin_sales, cutoff_date, sales_evidence_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [period, dealer, brand, model, units, cutoff, evidence.evidence_id]);
    }
    if (!transactionClient) await client.query('COMMIT');
    return { period, status: 'UPDATED', units: evidence.payload.value,
      rows: groups.size, unresolved_model_vin: unresolvedModels };
  } catch (error) { if (!transactionClient) await client.query('ROLLBACK'); throw error; }
  finally { if (!transactionClient) client.release(); }
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
        // SALES already refreshed the canonical (sell-out); publish open-month sell-in separately.
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
        const currentMonth = parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value.padStart(2, '0');
        const dealerSnapshot = date.slice(0, 7) === currentMonth
          ? await publishCurrentDealerSellin(currentMonth, date, pool) : null;
        const completed = { ...result, ...(dealerSnapshot ? { dealerSnapshot } : {}) };
        results.push(completed);
        log(completed);
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
