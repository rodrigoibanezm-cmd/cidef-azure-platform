import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleChangesSql } from '../src/loaders/sales/import-vehiculos.js';

test('inventory delta uses VIN matching and typed null-safe comparisons', () => {
  const sql = vehicleChangesSql('vehiculos_raw__loading_example', [
    { name: 'vin_chasis', type: 'text' },
    { name: 'fecha_factura', type: 'timestamp without time zone' },
    { name: 'vigente', type: 'text' },
  ]);
  assert.match(sql, /array_agg\(DISTINCT upper\(btrim\(s\.vin_chasis\)\)\)/);
  assert.match(sql, /LEFT JOIN public\.vehiculos_raw v/);
  assert.match(sql, /upper\(btrim\(v\.vin_chasis\)\)=upper\(btrim\(s\.vin_chasis\)\)/);
  assert.match(sql, /v\.vin_chasis IS NULL OR/);
  assert.match(sql, /v\."fecha_factura" IS DISTINCT FROM s\."fecha_factura"::timestamp without time zone/);
  assert.match(sql, /v\."vigente" IS DISTINCT FROM s\."vigente"::text/);
  assert.doesNotMatch(sql, /DELETE|UPDATE|INSERT/);
});

test('delta fails closed without VIN identity and quotes staging identifiers', () => {
  assert.throws(() => vehicleChangesSql('stage', [{ name: 'vigente', type: 'text' }]), /VIN column required/);
  assert.match(vehicleChangesSql('a"b', [{ name: 'vin_chasis', type: 'text' }]), /FROM "a""b" s/);
});
