import { randomUUID } from 'node:crypto';
import { azureCompatibleSql } from '../../../lib/azure-postgres.js';
import { sourceContext } from './source-io.js';

const RAW_TABLES = new Set(['vehiculos_raw', 'ventas_raw', 'notas_venta_raw', 'notas_credito_raw']);
export const quoteIdent = value => '"' + String(value).replaceAll('"', '""') + '"';

export async function queryDb(sql, params = []) {
  // Never retry individual statements inside a transaction (especially append-only inserts).
  return (await sourceContext().client.query(azureCompatibleSql(sql), params)).rows;
}

async function columns(table) {
  return queryDb(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attnum`, ['public.' + table]);
}

export async function beginTableSnapshot(tableName, names) {
  if (!RAW_TABLES.has(tableName) || !names.length) throw new Error('Invalid SALES RAW target/columns');
  const staging = tableName + '__loading_' + randomUUID().replaceAll('-', '');
  await queryDb(`CREATE TABLE ${quoteIdent(staging)} (${names.map(n => quoteIdent(n) + ' text').join(',')})`);
  return { tableName, staging, columns: names };
}

export async function appendTableRows(snapshot, rows) {
  const batchSize = Math.max(1, Math.min(500, Math.floor(8000 / snapshot.columns.length)));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = batch.flat();
    const tuples = batch.map((row, i) => '(' + row.map((_, j) => '$' + (i * snapshot.columns.length + j + 1)).join(',') + ')');
    await queryDb(`INSERT INTO ${quoteIdent(snapshot.staging)} (${snapshot.columns.map(quoteIdent).join(',')}) VALUES ${tuples.join(',')}`, values);
  }
  return { rowsLoaded: rows.length, batchSize };
}

function validateSnapshotComparison(snapshot, keyColumns, sampleLimit) {
  const { tableName, staging } = snapshot || {};
  if (!RAW_TABLES.has(tableName) || tableName === 'notas_credito_raw' ||
      typeof staging !== 'string' || !new RegExp('^' + tableName + '__loading_[a-f0-9]{32}$').test(staging)) {
    throw new Error('Invalid SALES comparison snapshot');
  }
  if (!Array.isArray(keyColumns) || keyColumns.some(k => typeof k !== 'string' || !k) ||
      new Set(keyColumns).size !== keyColumns.length) throw new Error('Invalid comparison key columns');
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > 1000) {
    throw new Error('Comparison sampleLimit must be an integer from 0 to 1000');
  }
}

/**
 * Read-only diagnostic, not called by the existing full publication. Compare the
 * actual staging columns (after cleaning), cast to RAW types, in one statement.
 * keyColumns explicitly declares a stable key; it never infers VIN uniqueness.
 * Pair modifications only if that key is unique/non-null in BOTH complete inputs.
 * Samples use PostgreSQL text values/nulls to avoid JS bigint/date rounding.
 * The caller owns the source-context connection, transaction and any locks.
 */
export async function compareTableSnapshot(snapshot, { keyColumns = [], sampleLimit = 100 } = {}) {
  validateSnapshotComparison(snapshot, keyColumns, sampleLimit);
  const { tableName, staging } = snapshot;
  const target = await columns(tableName);
  const stage = await columns(staging);
  if (!target.length || !stage.length) throw new Error('Required SALES comparison table missing');
  const types = new Map(target.map(c => [c.name, c.type]));
  const names = stage.map(c => c.name);
  const missing = names.filter(n => !types.has(n));
  if (missing.length) throw new Error('Azure RAW schema mismatch: ' + missing.join(','));
  if (keyColumns.some(k => !names.includes(k))) throw new Error('Comparison key is outside staging columns');

  const keyed = keyColumns.length > 0;
  const keys = keyColumns.map(quoteIdent).join(',');
  const joinKeys = (a, b) => keyColumns.map(k => `${a}.${quoteIdent(k)} = ${b}.${quoteIdent(k)}`).join(' AND ');
  const payload = alias => `jsonb_object($2::text[], ARRAY[${names.map(n => `${alias}.${quoteIdent(n)}::text`).join(',')}])`;
  const keyAudit = side => `
    (SELECT count(*) FROM ${side}_rows WHERE ${keyColumns.map(k => `${quoteIdent(k)} IS NULL`).join(' OR ')}) AS ${side}_null_rows,
    (SELECT count(*) FROM (SELECT ${keys} FROM ${side}_rows GROUP BY ${keys} HAVING count(*) > 1) d) AS ${side}_duplicate_groups`;
  const sample = (relation, expression) => `(SELECT coalesce(jsonb_agg(${expression}), '[]'::jsonb)
    FROM (SELECT * FROM ${relation} ORDER BY to_jsonb(${relation})::text LIMIT $1) s)`;
  const [result] = await queryDb(`WITH
    raw_rows AS MATERIALIZED (
      SELECT ${names.map(quoteIdent).join(',')} FROM public.${quoteIdent(tableName)}
    ), stage_rows AS MATERIALIZED (
      SELECT ${names.map(n => `${quoteIdent(n)}::${types.get(n)} AS ${quoteIdent(n)}`).join(',')}
      FROM public.${quoteIdent(staging)}
    ), additions AS MATERIALIZED (TABLE stage_rows EXCEPT ALL TABLE raw_rows),
    removals AS MATERIALIZED (TABLE raw_rows EXCEPT ALL TABLE stage_rows)
    ${keyed ? `, key_audit AS (SELECT ${['raw', 'stage'].map(keyAudit).join(',')}),
    key_check AS (
      SELECT *, raw_null_rows=0 AND stage_null_rows=0
        AND raw_duplicate_groups=0 AND stage_duplicate_groups=0 AS reliable FROM key_audit
    ), modified_keys AS MATERIALIZED (
      SELECT ${keyColumns.map(k => `a.${quoteIdent(k)}`).join(',')}
      FROM additions a JOIN removals r ON ${joinKeys('a', 'r')}
      WHERE (SELECT reliable FROM key_check)
    ), new_rows AS (
      SELECT a.* FROM additions a WHERE NOT EXISTS (SELECT 1 FROM modified_keys m WHERE ${joinKeys('a', 'm')})
    ), deleted_rows AS (
      SELECT r.* FROM removals r WHERE NOT EXISTS (SELECT 1 FROM modified_keys m WHERE ${joinKeys('r', 'm')})
    ), modifications AS (
      SELECT jsonb_object($3::text[], ARRAY[${keyColumns.map(k => `m.${quoteIdent(k)}::text`).join(',')}]) AS key,
        ${payload('r')} AS before, ${payload('a')} AS after
      FROM modified_keys m JOIN removals r ON ${joinKeys('m', 'r')}
      JOIN additions a ON ${joinKeys('m', 'a')}
    )` : ''}
    SELECT
      (SELECT count(*) FROM raw_rows) AS raw,
      (SELECT count(*) FROM stage_rows) AS staging,
      (SELECT count(*) FROM raw_rows) - (SELECT count(*) FROM removals) AS unchanged,
      (SELECT count(*) FROM ${keyed ? 'new_rows' : 'additions'}) AS added,
      (SELECT count(*) FROM ${keyed ? 'deleted_rows' : 'removals'}) AS removed,
      ${keyed ? '(SELECT CASE WHEN reliable THEN (SELECT count(*) FROM modified_keys) END FROM key_check)' : 'NULL::bigint'} AS modified,
      ${keyed ? '(SELECT to_jsonb(k) FROM key_check k)' : 'NULL::jsonb'} AS key_audit,
      ${sample(keyed ? 'new_rows' : 'additions', payload('s'))} AS added_rows,
      ${sample(keyed ? 'deleted_rows' : 'removals', payload('s'))} AS removed_rows,
      ${keyed ? sample('modifications', 'to_jsonb(s)') : "'[]'::jsonb"} AS modified_rows
  `, keyed ? [sampleLimit, names, keyColumns] : [sampleLimit, names]);

  const counts = Object.fromEntries(['raw', 'staging', 'unchanged', 'added', 'removed', 'modified']
    .map(k => [k, result[k] === null ? null : Number(result[k])]));
  if (Object.values(counts).some(n => n !== null && !Number.isSafeInteger(n))) {
    throw new Error('Comparison count exceeds JavaScript safe integer range');
  }
  const { reliable, ...audit } = result.key_audit || {};
  return {
    table: tableName, staging, columns: names, valueFormat: 'postgres-text',
    key: { columns: [...keyColumns], status: !keyed ? 'NOT_PROVIDED' : reliable ? 'UNIQUE_NON_NULL' : 'UNRELIABLE', ...audit },
    counts, hasChanges: counts.added > 0 || counts.removed > 0 || counts.modified > 0,
    differences: { added: result.added_rows, removed: result.removed_rows, modified: result.modified_rows },
    sampleLimit,
    truncated: { added: counts.added > sampleLimit, removed: counts.removed > sampleLimit,
      modified: counts.modified !== null && counts.modified > sampleLimit },
  };
}

/**
 * Opt-in helper only; no importer calls it. Requires the caller's open transaction
 * and source-context client. SAVEPOINT rejects autocommit before any table writes.
 * Locks both inputs through the outer transaction, never commits or drops staging.
 * On failure, roll back this publication while preserving earlier caller work.
 * Only actual staging columns are published; without a reliable key, changed rows
 * use DELETE/INSERT, so RAW-only columns on those new rows receive their defaults.
 */
export async function publishTableSnapshotDiff(snapshot, { keyColumns = [], sampleLimit = 100 } = {}) {
  validateSnapshotComparison(snapshot, keyColumns, sampleLimit);
  const { tableName, staging } = snapshot;
  const savepoint = quoteIdent('sales_diff_' + randomUUID().replaceAll('-', ''));
  await queryDb(`SAVEPOINT ${savepoint}`);
  try {
    await queryDb(`LOCK TABLE public.${quoteIdent(tableName)}, public.${quoteIdent(staging)} IN SHARE ROW EXCLUSIVE MODE`);
    const comparison = await compareTableSnapshot(snapshot, { keyColumns, sampleLimit });
    if (!comparison.counts.staging) throw new Error('Empty SALES snapshot blocked: ' + tableName);
    const applied = { added: 0, removed: 0, modified: 0 };
    if (comparison.hasChanges) {
      const names = comparison.columns;
      const types = new Map((await columns(tableName)).map(c => [c.name, c.type]));
      const raw = `public.${quoteIdent(tableName)}`;
      const colList = names.map(quoteIdent).join(',');
      const row = alias => `ROW(${names.map(n => `${alias}.${quoteIdent(n)}`).join(',')})`;
      const keyMatch = (a, b) => keyColumns.map(n => `${a}.${quoteIdent(n)} = ${b}.${quoteIdent(n)}`).join(' AND ');
      const stageRows = `stage_rows AS MATERIALIZED (
        SELECT ${names.map(n => `${quoteIdent(n)}::${types.get(n)} AS ${quoteIdent(n)}`).join(',')}
        FROM public.${quoteIdent(staging)}
      )`;
      const reliableKey = comparison.key.status === 'UNIQUE_NON_NULL';
      const countMutation = async sql => Number((await queryDb(sql))[0].affected);

      if (comparison.counts.removed) {
        applied.removed = await countMutation(reliableKey ? `WITH ${stageRows}, changed AS (
          DELETE FROM ${raw} r WHERE NOT EXISTS (SELECT 1 FROM stage_rows s WHERE ${keyMatch('r', 's')})
          RETURNING 1
        ) SELECT count(*) AS affected FROM changed` : `WITH ${stageRows},
        raw_rows AS (SELECT ${colList} FROM ${raw}),
        removals AS (TABLE raw_rows EXCEPT ALL TABLE stage_rows),
        removal_groups AS (
          SELECT ${row('d')} AS row_values, count(*) AS copies FROM removals d GROUP BY ${row('d')}
        ), ranked_raw AS (
          SELECT r.tableoid AS relation_id, r.ctid AS row_id, ${row('r')} AS row_values,
            row_number() OVER (PARTITION BY ${row('r')} ORDER BY r.tableoid, r.ctid) AS occurrence
          FROM ${raw} r
        ), changed AS (
          DELETE FROM ${raw} t USING ranked_raw r, removal_groups d
          WHERE t.tableoid=r.relation_id AND t.ctid=r.row_id
            AND r.row_values IS NOT DISTINCT FROM d.row_values AND r.occurrence <= d.copies
          RETURNING 1
        ) SELECT count(*) AS affected FROM changed`);
      }
      if (reliableKey && comparison.counts.modified) {
        applied.modified = await countMutation(`WITH ${stageRows}, changed AS (
          UPDATE ${raw} r SET ${names.map(n => `${quoteIdent(n)}=s.${quoteIdent(n)}`).join(',')}
          FROM stage_rows s WHERE ${keyMatch('r', 's')} AND ${row('r')} IS DISTINCT FROM ${row('s')}
          RETURNING 1
        ) SELECT count(*) AS affected FROM changed`);
      }
      if (comparison.counts.added) {
        applied.added = await countMutation(`WITH ${stageRows},
        raw_rows AS (SELECT ${colList} FROM ${raw}),
        additions AS (TABLE stage_rows EXCEPT ALL TABLE raw_rows), changed AS (
          INSERT INTO ${raw} (${colList}) SELECT ${colList} FROM additions RETURNING 1
        ) SELECT count(*) AS affected FROM changed`);
      }
      for (const kind of ['added', 'removed', 'modified']) {
        if (applied[kind] !== (comparison.counts[kind] ?? 0)) {
          throw new Error('SALES differential publication count mismatch: ' + kind);
        }
      }
      const after = await compareTableSnapshot(snapshot, { keyColumns, sampleLimit: 0 });
      if (after.hasChanges) throw new Error('SALES differential publication parity failed');
    }
    await queryDb(`RELEASE SAVEPOINT ${savepoint}`);
    return { comparison, applied, verified: true };
  } catch (error) {
    try {
      await queryDb(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await queryDb(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (rollbackError) {
      // Never hide an uncertain rollback or retry individual publication statements.
      throw new AggregateError([error, rollbackError], 'SALES publication failed and savepoint rollback failed');
    }
    throw error;
  }
}

export async function commitTableSnapshot(snapshot) {
  const target = await columns(snapshot.tableName);
  const stage = await columns(snapshot.staging);
  if (!target.length) throw new Error('Required Azure RAW table missing: ' + snapshot.tableName);
  const types = new Map(target.map(c => [c.name, c.type]));
  const missing = stage.filter(c => !types.has(c.name));
  if (missing.length) throw new Error('Azure RAW schema mismatch: ' + missing.map(c => c.name).join(','));
  const names = stage.map(c => c.name);
  // Preserve table identity, grants, indexes, defaults, and referencing views.
  await queryDb(`DELETE FROM public.${quoteIdent(snapshot.tableName)}`);
  await queryDb(`INSERT INTO public.${quoteIdent(snapshot.tableName)} (${names.map(quoteIdent).join(',')})
    SELECT ${names.map(n => `${quoteIdent(n)}::${types.get(n)}`).join(',')} FROM ${quoteIdent(snapshot.staging)}`);
  await queryDb(`DROP TABLE ${quoteIdent(snapshot.staging)}`);
}

export async function abortTableSnapshot() {
  // The daily transaction owns staging lifecycle. Its rollback removes staging too.
}

export async function replaceTableSnapshot(tableName, names, rows) {
  if (!rows.length) throw new Error('Empty SALES snapshot blocked: ' + tableName);
  const snapshot = await beginTableSnapshot(tableName, names);
  const result = await appendTableRows(snapshot, rows);
  await commitTableSnapshot(snapshot);
  return result;
}

export async function appendTableData(tableName, names, rows) {
  if (tableName !== 'notas_credito_raw') throw new Error('Only credit notes permit historical append');
  const target = await columns(tableName);
  const types = new Map(target.map(c => [c.name, c.type]));
  if (!target.length || names.some(n => !types.has(n))) throw new Error('Credit-note RAW schema mismatch');
  const batchSize = Math.max(1, Math.min(500, Math.floor(8000 / names.length)));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const tuples = batch.map((row, i) => '(' + row.map((_, j) => '$' + (i * names.length + j + 1) + '::' + types.get(names[j])).join(',') + ')');
    await queryDb(`INSERT INTO public.${quoteIdent(tableName)} (${names.map(quoteIdent).join(',')}) VALUES ${tuples.join(',')}`, batch.flat());
  }
  return { rowsLoaded: rows.length, batchSize };
}
