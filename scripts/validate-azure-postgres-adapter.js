import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { queryDb } from '../lib/neon.js';
import { closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';

if (!process.env.AZURE_DATABASE_URL) {
  throw new Error('Missing required secret: AZURE_DATABASE_URL in GitHub Environment Production.');
}

const [adapterSource, postgresSource] = await Promise.all([
  readFile(new URL('../lib/neon.js', import.meta.url), 'utf8'),
  readFile(new URL('../lib/azure-postgres.js', import.meta.url), 'utf8'),
]);

assert.match(adapterSource, /from ['"]\.\/azure-postgres\.js['"]/);
assert.match(postgresSource, /process\.env\.AZURE_DATABASE_URL/);
for (const source of [adapterSource, postgresSource]) {
  assert.doesNotMatch(source, /NEON_DATABASE_URL|@neondatabase\/serverless|neon\.tech/i);
}

const expectedColumns = {
  p3_runs: [
    { name: 'run_id', type: 'text', notNull: true },
    { name: 'created_at', type: 'timestamp with time zone', notNull: true, default: 'now' },
    { name: 'updated_at', type: 'timestamp with time zone', notNull: true, default: 'now' },
    { name: 'parent_run_id', type: 'text', notNull: false },
    { name: 'floor', type: 'text', notNull: false },
  ],
  p3_events: [
    { name: 'event_id', type: 'uuid', notNull: true },
    { name: 'run_id', type: 'text', notNull: true },
    { name: 'sequence_no', type: 'bigint', notNull: true, default: 'sequence' },
    { name: 'tool_name', type: 'text', notNull: true },
    { name: 'status', type: 'text', notNull: true },
    { name: 'input_fingerprint', type: 'text', notNull: true },
    { name: 'output_fingerprint', type: 'text', notNull: false },
    { name: 'input_json', type: 'jsonb', notNull: true },
    { name: 'output_json', type: 'jsonb', notNull: false },
    { name: 'error_code', type: 'text', notNull: false },
    { name: 'duration_ms', type: 'integer', notNull: false },
    { name: 'created_at', type: 'timestamp with time zone', notNull: true, default: 'now' },
    { name: 'floor', type: 'text', notNull: false },
  ],
};

const expectedConstraints = [
  { table: 'p3_runs', type: 'p', columns: ['run_id'] },
  { table: 'p3_runs', type: 'f', columns: ['parent_run_id'], referencedTable: 'p3_runs', referencedColumns: ['run_id'] },
  { table: 'p3_events', type: 'p', columns: ['event_id'] },
  { table: 'p3_events', type: 'f', columns: ['run_id'], referencedTable: 'p3_runs', referencedColumns: ['run_id'] },
];

const expectedIndexes = [
  { table: 'p3_events', name: 'p3_events_run_idx', columns: ['run_id', 'sequence_no'] },
  { table: 'p3_runs', name: 'p3_runs_parent_idx', columns: ['parent_run_id', 'created_at'] },
];

function parsePostgresArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length < 2 || value[0] !== '{' || value.at(-1) !== '}') return null;

  const body = value.slice(1, -1);
  if (body === '') return [];

  const values = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  let wasQuoted = false;
  const pushValue = () => {
    const normalized = wasQuoted ? current : current.trim();
    values.push(!wasQuoted && normalized === 'NULL' ? null : normalized);
    current = '';
    wasQuoted = false;
  };

  for (const character of body) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
      wasQuoted = true;
    } else if (character === ',' && !quoted) {
      pushValue();
    } else {
      current += character;
    }
  }

  if (quoted || escaped) return null;
  pushValue();
  return values;
}

function sameArray(actual, expected) {
  const values = parsePostgresArray(actual);
  return values !== null && values.length === expected.length
    && values.every((value, index) => value === expected[index]);
}

function defaultMatches(actual, expected) {
  if (expected === 'now') return /^now\(\)$/i.test(actual ?? '');
  if (expected === 'sequence') return /^nextval\(/i.test(actual ?? '');
  return true;
}

let client;
let transactionOpen = false;
try {
  const rows = await queryDb('SELECT 1 AS value');
  assert.equal(Number(rows[0]?.value), 1);

  client = await getAzurePool().connect();
  await client.query('BEGIN READ ONLY');
  transactionOpen = true;

  const readOnly = await client.query(
    "SELECT current_setting('transaction_read_only') AS read_only",
  );
  assert.equal(readOnly.rows[0]?.read_only, 'on');

  const permissionResult = await client.query(`
    WITH current_role AS (
      SELECT oid, rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    ),
    settable_roles AS (
      SELECT role_row.*
      FROM pg_roles AS role_row
      WHERE role_row.rolsuper
         OR role_row.rolcreatedb
         OR role_row.rolcreaterole
         OR pg_has_role(current_user, role_row.oid, 'SET')
    ),
    public_database_privileges AS (
      SELECT
        bool_or(acl.privilege_type = 'CONNECT') AS connect,
        bool_or(acl.privilege_type = 'CREATE') AS create_schema,
        bool_or(acl.privilege_type = 'TEMPORARY') AS temporary
      FROM pg_database AS database_row
      CROSS JOIN LATERAL aclexplode(
        COALESCE(database_row.datacl, acldefault('d', database_row.datdba))
      ) AS acl
      WHERE database_row.datname = current_database()
        AND acl.grantee = 0
    ),
    public_schema_privileges AS (
      SELECT
        bool_or(acl.privilege_type = 'USAGE') AS usage,
        bool_or(acl.privilege_type = 'CREATE') AS create_objects
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) AS acl
      WHERE namespace.nspname = 'public'
        AND acl.grantee = 0
    ),
    public_table_privileges AS (
      SELECT count(DISTINCT relation.oid)::integer AS selectable_relations
      FROM pg_class AS relation
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) AS acl
      WHERE relation.relnamespace = 'public'::regnamespace
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND acl.grantee = 0
        AND acl.privilege_type = 'SELECT'
    )
    SELECT
      current_database() AS database_name,
      current_user AS connected_role,
      current_role.rolsuper AS is_superuser,
      current_role.rolcreatedb AS role_can_create_databases,
      current_role.rolcreaterole AS role_can_create_roles,
      current_role.rolinherit AS inherits_role_privileges,
      current_role.rolcanlogin AS can_login,
      current_role.rolbypassrls AS bypasses_row_security,
      EXISTS (
        SELECT 1 FROM settable_roles
        WHERE rolsuper OR rolcreatedb
      ) AS can_create_databases_directly_or_after_set_role,
      EXISTS (
        SELECT 1 FROM settable_roles
        WHERE rolsuper OR rolcreaterole
      ) AS can_create_roles_directly_or_after_set_role,
      COALESCE(public_database_privileges.connect, false) AS public_can_connect_to_current_database,
      COALESCE(public_schema_privileges.usage, false) AS public_has_schema_usage,
      COALESCE(public_schema_privileges.create_objects, false) AS public_has_schema_create,
      COALESCE(public_table_privileges.selectable_relations, 0) AS public_selectable_relations,
      EXISTS (
        SELECT 1 FROM pg_database WHERE datname = 'cidef_staging'
      ) AS cidef_staging_database_exists,
      has_database_privilege(current_user, current_database(), 'CONNECT') AS current_role_can_connect_current_database,
      has_database_privilege(current_user, current_database(), 'CREATE') AS current_role_has_database_create_privilege,
      has_schema_privilege(current_user, 'public', 'USAGE') AS current_role_has_public_schema_usage,
      has_schema_privilege(current_user, 'public', 'CREATE') AS current_role_has_public_schema_create,
      (
        SELECT count(*)::integer
        FROM pg_class AS relation
        WHERE relation.relnamespace = 'public'::regnamespace
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(current_user, relation.oid, 'SELECT')
      ) AS current_role_selectable_relations,
      (
        SELECT COALESCE(json_agg(json_build_object(
          'database', database_row.datname,
          'owner', pg_get_userbyid(database_row.datdba),
          'can_connect', has_database_privilege(current_user, database_row.datname, 'CONNECT')
        ) ORDER BY database_row.datname), '[]'::json)
        FROM pg_database AS database_row
        WHERE database_row.datallowconn
      ) AS database_access,
      (
        SELECT COALESCE(json_agg(json_build_object(
          'role', candidate.rolname,
          'superuser', candidate.rolsuper,
          'createdb', candidate.rolcreatedb,
          'createrole', candidate.rolcreaterole
        ) ORDER BY candidate.rolname), '[]'::json)
        FROM pg_roles AS candidate
        WHERE candidate.rolsuper OR candidate.rolcreatedb OR candidate.rolcreaterole
          AND pg_has_role(current_user, candidate.oid, 'SET')
      ) AS settable_admin_roles
    FROM current_role
    CROSS JOIN public_database_privileges
    CROSS JOIN public_schema_privileges
    CROSS JOIN public_table_privileges
  `);

  const roleMemberships = await client.query(
    'SELECT parent.rolname AS role_name, membership.admin_option ' +
    'FROM pg_auth_members AS membership ' +
    'JOIN pg_roles AS parent ON parent.oid = membership.roleid ' +
    'JOIN pg_roles AS member ON member.oid = membership.member ' +
    'WHERE member.rolname = current_user ' +
    'ORDER BY parent.rolname',
  );

  const permissionReport = {
    ...permissionResult.rows[0],
    direct_role_memberships: roleMemberships.rows,
    isolation_assessment: {
      staging_role_would_inherit_public_connect: permissionResult.rows[0]?.public_can_connect_to_current_database,
      staging_role_would_inherit_public_table_select: Number(permissionResult.rows[0]?.public_selectable_relations ?? 0) > 0,
      production_data_readable_via_public_grants:
        Number(permissionResult.rows[0]?.public_selectable_relations ?? 0) > 0,
    },
  };

  const relations = await client.query(
    "SELECT requested.table_name, relation.oid::text AS relation_oid, namespace.nspname AS schema_name, relation.relkind " +
    "FROM (VALUES ('p3_runs'::text), ('p3_events'::text)) AS requested(table_name) " +
    'LEFT JOIN pg_class AS relation ON relation.oid = to_regclass(requested.table_name)::oid ' +
    'LEFT JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace ' +
    'ORDER BY requested.table_name',
  );

  const matchingRelations = await client.query(
    "SELECT namespace.nspname AS schema_name, relation.relname AS table_name, " +
    "relation.oid::text AS relation_oid, relation.relkind " +
    "FROM pg_class AS relation " +
    "JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace " +
    "WHERE relation.relname = ANY($1::text[]) AND relation.relkind IN ('r', 'p') " +
    "ORDER BY namespace.nspname, relation.relname",
    [['p3_runs', 'p3_events']],
  );

  const relationByName = Object.fromEntries(
    relations.rows.map((row) => [row.table_name, row]),
  );
  const relationIds = matchingRelations.rows.map((row) => row.relation_oid);

  const columnsSql =
    'SELECT namespace.nspname AS schema_name, relation.relname AS table_name, attribute.attname AS column_name, ' +
    'format_type(attribute.atttypid, attribute.atttypmod) AS data_type, ' +
    'attribute.attnotnull AS not_null, pg_get_expr(definition.adbin, definition.adrelid) AS column_default ' +
    'FROM pg_class AS relation ' +
    'JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace ' +
    'JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid ' +
    'LEFT JOIN pg_attrdef AS definition ON definition.adrelid = relation.oid AND definition.adnum = attribute.attnum ' +
    'WHERE relation.oid = ANY($1::oid[]) AND attribute.attnum > 0 AND NOT attribute.attisdropped ' +
    'ORDER BY relation.relname, attribute.attnum';

  const constraintsSql =
    'SELECT namespace.nspname AS schema_name, relation.relname AS table_name, constraint_row.conname AS constraint_name, ' +
    'constraint_row.contype AS constraint_type, referenced_relation.relname AS referenced_table, ' +
    'referenced_namespace.nspname AS referenced_schema, ' +
    '(SELECT array_agg(attribute.attname ORDER BY key_item.ordinality) ' +
    ' FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_item(attnum, ordinality) ' +
    ' JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum = key_item.attnum) AS columns, ' +
    '(SELECT array_agg(attribute.attname ORDER BY key_item.ordinality) ' +
    ' FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_item(attnum, ordinality) ' +
    ' JOIN pg_attribute AS attribute ON attribute.attrelid = referenced_relation.oid AND attribute.attnum = key_item.attnum) AS referenced_columns, ' +
    'pg_get_constraintdef(constraint_row.oid, true) AS definition ' +
    'FROM pg_constraint AS constraint_row ' +
    'JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid ' +
    'JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace ' +
    'LEFT JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_row.confrelid ' +
    'LEFT JOIN pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_relation.relnamespace ' +
    'WHERE relation.oid = ANY($1::oid[]) AND constraint_row.contype IN (\'p\', \'f\') ' +
    'ORDER BY relation.relname, constraint_row.contype, constraint_row.conname';

  const indexesSql =
    'SELECT namespace.nspname AS schema_name, relation.relname AS table_name, index_relation.relname AS index_name, ' +
    'index_row.indisunique AS is_unique, index_row.indisprimary AS is_primary, ' +
    'index_row.indisvalid AS is_valid, access_method.amname AS method, ' +
    '(SELECT array_agg(pg_get_indexdef(index_row.indexrelid, key_position.position, true) ORDER BY key_position.position) ' +
    ' FROM generate_series(1, index_row.indnkeyatts::int) AS key_position(position)) AS columns ' +
    'FROM pg_index AS index_row ' +
    'JOIN pg_class AS relation ON relation.oid = index_row.indrelid ' +
    'JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace ' +
    'JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid ' +
    'JOIN pg_am AS access_method ON access_method.oid = index_relation.relam ' +
    'WHERE relation.oid = ANY($1::oid[]) ' +
    'ORDER BY relation.relname, index_relation.relname';

  const [columnResult, constraintResult, indexResult] = relationIds.length
    ? await Promise.all([
      client.query(columnsSql, [relationIds]),
      client.query(constraintsSql, [relationIds]),
      client.query(indexesSql, [relationIds]),
    ])
    : [{ rows: [] }, { rows: [] }, { rows: [] }];

  const actualColumns = columnResult.rows;
  const actualConstraints = constraintResult.rows;
  const actualIndexes = indexResult.rows;
  const differences = [];

  for (const [table, requiredColumns] of Object.entries(expectedColumns)) {
    const relation = relationByName[table];
    if (!relation?.relation_oid) {
      differences.push({ object: table, expected: 'table visible on search_path', actual: 'missing' });
      continue;
    }
    if (relation.relkind !== 'r') {
      differences.push({ object: table, expected: 'ordinary table', actual: relation.relkind });
    }

    const tableColumns = actualColumns.filter((column) =>
      column.table_name === table && column.schema_name === relation.schema_name,
    );
    const columnsByName = Object.fromEntries(tableColumns.map((column) => [column.column_name, column]));

    for (const expected of requiredColumns) {
      const actual = columnsByName[expected.name];
      if (!actual) {
        differences.push({ object: table + '.' + expected.name, expected, actual: 'missing' });
        continue;
      }
      if (actual.data_type !== expected.type) {
        differences.push({ object: table + '.' + expected.name + '.type', expected: expected.type, actual: actual.data_type });
      }
      if (actual.not_null !== expected.notNull) {
        differences.push({ object: table + '.' + expected.name + '.not_null', expected: expected.notNull, actual: actual.not_null });
      }
      if (expected.default && !defaultMatches(actual.column_default, expected.default)) {
        differences.push({ object: table + '.' + expected.name + '.default', expected: expected.default, actual: actual.column_default });
      }
    }

    const expectedNames = new Set(requiredColumns.map((column) => column.name));
    for (const actual of tableColumns) {
      if (!expectedNames.has(actual.column_name)) {
        differences.push({ object: table + '.' + actual.column_name, expected: 'no additional column', actual: actual.data_type });
      }
    }
  }

  for (const expected of expectedConstraints) {
    const actual = actualConstraints.find((constraint) =>
      constraint.table_name === expected.table
      && constraint.schema_name === relationByName[expected.table]?.schema_name
      && constraint.constraint_type === expected.type
      && sameArray(constraint.columns, expected.columns)
      && (expected.type !== 'f'
        || (constraint.referenced_table === expected.referencedTable
          && sameArray(constraint.referenced_columns, expected.referencedColumns)
          && constraint.referenced_schema === relationByName.p3_runs?.schema_name)),
    );
    if (!actual) {
      differences.push({ object: expected.table + '.constraint', expected, actual: 'missing' });
    }
  }

  for (const expected of expectedIndexes) {
    const actual = actualIndexes.find((index) =>
      index.table_name === expected.table
        && index.schema_name === relationByName[expected.table]?.schema_name
        && index.index_name === expected.name,
    );
    if (!actual) {
      differences.push({ object: expected.table + '.' + expected.name, expected, actual: 'missing' });
      continue;
    }
    const actualColumns = actual.columns?.map((column) => column.replaceAll('"', ''));
    if (!sameArray(actualColumns, expected.columns)
      || actual.is_unique
      || actual.is_primary
      || !actual.is_valid
      || actual.method !== 'btree') {
      differences.push({
        object: expected.table + '.' + expected.name,
        expected: { columns: expected.columns, unique: false, primary: false, valid: true, method: 'btree' },
        actual: {
          columns: actualColumns,
          unique: actual.is_unique,
          primary: actual.is_primary,
          valid: actual.is_valid,
          method: actual.method,
        },
      });
    }
  }

  const extraIndexes = actualIndexes.filter((actual) =>
    !expectedIndexes.some((expected) => expected.table === actual.table_name && expected.name === actual.index_name)
    && !actual.is_primary,
  );

  await client.query('ROLLBACK');
  transactionOpen = false;

  const schemaCheck = {
    status: differences.length === 0 ? 'PASS' : 'FAIL',
    schema_resolution: Object.fromEntries(relations.rows.map((row) => [
      row.table_name,
      row.relation_oid ? { schema: row.schema_name, relkind: row.relkind } : 'missing on search_path',
    ])),
    matching_relations_in_all_schemas: matchingRelations.rows,
    columns: actualColumns,
    keys: actualConstraints,
    required_indexes: expectedIndexes,
    actual_indexes: actualIndexes,
    extra_indexes: extraIndexes,
    differences,
  };

  console.log(JSON.stringify({
    connection: 'PASS',
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    select_1: 'PASS',
    read_only_transaction: 'PASS',
    rollback: 'PASS',
    neon_connection_or_fallback: 'NONE',
    p3_schema: schemaCheck,
  }));

  if (differences.length) process.exitCode = 1;
} finally {
  if (transactionOpen) await client?.query('ROLLBACK').catch(() => {});
  client?.release();
  await closeAzurePool();
}
