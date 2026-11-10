import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnacRvmJson } from '../lib/rvm/anac-json.js';

const sample = {
  id_rvm: 1, MERCADO: 'Livianos y Medianos', ANIO_SOL: '2026', MES: 11,
  DIA_SOL: 7, cantidad: 1, tipo_or: 'AUTO', tipo: 'AUTO',
  descripcion_tipo: 'SUV', descripcion_segmento: 'SUV', MARCA: 'FOTON',
  HOMOLOGADO: 'TEST', modelo_version: 'TEST 1.0', ANIO_FAB: 2026,
  Region: 'RM', combustible: 'DIESEL', pbv: '2500 K', numero_puertas: 4,
  numero_asientos: 5, carga: '.00', comuna_adq: 'SANTIAGO',
  region_propietario: 'Región Metropolitana', prenda: 'NO', vin: '',
  num_chasis: 'L1234567890123456', patente: 'ABCD12', calidad: 'NATURAL',
};
test('ANAC JSON maps to RVM columns without writing to database', () => {
  const parsed = parseAnacRvmJson([sample], { year: 2026 });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.snapshot_date, '2026-11-07');
  assert.equal(parsed.rows[0].modeo_version, 'TEST 1.0');
  assert.equal(parsed.rows[0].n_chasis, sample.num_chasis);
  assert.equal(parsed.rows[0].ano_vin, null);
});
test('ANAC JSON rejects mixed months and duplicate IDs', () => {
  assert.throws(() => parseAnacRvmJson([sample, { ...sample, id_rvm: 2, MES: 10 }]));
  assert.throws(() => parseAnacRvmJson([sample, sample]));
});
test('ANAC JSON excludes other markets', () => {
  const parsed = parseAnacRvmJson([sample, { ...sample, id_rvm: 2, MERCADO: 'Camiones' }]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.excluded_other_markets, 1);
});
