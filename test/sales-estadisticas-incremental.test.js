import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import XLSX from 'xlsx';
import { run } from '../src/loaders/sales/import-estadisticas-venta.js';
import { quoteIdent } from '../src/loaders/sales/db.js';
import { withSourceContext } from '../src/loaders/sales/source-io.js';

// Opt-in dedicated LOCAL SQL database only. Never use an Azure connection.
// Run alongside the other SALES SQL tests with --test-concurrency=1 because
// each fixture deliberately exercises the importer's real public.ventas_raw.
const connectionString = process.env.SALES_COMPARISON_TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/sales_comparison_test') throw new Error('Importer tests require the dedicated local database');
}
const sqlTest = (name, fn) => test(name, { skip: !connectionString }, fn);
const COLUMNS = [
  'id', 'nro_operacion', 'razon_social', 'cliente', 'ciudad', 'region',
  'articulo', 'desc_articulo', 'nro_vin_chasis', 'nombre_usuario',
  'fecha_factura', 'precio_vta', 'precio_vta_pesos_con_iva',
  'id_sucursal_vta', 'desc_sucursal_vta', 'id_mae_marca', 'desc_mae_marca',
  'id_tipo_operacion', 'desc_tipo_oper', 'nro_propuesta', 'fecha_propuesta',
  'factura', 'nro_factura', 'fecha_eta', 'categoria_cliente', 'entidad_financiera',
  'comision_entidad_finan',
];
// Independent regression fixture for the existing operational-date exceptions.
const AUGUST_VINS = `
LVAV2MAB2TU485673 LGJE5EE01TM514771 LVAV2MAB9TU488506 LGJE5EE09TM529146
LVAV2JVBXTE321994 LGJE5EE06TM521408 LVAV2JVB3TE322341 LVAV2JVB6TE322656
LMXA14AG6VZ352968 LVAV2MAB9TU490143 LVAV2MAB3TU485424 LVAV2MAB8TU490148
LGJE1EE24TM534185 LVAV2AVB3TE354755 LVAV2MAB7TU460042 LVAV2MAB9TU486237
LVAV2AVB2TE222571 LVAV2AVB5TE355163 LVAV2AVB9TE322327 LMXA14AG6VZ352954
LVAV2MAB8TU485435 LVAV2MAB2TU485429 LMXA14AG9VZ357825 LVAV2MAB3TU451953
LVAV2MAB1TU486734 LGJE1EE26TM554003 LVAV2JVB4TE321229 LMXA14AG7VZ357726
LVAV2MAB2TU475726 LVAV2AVBXTE322188 LVAV2MAB6TU486230 LVAV2MAB0TU490144
LVAV2JVBXTE353649 LVAV2MAB1TU486703 LGJE5EE09TM429810 LMXA14AF4VZ354807
LGJE5EE09TM521404 LVAV2JVB2TE321231 LMXA14AG1VZ352943 LMXA14AG7VZ352977
LMXA14AF2VZ354806 LMXA14AG5VZ352931 LGJE1EE22TM554001 LVAV2JVB9TE321906
LVAV2MAB8TU480610 LVAV2AVB4TE321408 LMXA14AF0TZ350217 LGJE5EE00TM529147
LVAV2JVB8TE321413 LVAV2MAB5TU484422`.trim().split(/\s+/);
const SEPTEMBER_VIN = 'LGJE5EE06TM529038';
const sale = (id, vin, changes = {}) => ({ id: String(id), nro_vin_chasis: vin,
  desc_mae_marca: 'DFM', categoria_cliente: 'Cliente General',
  fecha_factura: '2026-10-20', precio_vta: '100.00', ...changes });
const historicalInput = () => [...AUGUST_VINS, SEPTEMBER_VIN].map((vin, i) => sale(i + 1, vin));
const historicalRaw = () => historicalInput().map(row => ({ ...row,
  fecha_factura: row.nro_vin_chasis === SEPTEMBER_VIN ? '2026-09-01' : '2026-08-31' }));
const file = { Key: 'ventas/Estadisticas_de_Venta_por_Vista_2026_10_23.xlsx',
  prefix: 'ventas/Estadisticas_de_Venta_por_Vista_', ETag: '"fixture-v1"', size: 123 };

function workbook(rows, columns = COLUMNS) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    columns, ...rows.map(row => columns.map(name => row[name] ?? null)),
  ]), 'Ventas');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

async function fixture(raw, callback, { constraint = '' } = {}) {
  const client = new pg.Client({ connectionString });
  const statements = [];
  await client.connect();
  let created = false;
  try {
    const type = name => name === 'id' ? 'bigint' : name === 'fecha_factura' ? 'timestamp' :
      name.startsWith('precio_vta') ? 'numeric(16,2)' : 'text';
    await client.query('BEGIN');
    await client.query(`CREATE TABLE public.ventas_raw (${COLUMNS.map(n => `${quoteIdent(n)} ${type(n)}`).join(',')}${constraint})`);
    for (const row of raw) {
      await client.query(`INSERT INTO public.ventas_raw VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(',')})`,
        COLUMNS.map(n => row[n] ?? null));
    }
    await client.query('COMMIT');
    created = true;
    await client.query('BEGIN');
    const executor = { async query(sql, params) {
      statements.push(sql);
      return client.query(sql, params);
    } };
    const importRows = async (rows, options, columns) => {
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
      FROM public.ventas_raw ORDER BY to_jsonb(ventas_raw)::text`, [COLUMNS])).rows;
    const identities = async () => (await client.query('SELECT id::text,ctid::text FROM public.ventas_raw ORDER BY id,ctid')).rows;
    const assertNoStaging = async () => assert.deepEqual((await client.query(
      "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'ventas_raw__loading_%'" )).rows, []);
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
    await callback({ client, statements, importRows, state, identities, assertNoStaging, assertFullParity });
  } finally {
    await client.query('ROLLBACK');
    if (created) await client.query('DROP TABLE public.ventas_raw');
    await client.end();
  }
}

sqlTest('incremental importer publishes additions, deletions and id modifications with exact full-load parity', async () => {
  const raw = historicalRaw();
  raw[0].fecha_factura = '2026-10-01';
  raw.at(-1).fecha_factura = '2026-10-02';
  raw.push(sale(1001, 'SHARED'), sale(1002, 'SHARED'), sale(1003, 'REMOVED'),
    sale(1004, 'HISTORICAL', { fecha_factura: '2021-02-15' }));
  const input = [...historicalInput(), sale(1001, 'SHARED'),
    sale(1002, 'SHARED', { precio_vta: '250.50', nro_factura: 'CORRECTED' }),
    sale(1004, 'HISTORICAL', { fecha_factura: '2020-12-31' }),
    sale(1005, 'NEW', { desc_mae_marca: ' dflm ', fecha_factura: '46315', categoria_cliente: ' Concesionaria ' }),
    sale(2001, 'EXCLUDED-BRAND', { desc_mae_marca: 'OTHER' }),
    sale(2002, 'EXCLUDED-CATEGORY', { categoria_cliente: 'Internal' })];
  await fixture(raw, async ({ importRows, identities, state, statements, assertFullParity, assertNoStaging }) => {
    const before = await identities();
    const result = await importRows(input, { incremental: true });
    assert.equal(result.strategy, 'INCREMENTAL_SNAPSHOT_DIFF');
    assert.equal(result.differentialPublication.verified, true);
    assert.equal(result.differentialPublication.comparison.key.status, 'UNIQUE_NON_NULL');
    assert.deepEqual(result.differentialPublication.applied, { added: 1, removed: 1, modified: 4 });
    assert.equal(result.rowsFinal, historicalInput().length + 4);
    assert.equal(result.rowsExcludedByBrand, 1);
    assert.equal(result.rowsExcludedByCustomerCategory, 1);
    assert.equal(result.operationalDateOverridesApplied, historicalInput().length);
    const after = await identities();
    for (const row of before.filter(r => !['1', String(historicalInput().length), '1002', '1003', '1004'].includes(r.id))) {
      assert.deepEqual(after.find(r => r.id === row.id), row);
    }
    const rows = (await state()).map(r => r.row);
    assert.equal(rows.find(r => r.id === '1').fecha_factura, '2026-08-31 00:00:00');
    assert.equal(rows.find(r => r.nro_vin_chasis === SEPTEMBER_VIN).fecha_factura, '2026-09-01 00:00:00');
    assert.equal(rows.find(r => r.id === '1004').fecha_factura, '2020-12-31 00:00:00');
    assert.equal(rows.find(r => r.id === '1005').desc_mae_marca, 'DFM');
    assert.equal(rows.find(r => r.id === '1005').fecha_factura, '2026-10-20 00:00:00');
    assert.ok(!statements.some(s => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(s)));
    await assertNoStaging();
    await assertFullParity(input);
    statements.length = 0;
    const replayIdentity = await identities();
    const replay = await importRows(input, { incremental: true });
    assert.deepEqual(replay.differentialPublication.applied, { added: 0, removed: 0, modified: 0 });
    assert.deepEqual(await identities(), replayIdentity);
    assert.ok(!statements.some(s => /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:public\.)?"?ventas_raw"?(?=\s|\()/.test(s)));
    await assertNoStaging();
  });
});

sqlTest('duplicate ids and repeated overridden VINs retain multiplicities and match the full snapshot', async () => {
  const duplicate = sale(1001, 'DUPLICATE', { cliente: null });
  const input = [...historicalInput(), { ...historicalInput()[0] }, duplicate, duplicate,
    sale(1002, 'MODIFIED', { precio_vta: '200.00' })];
  await fixture([...historicalRaw(), duplicate, duplicate, duplicate, sale(1002, 'MODIFIED')],
    async ({ importRows, state, assertFullParity, assertNoStaging }) => {
      const result = await importRows(input, { incremental: true });
      assert.equal(result.differentialPublication.comparison.key.status, 'UNRELIABLE');
      assert.equal(result.differentialPublication.comparison.counts.modified, null);
      assert.deepEqual(result.differentialPublication.applied, { added: 2, removed: 2, modified: 0 });
      assert.equal(result.operationalDateOverridesApplied, historicalInput().length + 1);
      const rows = (await state()).map(r => r.row);
      assert.equal(rows.filter(r => r.nro_vin_chasis === 'DUPLICATE').length, 2);
      assert.equal(rows.filter(r => r.nro_vin_chasis === AUGUST_VINS[0] && r.fecha_factura === '2026-08-31 00:00:00').length, 2);
      await assertFullParity(input);
      await assertNoStaging();
    });
});

sqlTest('full publication remains the default and explicit false uses the same path', async () => {
  await fixture([sale(9000, 'OLD')], async ({ importRows, statements, state, assertNoStaging }) => {
    const input = historicalInput();
    const result = await importRows(input);
    assert.equal(result.strategy, 'FULL_SNAPSHOT_REPLACE');
    assert.equal('differentialPublication' in result, false);
    assert.ok(statements.some(s => s === 'DELETE FROM public."ventas_raw"'));
    assert.ok(!statements.some(s => s.startsWith('SAVEPOINT')));
    const expected = await state();
    assert.equal((await importRows(input, { incremental: false })).strategy, 'FULL_SNAPSHOT_REPLACE');
    assert.deepEqual(await state(), expected);
    await assertNoStaging();
  });
});

sqlTest('missing historical VIN fails before RAW comparison/publication even if a duplicate hides the count', async () => {
  await fixture(historicalRaw(), async ({ client, importRows, state, statements, assertNoStaging }) => {
    const before = await state();
    const input = historicalInput();
    input[1] = { ...input[0] };
    await assert.rejects(importRows(input, { incremental: true }), /operational date corrections missing or invalid: LGJE5EE01TM514771/);
    assert.deepEqual(await state(), before);
    assert.ok(!statements.some(s => s.startsWith('SAVEPOINT') || s.includes('EXCEPT ALL')));
    await client.query('ROLLBACK');
    await assertNoStaging();
  });
});

sqlTest('failed incremental insert restores preceding RAW changes and caller rollback removes staging', async () => {
  await fixture([...historicalRaw(), sale(1001, 'SHARED'), sale(1002, 'REMOVED')],
    async ({ client, importRows, state, identities, statements, assertNoStaging }) => {
      const before = await state(), beforeIdentity = await identities();
      const input = [...historicalInput(), sale(1001, 'SHARED', { precio_vta: '200' }),
        sale(1003, 'INVALID', { precio_vta: '-1' })];
      await assert.rejects(importRows(input, { incremental: true }), e => e.code === '23514');
      assert.ok(statements.some(s => s.includes('DELETE FROM public."ventas_raw"')));
      assert.ok(statements.some(s => s.includes('UPDATE public."ventas_raw"')));
      assert.ok(statements.some(s => s.startsWith('ROLLBACK TO SAVEPOINT')));
      assert.deepEqual(await state(), before);
      assert.deepEqual(await identities(), beforeIdentity);
      await client.query('ROLLBACK');
      await assertNoStaging();
    }, { constraint: ', CHECK (precio_vta >= 0)' });
});

sqlTest('empty filtered snapshots and missing required columns never publish RAW', async () => {
  await fixture(historicalRaw(), async ({ importRows, state, statements }) => {
    const before = await state();
    await assert.rejects(importRows([sale(1, 'EXCLUDED', { desc_mae_marca: 'OTHER' })], { incremental: true }), /Empty SALES snapshot blocked/);
    await assert.rejects(importRows(historicalInput(), { incremental: true }, COLUMNS.filter(n => n !== 'id')), /Missing required sales columns: id/);
    assert.deepEqual(statements, []);
    assert.deepEqual(await state(), before);
  });
});

test('incremental requires a boolean, rejecting truthy strings before accessing any source', async () => {
  for (const incremental of ['true', 'false', 1, null, {}]) {
    await assert.rejects(run({ incremental }), /incremental must be a boolean/);
  }
});
