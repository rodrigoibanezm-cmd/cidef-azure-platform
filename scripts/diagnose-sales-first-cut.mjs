// Standalone read-only experiment. This is NOT a certified P1 path.
import { performance } from 'node:perf_hooks';
import { queryDb } from '../lib/neon.js';
import { dataset, field } from '../lib/data-floor/sales/dataset.js';
import { createSalesPreparation } from '../lib/data-floor/sales/preparation.js';
import { loadCommercialIdentityMap, loadHistoricalSalesChannelMap, loadDealerBuyerMap } from '../lib/ventas-commercial/buildVentasCommercialContext.js';
import { loadVentasUniverseResources } from '../lib/ventas-universe/buildVentasUniverse.js';
import { loadSalesAttributes } from '../lib/data-floor/sales/attributes.js';

const filters = {commercial_universe:'OWN_STORES',brand_id:89,model_id:28,
  store_id:4,date_from:'2026-08-01',date_to:'2026-08-31'};
const time = async (name,fn) => {
  const t=performance.now(),value=await fn();
  console.log(name+'_ms='+Math.round(performance.now()-t));
  return value;
};
// Include all accepted date spellings; confirmation belongs to P1's parser.
const month=/^\d{4}-(\d{2})/.exec(filters.date_from)?.[1];
const year=filters.date_from.slice(0,4);
const dateRe='^('+year+'-'+month+'-[0-9]{2}|[0-9]{1,2}/0?'+Number(month)+'/'+year+
  '|[0-9]{1,2}/0?'+Number(month)+'/'+year.slice(2)+')([[:space:]]|$)';
const sql=`
WITH candidate AS MATERIALIZED (
 SELECT DISTINCT btrim(v.nro_vin_chasis) AS vin
 FROM ventas_raw v
 WHERE btrim(v.categoria_cliente) IN ('Cliente General','Concesionaria')
   AND nullif(btrim(v.nro_vin_chasis),'') IS NOT NULL
   AND btrim(v.fecha_factura) ~ $1
   AND (EXISTS (
       SELECT 1 FROM sucursales_master s
       WHERE s.sucursal_id=$2 AND btrim(s.id_sucursal_vta::text)=btrim(v.id_sucursal_vta::text)
     ) OR EXISTS (
       SELECT 1 FROM vehiculo_canonico vc
       WHERE vc.vin=v.nro_vin_chasis AND vc.sucursal_venta_id=$2
     ))
   AND (EXISTS (
       SELECT 1 FROM producto_aliases_v01 a
       JOIN modelos_master_v01 m ON m.modelo_id=a.modelo_id
       WHERE a.estado='RESUELTO' AND a.modelo_id=$3 AND m.marca_id=$4
         AND lower(a.fuente) LIKE 'ventas_raw%'
         AND a.nivel IN ('MODELO','VERSION')
         AND master_norm(v.articulo)=master_norm(a.valor_normalizado)
     ) OR EXISTS (
       SELECT 1 FROM vehiculo_canonico vc
       JOIN versiones_master_v01 ver ON ver.version_id=vc.version_id
       JOIN modelos_master_v01 m ON m.modelo_id=ver.modelo_id
       WHERE vc.vin=v.nro_vin_chasis AND m.modelo_id=$3 AND m.marca_id=$4
     ))
)
SELECT vin FROM candidate`;
const totalStart=performance.now();
const candidates=await time('candidate_sql',()=>queryDb(sql,[dateRe,filters.store_id,filters.model_id,filters.brand_id]));
const candidateVins=new Set(candidates.map(r=>String(r.vin).trim()));
const related=await time('fetch_related_rows',()=>queryDb(
  `SELECT id,nro_operacion,razon_social,cliente,articulo,desc_articulo,
  nro_vin_chasis,nombre_usuario,fecha_factura,precio_vta,precio_vta_pesos_con_iva,
  id_sucursal_vta,desc_sucursal_vta,id_mae_marca,desc_mae_marca,nro_propuesta,
  factura,nro_factura,categoria_cliente,entidad_financiera
  FROM ventas_raw
  WHERE btrim(categoria_cliente) IN ('Cliente General','Concesionaria')
    AND btrim(nro_vin_chasis) = ANY($1::text[])`,[[...candidateVins]]));
const [commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes]=
  await time('identity_resources',()=>Promise.all([
    time('commercial_identity_map',()=>loadCommercialIdentityMap()),
    time('historical_channel_map',()=>loadHistoricalSalesChannelMap()),
    time('dealer_buyer_map',()=>loadDealerBuyerMap()),
    time('universe_resources',()=>loadVentasUniverseResources()),
    time('sales_attributes',()=>loadSalesAttributes())
  ]));
const prepared=await time('candidate_preparation',async()=>createSalesPreparation({
  rows:related,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes
}));
const selective=await time('candidate_full_recognition',()=>dataset({filters},prepared));
const selectiveMs=Math.round(performance.now()-totalStart);
const fullStart=performance.now();
const baseline=await time('full_p1_dataset',()=>dataset({filters}));
const fullMs=Math.round(performance.now()-fullStart);
const signature=row=>JSON.stringify([
  field(row,'vin'),row.source_id,field(row,'sale_date'),field(row,'brand_id'),
  field(row,'model_id'),field(row,'version_id'),field(row,'store_id'),
  field(row,'dealer_id'),field(row,'seller_id'),row.canonical_commercial_universe
].map(v=>v??null));
const expected=new Set(baseline.filtered.map(signature));
const actual=new Set(selective.filtered.map(signature));
const missing=[...expected].filter(v=>!actual.has(v));
const extra=[...actual].filter(v=>!expected.has(v));
console.log(JSON.stringify({case:'FOTON G7 / Pajaritos / agosto 2026',
  candidate_vins:candidateVins.size,related_raw_rows:related.length,
  certified_vins:baseline.filtered.length,selective_vins:selective.filtered.length,
  missing_records:missing.length,extra_records:extra.length,
  missing_examples:missing.slice(0,5),extra_examples:extra.slice(0,5),
  selective_full_pipeline_ms:selectiveMs,full_p1_dataset_ms:fullMs,
  source_coverage_equal:JSON.stringify(selective.u.coverage)===JSON.stringify(baseline.u.coverage),
  caveat:'Selected records and commercial identities compared; global source coverage cannot be certified from a partial source.'},null,2));
if(missing.length||extra.length||selective.filtered.length!==baseline.filtered.length)process.exitCode=1;
