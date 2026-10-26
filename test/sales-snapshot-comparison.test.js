import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { compareTableSnapshot, publishTableSnapshotDiff, quoteIdent } from '../src/loaders/sales/db.js';
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

async function fixture({ tableName = 'ventas_raw', types, raw = [], staged = [],
  stageNames = Object.keys(types), readOnly = true, setup = async () => {} }, fn) {
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
    await setup(client, snapshot);
    await client.query('COMMIT');
    created = true;
    // An accidental DDL/DML in the comparator fails at PostgreSQL itself.
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    const statements = [];
    const reader = { async query(sql, params) {
      statements.push(sql);
      if (readOnly) assert.match(sql.trim(), /^(SELECT|WITH)\b/);
      return client.query(sql, params);
    } };
    const before = (await client.query(`SELECT to_jsonb(t) AS row FROM public.${quoteIdent(tableName)} t`)).rows;
    await withSourceContext({ client: reader }, () => fn(snapshot, { client, statements }));
    const after = (await client.query(`SELECT to_jsonb(t) AS row FROM public.${quoteIdent(tableName)} t`)).rows;
    if (readOnly) assert.deepEqual(after, before);
    if (readOnly) assert.ok(statements.some(sql => sql.includes('EXCEPT ALL')));
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
      await assert.rejects(publishTableSnapshotDiff(invalid), /Invalid SALES comparison/);
    }
    for (const options of [{ sampleLimit: -1 }, { sampleLimit: 1001 }, { sampleLimit: 1.5 },
      { keyColumns: ['id', 'id'] }, { keyColumns: 'id' }, { keyColumns: [null] }]) {
      await assert.rejects(compareTableSnapshot(snapshot, options), /sampleLimit|key columns/);
      await assert.rejects(publishTableSnapshotDiff(snapshot, options), /sampleLimit|key columns/);
    }
  });
});

sqlTest('publication updates only changed keys and preserves unchanged row identity and RAW-only fields', async () => {
  await fixture({ readOnly: false,
    types: { id: 'integer PRIMARY KEY', vin: 'text', state: 'text', lifecycle: "text DEFAULT 'new-default'" },
    stageNames: ['id', 'vin', 'state'],
    raw: [[1, 'SHARED', 'stock', 'keep-updated'], [2, 'SHARED', 'sold', 'keep-unchanged'], [4, 'OLD', 'stock', 'old']],
    staged: [['1', 'SHARED', 'sold'], ['2', 'SHARED', 'sold'], ['3', 'NEW', 'stock']],
  }, async (snapshot, { client, statements }) => {
    const before = (await client.query('SELECT ctid::text FROM ventas_raw WHERE id=2')).rows[0].ctid;
    const result = await publishTableSnapshotDiff(snapshot, { keyColumns: ['id'], sampleLimit: 0 });
    assert.deepEqual(result.applied, { added: 1, removed: 1, modified: 1 });
    assert.equal(result.verified, true);
    assert.deepEqual(result.comparison.differences, { added: [], removed: [], modified: [] });
    assert.equal((await client.query('SELECT ctid::text FROM ventas_raw WHERE id=2')).rows[0].ctid, before);
    assert.deepEqual((await client.query('SELECT * FROM ventas_raw ORDER BY id')).rows, [
      { id: 1, vin: 'SHARED', state: 'sold', lifecycle: 'keep-updated' },
      { id: 2, vin: 'SHARED', state: 'sold', lifecycle: 'keep-unchanged' },
      { id: 3, vin: 'NEW', state: 'stock', lifecycle: 'new-default' },
    ]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(snapshot.staging)}`)).rows[0].n, 3);
    assert.ok(statements.some(s => s.startsWith('LOCK TABLE')));
    assert.ok(!statements.some(s => /^(COMMIT|BEGIN|DROP)\b/.test(s)));
    const replay = await publishTableSnapshotDiff(snapshot, { keyColumns: ['id'] });
    assert.deepEqual(replay.applied, { added: 0, removed: 0, modified: 0 });
  });
});

sqlTest('unkeyed publication removes only excess duplicate occurrences, preserves NULLs and writes beyond sample limits', async () => {
  await fixture({ readOnly: false, types: { vin: 'text', state: 'text' },
    raw: [['DUP', null], ['DUP', null], ['DUP', null], ['KEEP', 'same'], ['OLD', 'stock']],
    staged: [['DUP', null], ['KEEP', 'same'], ...Array(105).fill(['NEW', 'stock'])],
  }, async (snapshot, { client }) => {
    const before = (await client.query("SELECT ctid::text FROM ventas_raw WHERE vin='KEEP'")).rows[0].ctid;
    const result = await publishTableSnapshotDiff(snapshot, { sampleLimit: 1 });
    assert.deepEqual(result.applied, { added: 105, removed: 3, modified: 0 });
    assert.equal(result.comparison.differences.added.length, 1);
    assert.equal(result.comparison.truncated.added, true);
    assert.equal((await client.query("SELECT ctid::text FROM ventas_raw WHERE vin='KEEP'")).rows[0].ctid, before);
    assert.deepEqual((await client.query('SELECT vin,state,count(*)::int AS n FROM ventas_raw GROUP BY vin,state ORDER BY vin')).rows,
      [{ vin: 'DUP', state: null, n: 1 }, { vin: 'KEEP', state: 'same', n: 1 }, { vin: 'NEW', state: 'stock', n: 105 }]);
  });
});

sqlTest('an unreliable VIN key falls back to exact multiset deletion and insertion', async () => {
  await fixture({ readOnly: false, types: { id: 'integer', vin: 'text', state: 'text' },
    raw: [[1, 'SHARED', 'old'], [2, 'SHARED', 'same']],
    staged: [['1', 'SHARED', 'new'], ['2', 'SHARED', 'same']],
  }, async snapshot => {
    const result = await publishTableSnapshotDiff(snapshot, { keyColumns: ['vin'] });
    assert.equal(result.comparison.key.status, 'UNRELIABLE');
    assert.deepEqual(result.applied, { added: 1, removed: 1, modified: 0 });
    assert.equal((await compareTableSnapshot(snapshot)).hasChanges, false);
  });
});

sqlTest('identical bags execute no INSERT, UPDATE or DELETE and leave every ctid unchanged', async () => {
  await fixture({ readOnly: false, tableName: 'notas_venta_raw', types: { id: 'integer', state: 'text' },
    raw: [[1, null], [1, null]], staged: [['1', null], ['01', null]],
  }, async (snapshot, { client, statements }) => {
    const before = (await client.query('SELECT ctid::text FROM notas_venta_raw ORDER BY ctid')).rows;
    const result = await publishTableSnapshotDiff(snapshot);
    assert.deepEqual(result.applied, { added: 0, removed: 0, modified: 0 });
    assert.ok(!statements.some(s => /\b(INSERT|UPDATE|DELETE)\b/.test(s)));
    assert.deepEqual((await client.query('SELECT ctid::text FROM notas_venta_raw ORDER BY ctid')).rows, before);
  });
});

sqlTest('a failed UPDATE rolls back preceding DELETEs but preserves earlier caller work and its open transaction', async () => {
  await fixture({ readOnly: false, types: { id: 'integer PRIMARY KEY', amount: 'integer CHECK (amount > 0)' },
    raw: [[1, 10], [2, 20]], staged: [['1', '-1']],
  }, async (snapshot, { client, statements }) => {
    await client.query('INSERT INTO ventas_raw VALUES (3,30)');
    await client.query(`INSERT INTO ${quoteIdent(snapshot.staging)} VALUES ('3','30')`);
    const before = (await client.query('SELECT id,amount,ctid::text FROM ventas_raw ORDER BY id')).rows;
    await assert.rejects(publishTableSnapshotDiff(snapshot, { keyColumns: ['id'] }), e => e.code === '23514');
    assert.ok(statements.some(s => s.includes('DELETE FROM')));
    assert.ok(statements.some(s => s.startsWith('ROLLBACK TO SAVEPOINT')));
    assert.deepEqual((await client.query('SELECT id,amount,ctid::text FROM ventas_raw ORDER BY id')).rows, before);
    await client.query('ROLLBACK');
    assert.deepEqual((await client.query('SELECT id,amount FROM ventas_raw ORDER BY id')).rows, [{ id: 1, amount: 10 }, { id: 2, amount: 20 }]);
  });
});

sqlTest('a failed INSERT rolls back earlier deletes in the unkeyed path', async () => {
  await fixture({ readOnly: false, types: { amount: 'integer CHECK (amount > 0)' }, raw: [[10]], staged: [['-1']] }, async (snapshot, { client }) => {
    await assert.rejects(publishTableSnapshotDiff(snapshot), e => e.code === '23514');
    assert.deepEqual((await client.query('SELECT * FROM ventas_raw')).rows, [{ amount: 10 }]);
  });
});

sqlTest('publication rejects empty staging and calls outside a transaction before writing rows', async () => {
  await fixture({ readOnly: false, types: { id: 'integer' }, raw: [[1]] }, async (snapshot, { client, statements }) => {
    await assert.rejects(publishTableSnapshotDiff(snapshot), /Empty SALES snapshot blocked/);
    assert.ok(!statements.some(s => /\b(INSERT|UPDATE|DELETE)\b/.test(s)));
    await client.query('ROLLBACK');
    await assert.rejects(publishTableSnapshotDiff(snapshot), e => e.code === '25P01');
    assert.deepEqual((await client.query('SELECT * FROM ventas_raw')).rows, [{ id: 1 }]);
  });
});

sqlTest('post-publication parity checks roll back trigger changes even when affected counts match', async () => {
  await fixture({ readOnly: false, types: { id: 'integer', amount: 'integer' },
    raw: [[1, 10]], staged: [['1', '20']],
    setup: async client => {
      await client.query(`CREATE FUNCTION pg_temp.change_amount() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN NEW.amount := NEW.amount + 1; RETURN NEW; END $$`);
      await client.query('CREATE TRIGGER change_amount BEFORE UPDATE ON ventas_raw FOR EACH ROW EXECUTE FUNCTION pg_temp.change_amount()');
    },
  }, async (snapshot, { client }) => {
    await assert.rejects(publishTableSnapshotDiff(snapshot, { keyColumns: ['id'] }), /parity failed/);
    assert.deepEqual((await client.query('SELECT * FROM ventas_raw')).rows, [{ id: 1, amount: 10 }]);
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
