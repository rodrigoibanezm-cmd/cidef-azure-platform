import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;
const sourceUrl = process.env.NEON_DATABASE_URL;
const targetUrl = process.env.AZURE_DATABASE_URL;
const azureHost = 'cidef-postgres-prod.postgres.database.azure.com';
const tableName = 'ventas_metas_mensuales';
const table = 'public.ventas_metas_mensuales';
const sequence = 'public.ventas_metas_mensuales_id_seq';

if (!sourceUrl) throw new Error('Missing source secret NEON_DATABASE_URL in the Production environment');
if (!targetUrl) throw new Error('Missing destination secret AZURE_DATABASE_URL in the Production environment');

function host(url, name) {
  try { return new URL(url).hostname; } catch { throw new Error(name + ' connection URL is invalid'); }
}
const sourceHost = host(sourceUrl, 'NEON_DATABASE_URL');
if (!sourceHost.endsWith('.neon.tech')) throw new Error('NEON_DATABASE_URL does not point to a Neon host');
if (host(targetUrl, 'AZURE_DATABASE_URL') !== azureHost) {
  throw new Error('AZURE_DATABASE_URL does not point to the approved CIDEF Azure PostgreSQL host');
}

const expectedColumns = [
  { name: 'id', type: 'bigint', not_null: true, default: "nextval('ventas_metas_mensuales_id_seq'::regclass)" },
  { name: 'mes', type: 'date', not_null: true, default: null },
  { name: 'sucursal_id', type: 'text', not_null: true, default: null },
  { name: 'meta_vin', type: 'integer', not_null: true, default: null },
  { name: 'source', type: 'text', not_null: false, default: null },
  { name: 'created_at', type: 'timestamp with time zone', not_null: true, default: 'now()' },
  { name: 'updated_at', type: 'timestamp with time zone', not_null: true, default: 'now()' },
];
const expectedConstraints = [
  { name: 'ventas_metas_mensuales_mes_inicio_ck', type: 'c', definition: "CHECK (mes = date_trunc('month'::text, mes::timestamp with time zone)::date)" },
  { name: 'ventas_metas_mensuales_meta_vin_check', type: 'c', definition: 'CHECK (meta_vin >= 0)' },
  { name: 'ventas_metas_mensuales_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
  { name: 'ventas_metas_mensuales_mes_sucursal_uq', type: 'u', definition: 'UNIQUE (mes, sucursal_id)' },
];
const expectedIndexes = [
  { name: 'ventas_metas_mensuales_mes_sucursal_uq', unique: true, primary: false, valid: true, method: 'btree', columns: ['mes', 'sucursal_id'] },
  { name: 'ventas_metas_mensuales_pkey', unique: true, primary: true, valid: true, method: 'btree', columns: ['id'] },
];
const expectedSequence = {
  name: 'ventas_metas_mensuales_id_seq',
  type: 'bigint',
  start: '1',
  increment: '1',
  min: '1',
  max: '9223372036854775807',
  cache: '1',
  cycle: false,
  owned_by: 'id',
};

const columnsSql = `
SELECT attribute.attname AS name,
       format_type(attribute.atttypid, attribute.atttypmod) AS type,
       attribute.attnotnull AS not_null,
       pg_get_expr(definition.adbin, definition.adrelid) AS "default"
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
LEFT JOIN pg_attrdef AS definition
  ON definition.adrelid = relation.oid AND definition.adnum = attribute.attnum
WHERE namespace.nspname = 'public' AND relation.relname = $1
  AND attribute.attnum > 0 AND NOT attribute.attisdropped
ORDER BY attribute.attnum`;
const constraintsSql = `
SELECT constraint_row.conname AS name, constraint_row.contype AS type,
       pg_get_constraintdef(constraint_row.oid, true) AS definition
FROM pg_constraint AS constraint_row
WHERE constraint_row.conrelid = to_regclass($1)
ORDER BY constraint_row.contype, constraint_row.conname`;
const indexesSql = `
SELECT index_relation.relname AS name,
       index_row.indisunique AS unique,
       index_row.indisprimary AS primary,
       index_row.indisvalid AS valid,
       access_method.amname AS method,
       ARRAY(SELECT pg_get_indexdef(index_row.indexrelid, position, true)
             FROM generate_series(1, index_row.indnkeyatts::int) AS position) AS columns
FROM pg_index AS index_row
JOIN pg_class AS relation ON relation.oid = index_row.indrelid
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
WHERE namespace.nspname = 'public' AND relation.relname = $1
ORDER BY index_relation.relname`;
const sequenceSql = `
SELECT sequence_relation.relname AS name,
       format_type(sequence_metadata.seqtypid, NULL) AS type,
       sequence_metadata.seqstart::text AS start,
       sequence_metadata.seqincrement::text AS increment,
       sequence_metadata.seqmin::text AS min,
       sequence_metadata.seqmax::text AS max,
       sequence_metadata.seqcache::text AS cache,
       sequence_metadata.seqcycle AS cycle,
       attribute.attname AS owned_by
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attname = 'id'
JOIN pg_depend AS dependency
  ON dependency.refobjid = relation.oid
 AND dependency.refobjsubid = attribute.attnum
 AND dependency.deptype = 'a'
JOIN pg_class AS sequence_relation ON sequence_relation.oid = dependency.objid
JOIN pg_sequence AS sequence_metadata ON sequence_metadata.seqrelid = sequence_relation.oid
WHERE namespace.nspname = 'public' AND relation.relname = $1`;

async function inspectSchema(client) {
  const relationResult = await client.query(
    "SELECT relation.relkind FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = $1",
    [tableName],
  );
  if (!relationResult.rows.length) return { exists: false, relation: null, columns: [], constraints: [], indexes: [], sequence: null };
  const [columns, constraints, indexes, sequenceResult] = await Promise.all([
    client.query(columnsSql, [tableName]),
    client.query(constraintsSql, [table]),
    client.query(indexesSql, [tableName]),
    client.query(sequenceSql, [tableName]),
  ]);
  return {
    exists: true,
    relation: relationResult.rows[0].relkind,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    sequence: sequenceResult.rows[0] ?? null,
  };
}

function assertExactSourceSchema(schema) {
  assert.equal(schema.exists, true, 'Neon source table is missing');
  assert.equal(schema.relation, 'r', 'Neon source relation must be an ordinary table');
  assert.deepEqual(schema.columns, expectedColumns, 'Neon source columns/defaults differ from the certified DDL');
  assert.deepEqual(schema.constraints, expectedConstraints, 'Neon source constraints differ from the certified DDL');
  assert.deepEqual(schema.indexes, expectedIndexes, 'Neon source indexes differ from the certified DDL');
  assert.deepEqual(schema.sequence, expectedSequence, 'Neon source sequence differs from the certified DDL');
}

function safeError(error) {
  let message = String(error?.message ?? error);
  for (const secret of [sourceUrl, targetUrl].filter(Boolean)) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]');
  return error?.code ? error.code + ': ' + message : message;
}

const rowSql = `
SELECT id::text AS id,
       mes::text AS mes,
       sucursal_id,
       meta_vin::text AS meta_vin,
       source,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS created_at,
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS updated_at
FROM ${table}
ORDER BY id`;
function signature(row) {
  return JSON.stringify([row.id, row.mes, row.sucursal_id, row.meta_vin, row.source, row.created_at, row.updated_at]);
}
function assertUniqueKeys(rows, side) {
  const ids = new Set();
  const monthStore = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(side + ' has duplicate id values');
    ids.add(row.id);
    const key = row.mes + '|' + row.sucursal_id;
    if (monthStore.has(key)) throw new Error(side + ' has duplicate (mes, sucursal_id) keys');
    monthStore.add(key);
  }
}
function monthlyCoverage(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.mes, (counts.get(row.mes) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

const source = new Client({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 30000 });
const target = new Client({ connectionString: targetUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 30000 });
let sourceTx = false;
let targetTx = false;
try {
  await Promise.all([source.connect(), target.connect()]);
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  sourceTx = true;

  const sourceSchema = await inspectSchema(source);
  assertExactSourceSchema(sourceSchema);
  const [{ rows: sourceRows }, sequenceStateResult] = await Promise.all([
    source.query(rowSql),
    source.query('SELECT last_value::text AS last_value, is_called FROM public.ventas_metas_mensuales_id_seq'),
  ]);
  assertUniqueKeys(sourceRows, 'Neon');
  if (sourceRows.length === 0) throw new Error('Neon source table has no rows; refusing to replace Azure data');
  const sourceSequenceState = sequenceStateResult.rows[0];
  const maximumId = sourceRows.reduce((max, row) => BigInt(row.id) > max ? BigInt(row.id) : max, 0n);
  if (sourceSequenceState.is_called && BigInt(sourceSequenceState.last_value) < maximumId) {
    throw new Error('Neon sequence state is below the highest table id');
  }

  await target.query('BEGIN');
  targetTx = true;
  await target.query("SET LOCAL lock_timeout = '15s'");
  await target.query(`
    CREATE SEQUENCE IF NOT EXISTS ${sequence}
      AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807
      START WITH 1 CACHE 1 NO CYCLE
  `);
  await target.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id bigint NOT NULL DEFAULT nextval('ventas_metas_mensuales_id_seq'::regclass),
      mes date NOT NULL,
      sucursal_id text NOT NULL,
      meta_vin integer NOT NULL,
      source text,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT ventas_metas_mensuales_meta_vin_check CHECK (meta_vin >= 0),
      CONSTRAINT ventas_metas_mensuales_mes_inicio_ck CHECK (mes = date_trunc('month'::text, mes::timestamp with time zone)::date),
      CONSTRAINT ventas_metas_mensuales_pkey PRIMARY KEY (id),
      CONSTRAINT ventas_metas_mensuales_mes_sucursal_uq UNIQUE (mes, sucursal_id)
    )
  `);
  await target.query(`ALTER SEQUENCE ${sequence} OWNED BY ${table}.id`);

  const targetSchema = await inspectSchema(target);
  assertExactSourceSchema(targetSchema);
  assert.deepEqual(targetSchema, sourceSchema, 'Azure table DDL differs from Neon');

  await target.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  const { rows: targetRowsBefore } = await target.query(rowSql);
  assertUniqueKeys(targetRowsBefore, 'Azure');
  const sourceSignatures = sourceRows.map(signature);
  const targetSignaturesBefore = targetRowsBefore.map(signature);
  const sameRows = JSON.stringify(sourceSignatures) === JSON.stringify(targetSignaturesBefore);
  if (!sameRows) {
    await target.query(`DELETE FROM ${table}`);
    if (sourceRows.length) {
      const params = [];
      const tuples = sourceRows.map((row) => {
        const base = params.length;
        params.push(row.id, row.mes, row.sucursal_id, row.meta_vin, row.source, row.created_at, row.updated_at);
        return `($${base + 1}::bigint, $${base + 2}::date, $${base + 3}::text, $${base + 4}::integer, $${base + 5}::text, $${base + 6}::timestamptz, $${base + 7}::timestamptz)`;
      });
      await target.query(
        `INSERT INTO ${table} (id, mes, sucursal_id, meta_vin, source, created_at, updated_at) VALUES ${tuples.join(', ')}`,
        params,
      );
    }
  }

  const { rows: targetRowsAfter } = await target.query(rowSql);
  assertUniqueKeys(targetRowsAfter, 'Azure');
  assert.deepEqual(targetRowsAfter.map(signature), sourceSignatures, 'Azure data does not exactly match Neon');

  const targetSequenceStateResult = await target.query('SELECT last_value::text AS last_value, is_called FROM public.ventas_metas_mensuales_id_seq');
  const targetSequenceState = targetSequenceStateResult.rows[0];
  if (targetSequenceState.last_value !== sourceSequenceState.last_value || targetSequenceState.is_called !== sourceSequenceState.is_called) {
    await target.query('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [sequence, sourceSequenceState.last_value, sourceSequenceState.is_called]);
  }
  const verifiedSequenceState = (await target.query(
    'SELECT last_value::text AS last_value, is_called FROM public.ventas_metas_mensuales_id_seq',
  )).rows[0];
  assert.equal(verifiedSequenceState.last_value, sourceSequenceState.last_value, 'Azure sequence value differs from Neon');
  assert.equal(verifiedSequenceState.is_called, sourceSequenceState.is_called, 'Azure sequence called-state differs from Neon');

  await target.query('COMMIT');
  targetTx = false;
  await source.query('ROLLBACK');
  sourceTx = false;

  const result = {
    status: 'PASS',
    source: 'Neon CIDEF',
    destination: 'Azure PostgreSQL',
    table,
    schema_parity: 'PASS',
    sequence_definition_parity: 'PASS',
    sequence_state_parity: 'PASS',
    source_rows: sourceRows.length,
    azure_rows_before: targetRowsBefore.length,
    azure_rows_after: targetRowsAfter.length,
    row_value_parity: 'PASS',
    key_parity: 'PASS',
    monthly_coverage: monthlyCoverage(sourceRows),
    data_sync: sameRows ? 'NO_CHANGES_NEEDED' : 'TARGET_TABLE_ROWS_REPLACED',
  };
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## SALES targets Neon → Azure\n\nTable: ${table}; DDL: PASS; sequence: PASS; rows: ${sourceRows.length}; row/key parity: PASS; monthly coverage: ${JSON.stringify(result.monthly_coverage)}.\n`);
  }
} catch (error) {
  if (targetTx) await target.query('ROLLBACK').catch(() => {});
  if (sourceTx) await source.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ status: 'FAIL', error: safeError(error) }));
  process.exitCode = 1;
} finally {
  await Promise.all([source.end().catch(() => {}), target.end().catch(() => {})]);
}
