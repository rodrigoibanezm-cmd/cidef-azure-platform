// Standalone read-only experiment. This is NOT a certified P1 path.
import { performance } from 'node:perf_hooks';
import { queryDb } from '../lib/neon.js';
import { semanticSalesCandidates } from './semantic-sales-prototype.mjs';
import { dataset, field } from '../lib/data-floor/sales/dataset.js';
import { createSalesPreparation } from '../lib/data-floor/sales/preparation.js';
import { loadCommercialIdentityMap, loadHistoricalSalesChannelMap, loadDealerBuyerMap } from '../lib/ventas-commercial/buildVentasCommercialContext.js';
import { loadVentasUniverseResources } from '../lib/ventas-universe/buildVentasUniverse.js';
import { loadSalesAttributes } from '../lib/data-floor/sales/attributes.js';
import { customGptDb } from '../lib/custom-gpt/db.js';
import { loadVentasRows } from '../lib/ventas/loadVentasRows.js';

export async function runSalesSelectiveProbe(filters) {
if (!filters || filters.commercial_universe !== 'OWN_STORES' ||
    ![filters.brand_id, filters.model_id, filters.store_id].every(v => Number.isSafeInteger(v) && v > 0) ||
    !/^\d{4}-\d{2}-01$/.test(filters.date_from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(filters.date_to) ||
    filters.date_from.slice(0, 7) !== filters.date_to.slice(0, 7))
  throw new Error('INVALID_PROBE_FILTERS');
const measurements = [];
const size = value => value instanceof Map ? value.size
  : Array.isArray(value) ? value.length : null;
const time = async (name,fn) => {
  const t=performance.now(), cpu=process.cpuUsage(), heap=process.memoryUsage().heapUsed;
  try {
    const value=await fn(), ms=Math.round(performance.now()-t);
    const result={name,ms,rows:size(value),
      cpu_ms:Math.round((process.cpuUsage(cpu).user+process.cpuUsage(cpu).system)/1000),
      heap_delta_mb:Math.round((process.memoryUsage().heapUsed-heap)/1048576)};
    measurements.push(result);
    console.log(name+'_ms='+ms);
    return value;
  } catch(error) {
    console.error(name+'_failed_after_ms='+Math.round(performance.now()-t));
    throw error;
  }
};
// Instrument each existing product/universe SQL query without changing its execution.
const baseDb=customGptDb();
const tracedDb={query:async(sql,params)=>{
  const q=String(sql);
  const name=q.includes('WITH source_skus')?'sql_sku_evidence'
    :q.includes('FROM producto_aliases_v01')?'sql_product_aliases'
    :q.includes('FROM modelos_master_v01')?'sql_model_catalog'
    :q.includes('FROM versiones_master_v01')?'sql_version_catalog'
    :q.includes('FROM sucursales_master')?'sql_org_stores'
    :q.includes('FROM personas_master')?'sql_org_sellers'
    :q.includes('FROM dealers_master')?'sql_org_dealers'
    :q.includes('vendedor_cidef')||q.includes('VENDEDOR_CIDEF')?'sql_seller_membership'
    :'sql_universe_other';
  return time(name,()=>baseDb.query(sql,params));
}};
// Candidate selection belongs to the independent semantic engine.
const totalStart=performance.now();
const candidateResult=await time('candidate_sql',()=>semanticSalesCandidates({
  store_id:filters.store_id,model_id:filters.model_id,brand_id:filters.brand_id,
  year:Number(filters.date_from.slice(0,4)),month:Number(filters.date_from.slice(5,7))
}));
const candidateVins=new Set(candidateResult.vins);
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
    time('universe_resources',()=>loadVentasUniverseResources(tracedDb)),
    time('sales_attributes',()=>loadSalesAttributes())
  ]));
const prepared=await time('candidate_preparation',async()=>createSalesPreparation({
  rows:related,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes
}));
const selective=await time('candidate_full_recognition',()=>dataset({filters},prepared));
const selectiveMs=Math.round(performance.now()-totalStart);
// Break down the baseline into its full raw fetch and complete P1 execution.
const fullRows=await time('full_raw_fetch_standalone',()=>loadVentasRows());
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
const result={case:filters,
  candidate_vins:candidateVins.size,related_raw_rows:related.length,
  full_raw_rows:fullRows.length,
  certified_vins:baseline.filtered.length,selective_vins:selective.filtered.length,
  missing_records:missing.length,extra_records:extra.length,
  missing_examples:missing.slice(0,5),extra_examples:extra.slice(0,5),
  selective_full_pipeline_ms:selectiveMs,full_p1_dataset_ms:fullMs,
  source_coverage_equal:JSON.stringify(selective.u.coverage)===JSON.stringify(baseline.u.coverage),
  resource_sizes:{
    commercial_identity:commercialMap.size,historical_channels:historicalSalesChannelMap.size,
    dealer_buyers:dealerBuyerMap.size,product_aliases:resources.productAliases.length,
    sku_evidence:resources.skuEvidence.length,model_catalog:resources.catalogs.models.size,
    version_catalog:resources.catalogs.versions.size,
    org_stores:resources.organization.stores.size,org_sellers:resources.organization.sellers.size,
    org_dealers:resources.organization.dealers.size,
    sales_colors:attributes.colors.size,sales_stores:attributes.stores.size,
    sales_sellers:attributes.sellers.size
  },
  timings:measurements,
  caveat:'Selected records and commercial identities compared; global source coverage cannot be certified from a partial source.'};
return result;
}

if (process.argv[1]?.endsWith('/diagnose-sales-first-cut.mjs')) {
  const filters=JSON.parse(process.argv[2] || 'null');
  const result=await runSalesSelectiveProbe(filters);
  console.log(JSON.stringify(result,null,2));
  if(result.missing_records||result.extra_records||result.certified_vins!==result.selective_vins)process.exitCode=1;
}
