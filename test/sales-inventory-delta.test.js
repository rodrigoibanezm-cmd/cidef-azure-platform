import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleChangesSql } from '../src/loaders/sales/import-vehiculos.js';
import { commitTableSnapshot } from '../src/loaders/sales/db.js';
import { withSourceContext } from '../src/loaders/sales/source-io.js';

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

async function runVehicleMerge({ duplicates = false, incomplete = false } = {}) {
  const statements = [];
  const client = { async query(sql, params = []) {
    statements.push(sql);
    if (sql.includes('FROM pg_attribute')) {
      const columns = [
        {name:'vin_chasis',type:'text'}, {name:'numero_factura',type:'text'},
        {name:'fecha_factura',type:'timestamp without time zone'},
      ];
      return {rows:params[0]?.includes('loading') && incomplete ? columns.slice(0,2) : columns};
    }
    if (sql.includes('AS stage_duplicates')) {
      return {rows:[{stage_duplicates:duplicates?1:0,target_duplicates:0}]};
    }
    return {rows:[]};
  }};
  await withSourceContext({client}, () => commitTableSnapshot({
    tableName:'vehiculos_raw',staging:'vehiculos_raw__loading_example',
  }));
  return statements;
}

test('vehicle RAW merge changes only mismatched VINs and inserts new VINs', async () => {
  const statements=await runVehicleMerge();
  const update=statements.find(s=>s.startsWith('UPDATE public.vehiculos_raw t SET'));
  assert.ok(update);
  assert.match(update,/upper\(btrim\(t\.vin_chasis\)\) = upper\(btrim\(s\.vin_chasis\)\)/);
  assert.match(update,/IS DISTINCT FROM/);
  assert.match(update,/timestamp without time zone/);
  assert.ok(statements.some(s=>s.startsWith('INSERT INTO public.vehiculos_raw') && s.includes('NOT EXISTS')));
  assert.ok(statements.some(s=>s.includes('DELETE FROM public.vehiculos_raw WHERE nullif(btrim(vin_chasis)')));
  assert.ok(!statements.some(s=>s.trim()==='DELETE FROM public.vehiculos_raw'));
});

test('duplicate or incomplete vehicle snapshots retain the previous safe replacement', async () => {
  for(const options of [{duplicates:true},{incomplete:true}]) {
    const statements=await runVehicleMerge(options);
    assert.ok(statements.some(s=>s.trim()==='DELETE FROM public.vehiculos_raw'));
    assert.ok(!statements.some(s=>s.startsWith('UPDATE public.vehiculos_raw t SET')));
  }
});
