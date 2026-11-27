import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { RAW_VIN_SIGNATURE_SQL, RAW_STATE_SIGNATURE_SQL, captureRawVinDelta } from '../src/loaders/sales/refresh.js';

test('PostgreSQL detects only changed VINs and falls back on unkeyed credit notes', async t => {
  if (!process.env.PG_TEST_DATABASE_URL) return t.skip('Ephemeral PostgreSQL not configured');
  const client = new pg.Client({ connectionString: process.env.PG_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('CREATE TABLE public.vehiculos_raw (vin_chasis text, etapa text)');
    await client.query('CREATE TABLE public.ventas_raw (nro_vin_chasis text, factura text)');
    await client.query('CREATE TABLE public.notas_venta_raw (chasis text, comentario text)');
    await client.query('CREATE TABLE public.notas_credito_raw (n_factura text)');
    await client.query('INSERT INTO vehiculos_raw VALUES ($1,$2)', ['LVAV2JVB4TE322929','STOCK']);
    await client.query('INSERT INTO ventas_raw VALUES ($1,$2)', ['LVAV2JVB4TE322929','100']);
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE sales_raw_vin_before ON COMMIT DROP AS ' + RAW_VIN_SIGNATURE_SQL);
    const execute = async (sql, values=[]) => (await client.query(sql,values)).rows;
    const before = (await execute(RAW_STATE_SIGNATURE_SQL))[0].signature;
    await client.query('UPDATE vehiculos_raw SET etapa=$1 WHERE vin_chasis=$2', ['FACTURADO','LVAV2JVB4TE322929']);
    await client.query('INSERT INTO vehiculos_raw VALUES ($1,$2)', ['LVAV2AVB8TE322187','STOCK']);
    const delta = await captureRawVinDelta(execute);
    assert.deepEqual(delta.changedVins.sort(), ['LVAV2AVB8TE322187','LVAV2JVB4TE322929'].sort());
    assert.equal(delta.requiresFull, false);
    assert.equal(delta.rawBeforeSignature, before);
    assert.equal(delta.rawStateSignature, (await execute(RAW_STATE_SIGNATURE_SQL))[0].signature);
    assert.notEqual(delta.rawStateSignature, delta.rawBeforeSignature);
    await client.query('INSERT INTO notas_credito_raw VALUES ($1)', ['100']);
    const withCredit = await captureRawVinDelta(execute);
    assert.equal(withCredit.requiresFull, true);
    await client.query('ROLLBACK');
  } finally { await client.end(); }
});
