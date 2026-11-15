// Diagnostic only: compare an early SQL candidate set with certified SALES.
import { performance } from 'node:perf_hooks';
import { queryDb } from '../lib/neon.js';
import { dataset } from '../lib/data-floor/sales/dataset.js';

const period = '2026-08', storeId = 4, brandId = 89, modelId = 28;
const start = period + '-01', end = '2026-09-01', cutoff = '2026-08-31';
const measure = async (label, action) => {
  const before = performance.now();
  const value = await action();
  console.log(label + '_ms=' + Math.round(performance.now() - before));
  return value;
};
const [raw] = await measure('raw_count', () => queryDb(
  `SELECT count(*)::int AS n FROM ventas_raw
   WHERE btrim(categoria_cliente) IN ('Cliente General','Concesionaria')`
));
const candidates = await measure('candidate_query', () => queryDb(
  `SELECT DISTINCT btrim(v.nro_vin_chasis) AS vin
   FROM ventas_raw v
   WHERE btrim(v.categoria_cliente) IN ('Cliente General','Concesionaria')
     AND v.nro_vin_chasis IS NOT NULL
     AND btrim(v.nro_vin_chasis) <> ''
     AND btrim(v.fecha_factura) >= $1
     AND btrim(v.fecha_factura) < $2
     AND (
       EXISTS (
         SELECT 1 FROM sucursales_master sm
         WHERE sm.sucursal_id = $3
           AND btrim(sm.id_sucursal_vta::text) = btrim(v.id_sucursal_vta::text)
       )
       OR EXISTS (
         SELECT 1 FROM vehiculo_canonico vc
         WHERE btrim(vc.vin) = btrim(v.nro_vin_chasis)
           AND vc.sucursal_venta_id = $3
       )
     )`,
  [start, end, storeId]
));
const baseline = await measure('certified_baseline', () => dataset({
  filters: {
    commercial_universe: 'OWN_STORES',
    date_from: start,
    date_to: cutoff,
    store_id: storeId,
    brand_id: brandId,
    model_id: modelId
  }
}));
const normalizeVin = vin => String(vin ?? '').trim().toUpperCase();
const candidateVins = new Set(candidates.map(row => normalizeVin(row.vin)));
const certifiedVins = new Set(baseline.filtered.map(row => normalizeVin(row.vin)));
const missing = [...certifiedVins].filter(vin => !candidateVins.has(vin));
console.log(JSON.stringify({
  test: 'FOTON G7 / Pajaritos / 2026-08',
  raw_rows: raw.n,
  sql_candidate_vins: candidateVins.size,
  certified_vins: certifiedVins.size,
  certified_not_in_sql_candidates: missing.length,
  missing_vin_samples: missing.slice(0, 5),
  note: 'Diagnostic only: SQL candidates are not certified observations.'
}, null, 2));
if (missing.length) process.exitCode = 1;
