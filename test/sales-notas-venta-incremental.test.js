import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import XLSX from 'xlsx';
import { run } from '../src/loaders/sales/import-notas-venta.js';
import { quoteIdent } from '../src/loaders/sales/db.js';
import { withSourceContext } from '../src/loaders/sales/source-io.js';

// Opt-in SQL fixtures in a dedicated LOCAL database; never fall back to Azure.
// Run SALES SQL test files with --test-concurrency=1: they use the real RAW names.
const connectionString = process.env.SALES_COMPARISON_TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/sales_comparison_test') throw new Error('Importer tests require the dedicated local database');
}
const sqlTest = (name, fn) => test(name, { skip: !connectionString }, fn);
const COLUMNS = [
  'chasis', 'nro_operacion', 'nota_de_venta', 'fecha_nota_de_venta', 'fecha_creacion_nv',
  'desc_sucursal_vta', 'vendedor', 'tiene_operacion', 'esta_autorizado',
  'esta_pendiente_entrega', 'razon_social', 'cliente', 'region', 'comuna', 'ciudad',
  'email', 'modelo', 'modelo_comercial', 'deposito_unidad', 'desc_mae_marca',
  'factura', 'fecha_factura', 'precio_vta', 'precio_vta_pesos_con_iva', 'reserva',
  'numero_recibo', 'importe', 'etapa', 'entidad_financiera', 'comision_entidad_finan', 'comentario',
];
const NUMERIC = new Set(['precio_vta', 'precio_vta_pesos_con_iva', 'importe', 'comision_entidad_finan']);
const type = name => name.startsWith('fecha_') ? 'timestamp' : NUMERIC.has(name) ? 'numeric(16,2)' : 'text';
const note = (id, changes = {}) => ({
  ...Object.fromEntries(COLUMNS.map(n => [n, n.startsWith('fecha_') ? '2020-05-31' :
    NUMERIC.has(n) ? '100.00' : n + '-' + id])),
  chasis: 'VIN-' + id, nota_de_venta: 'NV-' + id, desc_mae_marca: 'FOTON', ...changes,
});
const file = { Key: 'ventas/Listado_Notas_de_Venta_2026_10_23.xlsx',
  prefix: 'ventas/Listado_Notas_de_Venta_', ETag: '"fixture-v1"', size: 123 };

function workbook(rows, columns) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    columns, ...rows.map(row => columns.map(n => row[n] ?? null)),
  ]), 'Hoja1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

async function fixture(raw, callback, { constraint = '', setup = async () => {} } = {}) {
  const client = new pg.Client({ connectionString });
  const statements = [];
  await client.connect();
  let created = false;
  try {
    const seed = row => client.query(`INSERT INTO public.notas_venta_raw VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(',')})`,
      COLUMNS.map(n => row[n] ?? null));
    await client.query('BEGIN');
    await client.query(`CREATE TABLE public.notas_venta_raw (${COLUMNS.map(n => `${quoteIdent(n)} ${type(n)}`).join(',')}${constraint})`);
    for (const row of raw) await seed(row);
    await setup(client);
    await client.query('COMMIT');
    created = true;
    await client.query('BEGIN');
    const executor = { async query(sql, params) {
      statements.push(sql);
      return client.query(sql, params);
    } };
    const importRows = async (rows, options, columns = COLUMNS) => {
      const buffer = workbook(rows, columns);
      const container = { containerName: 'local-fixture', getBlobClient(key) {
        assert.equal(key, file.Key);
        return { async downloadToBuffer(start, end, options) {
          assert.deepEqual(options, { conditions: { ifMatch: file.ETag } });
          return buffer;
        } };
      } };
      return withSourceContext({ client: executor, container, files: [file] }, () => run(options));
    };
    const state = async () => (await client.query(`SELECT jsonb_object($1::text[],
      ARRAY[${COLUMNS.map(n => quoteIdent(n) + '::text').join(',')}]) AS row
      FROM public.notas_venta_raw ORDER BY to_jsonb(notas_venta_raw)::text`, [COLUMNS])).rows;
    const identities = async () => (await client.query('SELECT to_jsonb(n) AS row,ctid::text FROM public.notas_venta_raw n ORDER BY ctid')).rows;
    const assertNoStaging = async () => assert.deepEqual((await client.query(
      "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'notas_venta_raw__loading_%'" )).rows, []);
    const assertFullParity = async rows => {
      const incremental = await state();
      await client.query('SAVEPOINT full_reference');
      const full = await importRows(rows);
      assert.equal(full.strategy, 'FULL_SNAPSHOT_REPLACE');
      assert.equal('differentialPublication' in full, false);
      assert.deepEqual(await state(), incremental);
      await client.query('ROLLBACK TO SAVEPOINT full_reference');
      await client.query('RELEASE SAVEPOINT full_reference');
    };
    await callback({ client, seed, importRows, state, identities, statements, assertNoStaging, assertFullParity });
  } finally {
    await client.query('ROLLBACK');
    if (created) await client.query('DROP TABLE public.notas_venta_raw');
    await client.end();
  }
}

sqlTest('notes apply additions, deletions, modifications and historical corrections with full-load parity', async () => {
  const keep = note(1), old = note(2, { chasis: keep.chasis, nota_de_venta: keep.nota_de_venta });
  const historical = note(3, { fecha_nota_de_venta: '2020-06-01' });
  const input = [keep, { ...old, esta_autorizado: 'SI', factura: 'F-100', precio_vta: '250.50' },
    { ...historical, fecha_nota_de_venta: '2019-12-31', fecha_creacion_nv: '2019-12-30', comentario: 'retroactive correction' },
    note(5), note(6, { desc_mae_marca: 'OTHER' })];
  await fixture([keep, old, historical, note(4)], async ({ importRows, identities, state, statements, assertFullParity, assertNoStaging }) => {
    const beforeKeep = (await identities()).find(r => r.row.nro_operacion === keep.nro_operacion);
    // The existing header lookup must still work with reordered and extra source columns.
    const result = await importRows(input, { incremental: true }, ['unused_column', ...COLUMNS.toReversed()]);
    assert.equal(result.strategy, 'INCREMENTAL_SNAPSHOT_DIFF');
    assert.equal(result.differentialPublication.verified, true);
    assert.deepEqual(result.differentialPublication.comparison.key, { columns: [], status: 'NOT_PROVIDED' });
    assert.deepEqual(result.differentialPublication.comparison.counts,
      { raw: 4, staging: 4, unchanged: 1, added: 3, removed: 3, modified: null });
    assert.deepEqual(result.differentialPublication.applied, { added: 3, removed: 3, modified: 0 });
    assert.deepEqual(result.keptColumns, COLUMNS);
    assert.equal(result.columnsSource, COLUMNS.length + 1);
    assert.equal(result.rowsExcludedByBrand, 1);
    assert.equal(result.rowsFinal, 4);
    assert.deepEqual((await identities()).find(r => r.row.nro_operacion === keep.nro_operacion), beforeKeep);
    const corrected = (await state()).find(r => r.row.chasis === historical.chasis).row;
    assert.equal(corrected.fecha_nota_de_venta, '2019-12-31 00:00:00');
    assert.equal(corrected.fecha_creacion_nv, '2019-12-30 00:00:00');
    assert.equal(corrected.comentario, 'retroactive correction');
    assert.ok(!statements.some(s => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(s)));
    await assertNoStaging();
    await assertFullParity(input);
  });
});

sqlTest('NULL keys and exact duplicates preserve multiplicities and replay writes no unchanged RAW rows', async () => {
  const duplicate = note(1, { chasis: null, nota_de_venta: null, cliente: null, comentario: null });
  const added = note(2, { chasis: null, nota_de_venta: null });
  const input = [duplicate, added, duplicate, added, note(3), added];
  await fixture([duplicate, duplicate, duplicate, note(3)], async ({ importRows, state, identities, statements, assertFullParity, assertNoStaging }) => {
    const result = await importRows(input, { incremental: true });
    assert.deepEqual(result.differentialPublication.applied, { added: 3, removed: 1, modified: 0 });
    const rows = (await state()).map(r => r.row);
    assert.equal(rows.filter(r => r.nro_operacion === duplicate.nro_operacion).length, 2);
    assert.equal(rows.filter(r => r.nro_operacion === added.nro_operacion).length, 3);
    await assertFullParity(input);
    const beforeReplay = await identities();
    statements.length = 0;
    const replay = await importRows(input.toReversed(), { incremental: true });
    assert.deepEqual(replay.differentialPublication.applied, { added: 0, removed: 0, modified: 0 });
    assert.deepEqual(await identities(), beforeReplay);
    assert.ok(!statements.some(s => /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:public\.)?"?notas_venta_raw"?(?=\s|\()/.test(s)));
    await assertNoStaging();
  });
});

sqlTest('every retained column participates in the differential comparison', async () => {
  const raw = COLUMNS.map((_, i) => note(i + 1));
  const input = raw.map((row, i) => {
    const column = COLUMNS[i];
    return { ...row, [column]: column.startsWith('fecha_') ? '2019-01-01' :
      NUMERIC.has(column) ? '200.50' : column === 'desc_mae_marca' ? 'DFLM' : 'corrected-' + column };
  });
  await fixture(raw, async ({ importRows, assertFullParity, assertNoStaging }) => {
    const result = await importRows(input, { incremental: true });
    assert.deepEqual(result.differentialPublication.applied, { added: COLUMNS.length, removed: COLUMNS.length, modified: 0 });
    assert.deepEqual(result.differentialPublication.comparison.columns, COLUMNS);
    assert.equal(result.columnsFinal, COLUMNS.length);
    await assertFullParity(input);
    await assertNoStaging();
  });
});

sqlTest('default and explicit false retain full publication, all allowed brands and original values', async () => {
  const input = ['DFLM', 'DFM', 'FOTON', 'ZNA', 'ZNA DONGFENG', ' foton ', 'OTHER'].map((brand, i) => note(i, { desc_mae_marca: brand }));
  await fixture([note(99)], async ({ importRows, state, statements, assertFullParity, assertNoStaging }) => {
    const full = await importRows(input);
    assert.equal(full.strategy, 'FULL_SNAPSHOT_REPLACE');
    assert.equal('differentialPublication' in full, false);
    assert.equal(full.rowsLoaded, 7);
    assert.equal(full.rowsFinal, 6);
    assert.equal(full.rowsExcludedByBrand, 1);
    assert.ok(statements.some(s => s === 'DELETE FROM public."notas_venta_raw"'));
    assert.ok(!statements.some(s => s.startsWith('SAVEPOINT')));
    const expected = await state();
    assert.deepEqual(expected.map(r => r.row.desc_mae_marca).sort(), input.slice(0, 6).map(r => r.desc_mae_marca).sort());
    assert.equal((await importRows(input, { incremental: false })).strategy, 'FULL_SNAPSHOT_REPLACE');
    assert.deepEqual(await state(), expected);
    assert.deepEqual((await importRows(input, { incremental: true })).differentialPublication.applied, { added: 0, removed: 0, modified: 0 });
    await assertFullParity(input);
    await assertNoStaging();
  });
});

sqlTest('failed insert restores preceding deletions and earlier caller work remains uncommitted', async () => {
  await fixture([note(1), note(2)], async ({ client, seed, importRows, state, identities, statements, assertNoStaging }) => {
    const original = await state();
    await seed(note(3));
    const before = await state(), beforeIdentity = await identities();
    await assert.rejects(importRows([note(1, { precio_vta: '250' }), note(3), note(4, { precio_vta: '-1' })],
      { incremental: true }), e => e.code === '23514');
    assert.ok(statements.some(s => s.includes('DELETE FROM public."notas_venta_raw"')));
    assert.ok(statements.some(s => s.startsWith('ROLLBACK TO SAVEPOINT')));
    assert.deepEqual(await state(), before);
    assert.deepEqual(await identities(), beforeIdentity);
    await client.query('ROLLBACK');
    assert.deepEqual(await state(), original);
    await assertNoStaging();
  }, { constraint: ', CHECK (precio_vta >= 0)' });
});

sqlTest('post-publication parity failure rolls back trigger changes and caller rollback removes staging', async () => {
  await fixture([note(1)], async ({ client, importRows, state, identities, assertNoStaging }) => {
    const before = await state(), beforeIdentity = await identities();
    await assert.rejects(importRows([note(2)], { incremental: true }), /publication parity failed/);
    assert.deepEqual(await state(), before);
    assert.deepEqual(await identities(), beforeIdentity);
    await client.query('ROLLBACK');
    await assertNoStaging();
  }, { setup: async client => {
    await client.query(`CREATE FUNCTION pg_temp.change_note() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN NEW.comentario := 'trigger-rewritten'; RETURN NEW; END $$`);
    await client.query('CREATE TRIGGER change_note BEFORE INSERT ON public.notas_venta_raw FOR EACH ROW EXECUTE FUNCTION pg_temp.change_note()');
  } });
});

sqlTest('empty filtered snapshots and missing required columns fail before any table writes', async () => {
  await fixture([note(1)], async ({ importRows, state, statements }) => {
    const before = await state();
    await assert.rejects(importRows([note(2, { desc_mae_marca: 'OTHER' })], { incremental: true }), /Empty SALES snapshot blocked/);
    await assert.rejects(importRows([note(2)], { incremental: true }, COLUMNS.filter(n => n !== 'comentario')), /Missing required sales-note columns: comentario/);
    assert.deepEqual(statements, []);
    assert.deepEqual(await state(), before);
  });
});

test('incremental requires an explicit boolean before accessing sources', async () => {
  for (const incremental of ['true', 'false', 1, null, {}]) {
    await assert.rejects(run({ incremental }), /incremental must be a boolean/);
  }
});
