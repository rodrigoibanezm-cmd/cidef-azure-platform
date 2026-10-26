import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { compareTableSnapshot, quoteIdent } from '../src/loaders/sales/db.js';
import { withSourceContext } from '../src/loaders/sales/source-io.js';

// SQL integration tests use only an explicitly supplied, dedicated LOCAL database:
// SALES_COMPARISON_TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/sales_comparison_test
// node --test test/sales-snapshot-comparison.test.js
// Never use AZURE_DATABASE_URL or any production connection as a test fallback.
const connectionString = process.env.SALES_COMPARISON_TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/sales_comparison_test') throw new Error('Comparison tests require the dedicated local database');
}
const sqlTest = (name, fn) => test(name, { skip: !connectionString }, fn);

async function fixture({ tableName = 'ventas_raw', types, raw = [], staged = [], stageNames = Object.keys(types) }, fn) {
  const client = new pg.Client({ connectionString });
  const staging = tableName + '__loading_' + randomUUID().replaceAll('-', '');
  const snapshot = { tableName, staging, columns: Object.keys(types) };
  let created = false;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE public.${quoteIdent(tableName)} (${Object.entries(types).map(([n, t]) => `${quoteIdent(n)} ${t}`).join(',')})`);
    await client.query(`CREATE TABLE public.${quoteIdent(staging)} (${stageNames.map(n => `${quoteIdent(n)} text`).join(',')})`);
    for (const [table, names, rows] of [[tableName, Object.keys(types), raw], [staging, stageNames, staged]]) {
      for (const row of rows) {
        await client.query(`INSERT INTO public.${quoteIdent(table)} (${names.map(quoteIdent).join(',')})
          VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`, row);
      }
    }
    await client.query('COMMIT');
    created = true;
    // An accidental DDL/DML in the comparator fails at PostgreSQL itself.
    await client.query('BEGIN READ ONLY');
    const statements = [];
    const reader = { async query(sql, params) {
      statements.push(sql);
      assert.match(sql.trim(), /^(SELECT|WITH)\b/);
      return client.query(sql, params);
    } };
    const before = (await client.query(`SELECT to_jsonb(t) AS row FROM public.${quoteIdent(tableName)} t`)).rows;
    await withSourceContext({ client: reader }, () => fn(snapshot));
    const after = (await client.query(`SELECT to_jsonb(t) AS row FROM public.${quoteIdent(tableName)} t`)).rows;
    assert.deepEqual(after, before);
    assert.ok(statements.some(sql => sql.includes('EXCEPT ALL')));
  } finally {
    await client.query('ROLLBACK');
    if (created) {
      await client.query(`DROP TABLE public.${quoteIdent(staging)}`);
      await client.query(`DROP TABLE public.${quoteIdent(tableName)}`);
    }
    await client.end();
  }
}

sqlTest('EXCEPT ALL preserves duplicate multiplicities and NULLs in both directions', async () => {
  await fixture({ types: { vin: 'text', state: 'text' },
    raw: [['SAME', null], ['SAME', null], ['OLD', 'sold']],
    staged: [['NEW', 'stock'], ['SAME', null], ['NEW', 'stock'], ['NEW', 'stock']],
  }, async snapshot => {
    const result = await compareTableSnapshot(snapshot);
    assert.deepEqual(result.counts, { raw: 3, staging: 4, unchanged: 1, added: 3, removed: 2, modified: null });
    assert.equal(result.key.status, 'NOT_PROVIDED');
    assert.deepEqual(result.differences.added, Array(3).fill({ vin: 'NEW', state: 'stock' }));
    assert.equal(result.differences.removed.length, 2);
    assert.ok(result.differences.removed.some(r => r.vin === 'SAME' && r.state === null));
    assert.equal(result.hasChanges, true);
  });
});

sqlTest('identical bags in different order have no changes after casting staging to RAW types', async () => {
  await fixture({ types: { id: 'bigint', amount: 'numeric(12,2)', billed_at: 'timestamp' },
    raw: [['1', '10.50', '2026-10-20 00:00:00'], ['1', '10.50', '2026-10-20'], ['2', null, null]],
    staged: [['02', null, null], ['01', '10.5', '2026-10-20'], ['1', '10.500', '2026-10-20 00:00:00']],
  }, async snapshot => {
    const result = await compareTableSnapshot(snapshot);
    assert.deepEqual(result.counts, { raw: 3, staging: 3, unchanged: 3, added: 0, removed: 0, modified: null });
    assert.deepEqual(result.differences, { added: [], removed: [], modified: [] });
    assert.equal(result.hasChanges, false);
  });
});

sqlTest('a validated id pairs modifications while multiple rows may share the same VIN', async () => {
  await fixture({ types: { id: 'bigint', vin: 'text', state: 'text' },
    raw: [['9007199254740993', 'SHARED', 'stock'], ['2', 'SHARED', 'sold'], ['4', 'OLD', 'stock']],
    staged: [['3', 'NEW', 'stock'], ['2', 'SHARED', 'sold'], ['9007199254740993', 'SHARED', 'sold']],
  }, async snapshot => {
    const result = await compareTableSnapshot(snapshot, { keyColumns: ['id'] });
    assert.deepEqual(result.counts, { raw: 3, staging: 3, unchanged: 1, added: 1, removed: 1, modified: 1 });
    assert.equal(result.key.status, 'UNIQUE_NON_NULL');
    assert.deepEqual(result.differences.modified, [{ key: { id: '9007199254740993' },
      before: { id: '9007199254740993', vin: 'SHARED', state: 'stock' },
      after: { id: '9007199254740993', vin: 'SHARED', state: 'sold' } }]);
    assert.equal(result.differences.added[0].id, '3');
    assert.equal(result.differences.removed[0].id, '4');
  });
});

sqlTest('duplicate keys anywhere in a complete input disable modification pairing', async () => {
  await fixture({ types: { id: 'integer', vin: 'text', state: 'text' },
    raw: [[1, 'DUP', 'same'], [2, 'DUP', 'same'], [3, 'OTHER', 'old']],
    staged: [['1', 'DUP', 'same'], ['2', 'DUP', 'same'], ['3', 'OTHER', 'new']],
  }, async snapshot => {
    const result = await compareTableSnapshot(snapshot, { keyColumns: ['vin'] });
    assert.equal(result.key.status, 'UNRELIABLE');
    assert.equal(result.key.raw_duplicate_groups, 1);
    assert.equal(result.key.stage_duplicate_groups, 1);
    assert.deepEqual(result.counts, { raw: 3, staging: 3, unchanged: 2, added: 1, removed: 1, modified: null });
    assert.deepEqual(result.differences.modified, []);
  });
});

sqlTest('a null key prevents pairing even when it occurs only in one input', async () => {
  await fixture({ types: { id: 'integer', state: 'text' }, raw: [[1, 'old']], staged: [['1', 'new'], [null, 'extra']] }, async snapshot => {
    const result = await compareTableSnapshot(snapshot, { keyColumns: ['id'] });
    assert.equal(result.key.status, 'UNRELIABLE');
    assert.equal(result.key.raw_null_rows, 0);
    assert.equal(result.key.stage_null_rows, 1);
    assert.equal(result.counts.modified, null);
    assert.equal(result.counts.added, 2);
    assert.equal(result.counts.removed, 1);
  });
});

sqlTest('composite keys use typed columns, avoiding delimiter collisions', async () => {
  await fixture({ types: { operation: 'text', line: 'text', state: 'text' },
    raw: [['a|b', 'c', 'old'], ['a', 'b|c', 'same']],
    staged: [['a', 'b|c', 'same'], ['a|b', 'c', 'new']],
  }, async snapshot => {
    const result = await compareTableSnapshot(snapshot, { keyColumns: ['operation', 'line'] });
    assert.equal(result.counts.modified, 1);
    assert.equal(result.counts.unchanged, 1);
    assert.deepEqual(result.differences.modified[0].key, { operation: 'a|b', line: 'c' });
  });
});

sqlTest('sample limits do not change totals or consume duplicate occurrences', async () => {
  await fixture({ tableName: 'notas_venta_raw', types: { note: 'text' },
    raw: [['OLD'], ['OLD']], staged: [['NEW'], ['NEW'], ['NEW']],
  }, async snapshot => {
    const result = await compareTableSnapshot(snapshot, { sampleLimit: 1 });
    assert.equal(result.counts.added, 3);
    assert.equal(result.counts.removed, 2);
    assert.deepEqual(result.differences.added, [{ note: 'NEW' }]);
    assert.deepEqual(result.truncated, { added: true, removed: true, modified: false });
    const noSamples = await compareTableSnapshot(snapshot, { sampleLimit: 0 });
    assert.deepEqual(noSamples.counts, result.counts);
    assert.deepEqual(noSamples.differences, { added: [], removed: [], modified: [] });
  });
});

sqlTest('use cleaned staging metadata and leave RAW-only lifecycle fields out of scope', async () => {
  await fixture({ tableName: 'vehiculos_raw', types: { vin: 'text', lifecycle: 'text' }, stageNames: ['vin'],
    raw: [['SAME', 'preserved']], staged: [['SAME']],
  }, async snapshot => {
    const result = await compareTableSnapshot(snapshot, { keyColumns: ['vin'] });
    assert.deepEqual(result.columns, ['vin']);
    assert.equal(result.hasChanges, false);
    assert.equal(result.counts.modified, 0);
    await assert.rejects(compareTableSnapshot(snapshot, { keyColumns: ['lifecycle'] }), /outside staging/);
  });
});

sqlTest('empty input bags compare without changes', async () => {
  await fixture({ types: { id: 'integer' } }, async snapshot => {
    const result = await compareTableSnapshot(snapshot, { keyColumns: ['id'] });
    assert.deepEqual(result.counts, { raw: 0, staging: 0, unchanged: 0, added: 0, removed: 0, modified: 0 });
    assert.equal(result.hasChanges, false);
  });
});

test('reject invalid targets, credit notes and invalid options before issuing any SQL', async () => {
  const snapshot = { tableName: 'ventas_raw', staging: 'ventas_raw__loading_' + 'a'.repeat(32) };
  await withSourceContext({ client: { query() { assert.fail('Unexpected database access'); } } }, async () => {
    for (const invalid of [undefined, { ...snapshot, tableName: 'notas_credito_raw' },
      { ...snapshot, tableName: 'vehiculo_canonico' }, { ...snapshot, staging: 'ventas_raw' },
      { ...snapshot, staging: 'ventas_raw__loading_x; DROP TABLE ventas_raw' }]) {
      await assert.rejects(compareTableSnapshot(invalid), /Invalid SALES comparison/);
    }
    for (const options of [{ sampleLimit: -1 }, { sampleLimit: 1001 }, { sampleLimit: 1.5 },
      { keyColumns: ['id', 'id'] }, { keyColumns: 'id' }, { keyColumns: [null] }]) {
      await assert.rejects(compareTableSnapshot(snapshot, options), /sampleLimit|key columns/);
    }
  });
});

test('missing tables, schema mismatches and unknown key columns fail closed', async () => {
  const snapshot = { tableName: 'ventas_raw', staging: 'ventas_raw__loading_' + 'b'.repeat(32) };
  for (const [metadata, options, error] of [
    [[[], [{ name: 'id', type: 'text' }]], {}, /table missing/],
    [[[{ name: 'id', type: 'integer' }], []], {}, /table missing/],
    [[[{ name: 'id', type: 'integer' }], [{ name: 'unexpected', type: 'text' }]], {}, /schema mismatch/],
    [[[{ name: 'id', type: 'integer' }], [{ name: 'id', type: 'text' }]], { keyColumns: ['vin'] }, /outside staging/],
  ]) {
    let index = 0;
    await withSourceContext({ client: { async query(sql) {
      assert.match(sql, /^SELECT a\.attname/);
      return { rows: metadata[index++] };
    } } }, () => assert.rejects(compareTableSnapshot(snapshot, options), error));
    assert.equal(index, 2);
  }
});
