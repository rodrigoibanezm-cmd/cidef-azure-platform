import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadForumDay, SOURCE_COLUMNS } from '../scripts/recover-forum-snapshots-azure.js';

const date = '2026-10-28';
const types = ['COTIZACION', 'PRECURSE', 'CURSE'];
const keyFor = type => `Forum/${{ COTIZACION: 'Cotizacion', PRECURSE: 'Precurse', CURSE: 'Curse' }[type]}_Cidef_20261028.csv`;
function csv(type, { name = 'CLIENTE', duplicate = false, empty = false } = {}) {
  const source = { NumOperacion: '9007199254740993', TipoProceso: 'APROBADA', FechaCotizacion: '28-10-2026',
    NombreCompleto: name, ValorVehiculo: '13990000', MontoFinanciado: '11597989', CantVehiculo: '2',
    FechaPrimeraCuota: '202', UltimoVencimientoNoPagado: '999', FechaCancelacion: '31-12-9999',
    FechaPrecurse: '28-10-2026', FechaCurse: '28-10-2026' };
  const row = SOURCE_COLUMNS[type].map(column => source[column] || '').join(';');
  return Buffer.from([SOURCE_COLUMNS[type].join(';'), ...(empty ? [] : duplicate ? [row, row] : [row])].join('\n'), 'latin1');
}
function blobFixture({ missing, repeated, failDownload, brokenSchema, duplicate, name, empty, subdirectory = false } = {}) {
  const events = [];
  const names = types.filter(type => type !== missing).map(type => subdirectory ? keyFor(type).replace('Forum/', 'Forum/archive/') : keyFor(type));
  if (repeated) names.push(keyFor(repeated).replace('Forum/', 'Forum/archive/'));
  return { events, async *listBlobsFlat(options) {
    assert.deepEqual(options, { prefix: 'Forum/' });
    for (const name of names) yield { name };
  }, getBlobClient(key) {
    const type = types.find(type => path.posix.basename(keyFor(type)) === path.posix.basename(key));
    assert.ok(type);
    return { async getProperties() { events.push('properties:' + type); return { etag: '"version-1"', contentLength: 100 }; },
      async downloadToBuffer(start, end, options) {
        assert.deepEqual(options, { conditions: { ifMatch: '"version-1"' } });
        events.push('download:' + type);
        if (type === failDownload) throw Object.assign(new Error('ETag changed'), { code: 'ConditionNotMet' });
        return type === brokenSchema ? Buffer.from('wrong;header') : csv(type, { name, duplicate: type === duplicate, empty: type === empty });
      } };
  } };
}
const businessKey = row => [row.snapshot_date, row.source_type, BigInt(row.numero_operacion).toString()].join('|');
const businessValue = row => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'loaded_at')
  .map(([key, value]) => [key, value ?? null]).sort(([a], [b]) => a.localeCompare(b))));
function databaseFixture({ failType, differences } = {}) {
  const calls = [], data = new Map([['history', { snapshot_date: '2026-09-29', load_kind: 'DAILY_SNAPSHOT', preserved: true }]]);
  let pending, connected = 0;
  const client = { release() { calls.push('RELEASE'); }, async query(sql, params = []) {
    calls.push(sql);
    if (sql === 'BEGIN') pending = structuredClone(data);
    if (sql.startsWith('INSERT')) {
      if (params[1] === failType) throw new Error('Injected insert failure');
      const columns = sql.match(/\(([^)]+)\) VALUES/)[1].split(',');
      let rowCount = 0;
      for (let offset = 0; offset < params.length; offset += columns.length) {
        const row = Object.fromEntries(columns.map((column, index) => [column, params[offset + index]]));
        const key = businessKey(row);
        if (!pending.has(key)) { pending.set(key, { ...row, loaded_at: 'original ingestion time' }); rowCount++; }
      }
      return { rowCount };
    }
    if (sql.startsWith('WITH expected')) {
      const expected = JSON.parse(params[1]);
      const actual = [...pending.values()].filter(row => row.snapshot_date === params[0]);
      const mismatch = differences ?? (actual.length !== expected.length || expected.some(row =>
        businessValue(row) !== businessValue(pending.get(businessKey(row)) || {})) ? 1 : 0);
      return { rows: [{ differences: mismatch }] };
    }
    if (sql === 'COMMIT') { data.clear(); for (const [key, row] of pending) data.set(key, row); }
    if (sql === 'ROLLBACK') pending = null;
    return { rows: [] };
  } };
  return { data, calls, pool: { async connect() { connected++; return client; } }, get connected() { return connected; } };
}

test('identical replay inserts nothing, retains original timestamps and earlier history', async () => {
  const db = databaseFixture(), container = blobFixture();
  const first = await loadForumDay({ date, pool: db.pool, container });
  assert.equal(first.inserted_rows, 3);
  assert.deepEqual(first.certification.map(source => source.rows), [1, 1, 1]);
  const original = structuredClone([...db.data]);
  const second = await loadForumDay({ date, pool: db.pool, container });
  assert.equal(second.inserted_rows, 0);
  assert.deepEqual([...db.data], original);
  assert.deepEqual(db.data.get('history'), { snapshot_date: '2026-09-29', load_kind: 'DAILY_SNAPSHOT', preserved: true });
  assert.ok(db.calls.indexOf('LOCK TABLE public.forum_funnel_raw IN SHARE ROW EXCLUSIVE MODE') < db.calls.findIndex(sql => sql.startsWith('INSERT')));
  assert.ok(db.calls.findIndex(sql => sql.startsWith('WITH expected')) < db.calls.indexOf('COMMIT'));
  const record = [...db.data.values()].find(row => row.source_type === 'CURSE');
  assert.equal(record.numero_operacion, '9007199254740993');
  assert.equal(record.fecha_primera_cuota, '202');
  assert.equal(record.fecha_cancelacion, '9999-12-31 00:00:00');
});

test('changed payload or source metadata cannot overwrite an existing snapshot', async () => {
  for (const metadata of [false, true]) {
    const db = databaseFixture();
    await loadForumDay({ date, pool: db.pool, container: blobFixture() });
    if (metadata) [...db.data.values()].find(row => row.source_type === 'CURSE').source_file = 'other/original.csv';
    const before = structuredClone([...db.data]);
    await assert.rejects(loadForumDay({ date, pool: db.pool, container: blobFixture({ name: metadata ? 'CLIENTE' : 'CORRECTION' }) }), /content differs/);
    assert.deepEqual([...db.data], before);
    assert.equal(db.calls.at(-2), 'ROLLBACK');
  }
});

test('extra operations and historical-baseline collisions reject the entire day', async () => {
  for (const load_kind of ['DAILY_SNAPSHOT', 'HISTORICAL_BASELINE']) {
    const db = databaseFixture();
    db.data.set('extra', { snapshot_date: date, source_type: 'CURSE', numero_operacion: '777', load_kind });
    const before = structuredClone([...db.data]);
    await assert.rejects(loadForumDay({ date, pool: db.pool, container: blobFixture() }), /content differs/);
    assert.deepEqual([...db.data], before);
  }
});

test('a missing operation is recovered without replacing existing rows', async () => {
  const db = databaseFixture();
  await loadForumDay({ date, pool: db.pool, container: blobFixture() });
  db.data.delete([...db.data.keys()].find(key => key.includes('|PRECURSE|')));
  const result = await loadForumDay({ date, pool: db.pool, container: blobFixture() });
  assert.equal(result.inserted_rows, 1);
  assert.equal(db.data.size, 4);
});

test('third-source insert failure and certification failure roll back all new rows', async () => {
  for (const options of [{ failType: 'CURSE' }, { differences: 2 }]) {
    const db = databaseFixture(options), before = structuredClone([...db.data]);
    await assert.rejects(loadForumDay({ date, pool: db.pool, container: blobFixture() }));
    assert.deepEqual([...db.data], before);
    assert.ok(!db.calls.includes('COMMIT'));
    assert.deepEqual(db.calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  }
});

test('missing/ambiguous files, changed ETag, schema drift and duplicate operations fail before DB access', async () => {
  for (const options of [{ missing: 'PRECURSE' }, { repeated: 'CURSE' }, { failDownload: 'CURSE' },
    { brokenSchema: 'CURSE' }, { duplicate: 'PRECURSE' }]) {
    const db = databaseFixture();
    await assert.rejects(loadForumDay({ date, pool: db.pool, container: blobFixture(options) }));
    assert.equal(db.connected, 0);
    assert.deepEqual(db.calls, []);
  }
});

test('a valid header-only interface is retained as zero rows', async () => {
  const db = databaseFixture();
  const result = await loadForumDay({ date, pool: db.pool, container: blobFixture({ empty: 'PRECURSE' }) });
  assert.deepEqual(result.certification.map(source => source.rows), [1, 0, 1]);
  assert.equal(result.inserted_rows, 2);
});

test('unique files inside Forum subdirectories retain their complete source keys', async () => {
  const db = databaseFixture(), container = blobFixture({ subdirectory: true });
  const connect = db.pool.connect;
  db.pool.connect = async () => {
    assert.equal(container.events.filter(event => event.startsWith('download:')).length, 3);
    return connect();
  };
  const result = await loadForumDay({ date, pool: db.pool, container });
  assert.ok(result.certification.every(source => source.source_file.startsWith('Forum/archive/')));
});

test('invalid dates never reach Blob or PostgreSQL', async () => {
  for (const value of [undefined, '0000-01-01', '2026-02-30', '2026-13-01', '28-10-2026', '2026-10-28 --publish']) {
    const db = databaseFixture(), container = blobFixture();
    await assert.rejects(loadForumDay({ date: value, pool: db.pool, container }));
    assert.equal(db.connected, 0);
    assert.deepEqual(container.events, []);
  }
});

test('CLI rejects missing arguments and non-Azure DB; importing has no execution side effects', () => {
  const script = new URL('../scripts/recover-forum-snapshots-azure.js', import.meta.url);
  for (const args of [[], ['--date', '2026-02-30'], ['--date', date, '--publish']]) {
    const child = spawnSync(process.execPath, [script.pathname, ...args], { env: {}, encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stderr).status, 'FAILED');
  }
  const rejected = spawnSync(process.execPath, [script.pathname, '--date', date], { encoding: 'utf8',
    env: { AZURE_DATABASE_URL: 'postgresql://fixture:password@localhost/fixture' } });
  assert.equal(rejected.status, 1);
  assert.doesNotMatch(rejected.stderr, /password|postgresql:\/\//);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(script.href)})`], { env: {}, encoding: 'utf8' });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout + imported.stderr, '');
});

test('existing empty-manifest invocation remains available without opening PostgreSQL', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forum-source-'));
  try {
    const manifest = path.join(directory, 'manifest.json');
    await writeFile(manifest, '[]');
    const child = spawnSync(process.execPath, [new URL('../scripts/recover-forum-snapshots-azure.js', import.meta.url).pathname, manifest], {
      env: {}, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { status: 'NO_FORUM_SNAPSHOT_FILES_IN_BLOB_MIRROR', files: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
