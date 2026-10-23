import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { runSalesRefresh, normalizeDates } from '../src/loaders/sales/refresh.js';
import { requestedDates } from '../scripts/refresh-sales-sources-azure.js';
import { downloadBlobObject, inspectDay, SOURCE_PREFIXES, withSourceContext } from '../src/loaders/sales/source-io.js';
import { parseCreditNoteSnapshot, snapshotDateFromKey } from '../src/loaders/sales/import-notas-credito.js';
import { refreshVehiculoCanonicoV01 } from '../lib/canonical/refresh-vehiculo-canonico-v01.js';

function fixtureContainer({ missing, etag = '"v1"' } = {}) {
  const seen = [];
  return { containerName: 'cidef', seen, getBlobClient(key) {
    return {
      async getProperties() {
        seen.push(key);
        if (key.includes(missing || '__absent__')) throw new Error('Missing fixture');
        return { etag, contentLength: 123, lastModified: new Date('2026-10-23T00:00:00Z') };
      },
      async downloadToBuffer(start, end, options) {
        assert.deepEqual(options, { conditions: { ifMatch: etag } });
        return Buffer.from(key);
      },
    };
  } };
}

function fakeDatabase({ locked = true } = {}) {
  const calls = [], journal = new Map();
  let pending;
  const client = {
    release(error) { calls.push(['release', error]); },
    async query(sql, params = []) {
      calls.push([sql, params]);
      let rows = [];
      if (sql.includes('pg_try_advisory_lock')) rows = [{ locked }];
      if (sql.startsWith('SELECT result')) {
        const result = journal.get(params[0] + ':' + params[1]);
        if (result) rows = [{ result }];
      }
      if (sql.includes('max(source_date)')) rows = [{ date: [...journal.values()].map(r => r.date).sort().at(-1) || null }];
      if (sql.includes('INSERT INTO public.sales_refresh_runs')) {
        pending = { key: params[0] + ':' + params[1], result: JSON.parse(params[4]) };
        rows = [{ changed_vins: 2 }];
      }
      if (sql === 'COMMIT' && pending) { journal.set(pending.key, pending.result); pending = null; }
      if (sql === 'ROLLBACK') pending = null;
      return { rows };
    },
  };
  return { pool: { async connect() { return client; } }, client, calls, journal };
}

function fixtureLoaders(events, failDate) {
  return [0, 1, 2, 3].map(index => async () => {
    const { sourceContext } = await import('../src/loaders/sales/source-io.js');
    const { date } = sourceContext();
    events.push([date, index]);
    if (date === failDate && index === 2) throw new Error('Fixture load failure');
    return { rowsFinal: 1 };
  });
}

test('explicit dates are validated and ranges include every day', () => {
  assert.deepEqual(normalizeDates(['2026-10-23', '2026-10-22']), ['2026-10-22', '2026-10-23']);
  assert.throws(() => normalizeDates(['2026-02-30']));
  assert.throws(() => normalizeDates(['2026-10-23', '2026-10-23']));
  assert.throws(() => requestedDates([]));
  assert.deepEqual(requestedDates(['--from', '2026-10-22', '--to', '2026-10-23']), ['2026-10-22', '2026-10-23']);
});

test('all four sources use the explicit day and downloads are pinned to their ETag', async () => {
  const container = fixtureContainer();
  const files = await inspectDay(container, '2026-10-23');
  assert.deepEqual(container.seen, SOURCE_PREFIXES.map(p => p + '2026_10_23.xlsx'));
  await withSourceContext({ container, files }, async () => {
    assert.equal((await downloadBlobObject(files[0].Key)).toString(), files[0].Key);
    await assert.rejects(downloadBlobObject('ventas/other.xlsx'));
  });
});

test('credit-note parser retains header offsets and source snapshot date', () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Reporte'], ['Tipo', 'Numero', 'Fecha', 'NFactura'], ['NC', '101', '23-10-2026', '999'],
  ]), 'Datos');
  const parsed = parseCreditNoteSnapshot(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(parsed.headerRow, 2);
  assert.deepEqual(parsed.rows, [['NC', '101', '23-10-2026', '999']]);
  assert.equal(snapshotDateFromKey('ventas/NC_DFM_2026_10_23.xlsx'), '2026-10-23');
});

test('days and four imports are sequential; canonical and journal precede each commit; replay skips', async () => {
  const db = fakeDatabase(), events = [];
  const options = { pool: db.pool, container: fixtureContainer(),
    dates: ['2026-10-23', '2026-10-22'], loaders: fixtureLoaders(events),
    refreshCanonical: async ({ execute }) => { events.push('canonical'); await execute('SELECT fixture'); return { ok: true }; } };
  const results = await runSalesRefresh(options);
  assert.deepEqual(events, [
    ['2026-10-22', 0], ['2026-10-22', 1], ['2026-10-22', 2], ['2026-10-22', 3], 'canonical',
    ['2026-10-23', 0], ['2026-10-23', 1], ['2026-10-23', 2], ['2026-10-23', 3], 'canonical',
  ]);
  assert.equal(db.journal.size, 2);
  assert.equal(results[1].changedVins, 2);
  const sql = db.calls.map(c => c[0]);
  assert.equal(sql.filter(s => s === 'COMMIT').length, 2);
  assert.ok(sql.indexOf('SELECT fixture') < sql.indexOf('COMMIT'));
  events.length = 0;
  const replay = await runSalesRefresh(options);
  assert.deepEqual(events, []);
  assert.ok(replay.every(r => r.status === 'ALREADY_LOADED'));
});

test('a failed day rolls back and blocks subsequent days, keeping earlier completed days', async () => {
  const db = fakeDatabase(), events = [], canonicalDates = [];
  await assert.rejects(runSalesRefresh({ dates: ['2026-10-21', '2026-10-22', '2026-10-23'],
    pool: db.pool, container: fixtureContainer(), loaders: fixtureLoaders(events, '2026-10-22'),
    refreshCanonical: async () => { canonicalDates.push('called'); return {}; },
  }), error => error.sourceDate === '2026-10-22' && error.completedDates[0] === '2026-10-21');
  assert.equal(db.journal.size, 1);
  assert.equal(canonicalDates.length, 1);
  assert.equal(db.calls.filter(([sql]) => sql === 'ROLLBACK').length, 1);
  assert.ok(!events.some(e => e[0] === '2026-10-23'));
  assert.ok(db.calls.some(([sql]) => sql.includes('pg_advisory_unlock')));
});

test('missing sources and concurrent runs do not start a transaction', async () => {
  for (const options of [{ container: fixtureContainer({ missing: 'NC_DFM' }) }, { locked: false }]) {
    const db = fakeDatabase(options);
    await assert.rejects(runSalesRefresh({ dates: ['2026-10-23'], pool: db.pool,
      container: options.container || fixtureContainer() }));
    assert.ok(!db.calls.some(([sql]) => sql === 'BEGIN'));
    assert.equal(db.calls.at(-1)[0], 'release');
  }
});

test('canonical failure rolls back the entire day and creates no success marker', async () => {
  const db = fakeDatabase();
  await assert.rejects(runSalesRefresh({ dates: ['2026-10-23'], pool: db.pool,
    container: fixtureContainer(), loaders: fixtureLoaders([]),
    refreshCanonical: async () => { throw new Error('Canonical fixture failure'); },
  }));
  assert.equal(db.journal.size, 0);
  assert.ok(db.calls.some(([sql]) => sql === 'ROLLBACK'));
});

test('canonical writes still require an explicit transaction executor', async () => {
  await assert.rejects(refreshVehiculoCanonicoV01({ dry_run: false }), /transaction-scoped/);
});

test('the reused canonical updater forwards every helper to the injected executor', async () => {
  const statements = [];
  const result = await refreshVehiculoCanonicoV01({ dry_run: false, execute: async sql => {
    statements.push(sql);
    if (sql.includes('AS duplicate_valid_rows')) return [{ duplicate_valid_rows: 0, unrecoverable_etapa_rows: 0 }];
    if (sql.includes('AS valid_raw_vins')) return [{ valid_raw_vins: 0, canonical_rows: 0 }];
    if (sql.includes('AS integridad_tienda_fallida')) return [{ integridad_tienda_fallida: 0, integridad_dealer_fallida: 0 }];
    if (sql.includes('SELECT id, nro_vin_chasis')) return [];
    return [{}];
  } });
  assert.equal(result.dry_run, false);
  assert.ok(statements.some(sql => sql.includes('INSERT INTO public.vehiculo_canonico')));
  assert.ok(statements.some(sql => sql.includes('UPDATE vehiculo_canonico vc')));
  assert.ok(statements.some(sql => sql.includes('resolution_status')));
});
