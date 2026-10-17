import { buildVentasUniverse } from '../ventas-universe/buildVentasUniverse.js';
import { buildVentasHistoricalTimeline } from '../ventas-universe/buildVentasHistoricalTimeline.js';
import { calculateDailyCloseBacktestContextFromTimeline } from '../motors/daily-close-backtest-context-v01.js';
import { commercialMonthForDate, commercialMonthDays, commercialDateForDay } from '../ventas/commercialMonth.js';
import { queryDb } from '../neon.js';
import { buildProductModelResolutionMap } from '../product-model-resolution/buildResolutionMap.js';
import { resolveSaleModel } from '../product-model-resolution/resolveSalesModels.js';
import { normalizeProductKey } from '../product-model-resolution/normalize.js';
import { enrichRecognizedSale } from '../ventas-org/enrichRecognizedSales.js';

import { DATA_SOURCE, CERTIFIER_VERSION, PERIOD_CLOSE_HISTORY_POLICY_V01, FIELDS, MEASURES, DIMENSIONS } from './sales/contract.js';
import { normalizeNetworkCategory } from './sales/network.js';
import { unsupportedSalesIdentifier } from './sales/errors.js';
import { saleDate, evidenceId, vehicleColorMap, field, match, normalize, dataset, quality, dimensions, temporal } from './sales/dataset.js';
export { DATA_SOURCE, CERTIFIER_VERSION, PERIOD_CLOSE_HISTORY_POLICY_V01, describeSales } from './sales/contract.js';

export async function inspectSales(input={}){
  const {q,u,base,filtered}=await dataset(input);const distinct=(key)=>new Set(filtered.map(r=>field(r,key)).filter(v=>v!=null).map(String)).size;
  return {source:DATA_SOURCE,operation:'INSPECT',filters:q.filters,size:{source_n:base.length,filtered_n:filtered.length},shape:{distinct_vin:distinct('vin'),distinct_brand:distinct('brand_id'),distinct_model:distinct('model_id'),distinct_store:distinct('store_id'),distinct_seller:distinct('seller_id')},quality:quality(u),lineage:u.lineage};
}
export async function fetchSales(input={}){
  const fields=input.fields?.length?input.fields:FIELDS;const bad=fields.find(k=>!FIELDS.includes(k));if(bad)throw unsupportedSalesIdentifier('FIELD',bad,FIELDS);
  const {q,u,base,filtered}=await dataset(input);
  const rows=filtered.map(row=>Object.fromEntries(fields.map(k=>[k,field(row,k)])));
  return {source:DATA_SOURCE,operation:'FETCH',dataset:'SALES_WORK',version:CERTIFIER_VERSION,filters:q.filters,grain:'RECOGNIZED_SALE',size:{source_n:base.length,filtered_n:rows.length},rows,quality:quality(u),lineage:u.lineage};
}
export async function observeSales(input={}){
  const measureId=String(input.measure??'VIN_SALES').toUpperCase();const measure=MEASURES[measureId];if(!measure)throw unsupportedSalesIdentifier('MEASURE',measureId,Object.keys(MEASURES));
  const period=input.period==null?null:String(input.period);
  const scopedInput=period?{...input,filters:{...(input.filters??{}),date_from:commercialDateForDay(period,1),date_to:commercialDateForDay(period,commercialMonthDays(period))}}:input;
  const {q,u,base,filtered}=await dataset(scopedInput);
  const contract={source:DATA_SOURCE,certifier_version:CERTIFIER_VERSION,measure:measureId,filters:q.filters};
  return {
    evidence_id:evidenceId(contract),evidence_contract:'p1.quantitative_observation',evidence_version:'0.1.0',
    authority:'P1_CERTIFIED',status:'CERTIFIED',source:DATA_SOURCE,operation:'OBSERVE',
    grain:'FILTERED_SALES_UNIVERSE',measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{commercial_universe:q.commercial_universe},dimensions:dimensions(q.filters),temporal:temporal(q.filters),
    coverage:{source_n:base.length,filtered_n:filtered.length,quality:quality(u)},
    payload:{value:filtered.length},
    lineage:{...u.lineage,certifier:'salesCertifier',certifier_version:CERTIFIER_VERSION,source_dataset:'SALES_WORK',source_filters:q.filters},
  };
}


function monthFromInput(input={}){
  const explicit=input.period ?? input.filters?.period ?? null;
  const cutoff=input.cutoff ?? input.filters?.date_to ?? null;
  return explicit ? String(explicit) : cutoff ? commercialMonthForDate(String(cutoff).slice(0,10)) : null;
}
async function latestCertifiedPeriodCutoff(period){
  const start=commercialDateForDay(period,1), end=commercialDateForDay(period,commercialMonthDays(period));
  const u=await buildVentasUniverse({commercial_universe:'COMPANY'});
  const dates=(u.analytical_events??[]).map(saleDate).filter(d=>d&&d>=start&&d<=end).sort();
  if(!dates.length)throw new Error('NO_CERTIFIED_DATA_IN_PERIOD');
  return dates.at(-1);
}
async function resolvePeriodCutoff(input,period){
  const explicit=input.cutoff??input.filters?.date_to??null;
  return explicit==null?{cutoff:await latestCertifiedPeriodCutoff(period),resolution:'LATEST_CERTIFIED_AVAILABLE'}:{cutoff:String(explicit).slice(0,10),resolution:'EXPLICIT'};
}
function evidenceEnvelope(contract, shape, extra={}){
  return {
    evidence_id:evidenceId(contract),
    evidence_contract:'p1.'+String(shape).toLowerCase(),
    evidence_version:'0.1.0',
    authority:'P1_CERTIFIED',status:'CERTIFIED',source:DATA_SOURCE,operation:'OBSERVE',
    ...extra,
  };
}
async function observeCumulativePeriod(input,measure){
  const period=monthFromInput(input);if(!period)throw new Error('PERIOD_REQUIRED');
  normalize(input);
  const {cutoff,resolution:cutoffResolution}=await resolvePeriodCutoff(input,period);
  if(commercialMonthForDate(cutoff)!==period)throw new Error('CUTOFF_OUTSIDE_PERIOD');
  const filters={...(input.filters??{}),date_from:commercialDateForDay(period,1),date_to:cutoff};
  delete filters.period;
  const observed=await observeSales({measure:measure.id,filters});
  const contract={shape:'CUMULATIVE_PERIOD_OBSERVATION',measure:measure.id,period,cutoff,filters};
  return evidenceEnvelope(contract,'CUMULATIVE_PERIOD_OBSERVATION',{
    grain:observed.grain,measure:observed.measure,universe:observed.universe,dimensions:observed.dimensions,
    temporal:{period_identity:period,period_type:'COMMERCIAL_MONTH',cutoff,cutoff_resolution:cutoffResolution,date_from:filters.date_from,date_to:cutoff,date_semantics:'fecha_factura'},
    coverage:observed.coverage,payload:{observed_value:observed.payload.value},lineage:observed.lineage,
  });
}
function observePeriodCalendar(input,measure){
  const period=monthFromInput(input);if(!period)throw new Error('PERIOD_REQUIRED');
  const days=commercialMonthDays(period);
  const eligible=Array.from({length:days},(_,i)=>commercialDateForDay(period,i+1));
  const contract={shape:'PERIOD_CALENDAR',measure:measure.id,period};
  return evidenceEnvelope(contract,'PERIOD_CALENDAR',{
    grain:'COMMERCIAL_MONTH',measure:{id:measure.id,unit:measure.unit},universe:{},dimensions:{},
    temporal:{period_identity:period,period_type:'COMMERCIAL_MONTH',close_boundary:eligible.at(-1)},
    coverage:{eligible_days:eligible.length},payload:{eligible_observation_days:eligible,close_boundary:eligible.at(-1)},
    lineage:{calendar:'commercialMonth.js',calendar_semantics:'commercial month currently maps one-to-one to calendar month'},
  });
}
function monthSequence(from,to){
  if(!/^\d{4}-\d{2}$/.test(String(from||''))||!/^\d{4}-\d{2}$/.test(String(to||'')))throw new Error('INVALID_PERIOD_RANGE');
  const [fy,fm]=String(from).split('-').map(Number),[ty,tm]=String(to).split('-').map(Number);
  if(fm<1||fm>12||tm<1||tm>12)throw new Error('INVALID_PERIOD_RANGE');
  const out=[];let y=fy,m=fm;
  while(y<ty||(y===ty&&m<=tm)){out.push(`${y}-${String(m).padStart(2,'0')}`);m++;if(m===13){m=1;y++;}if(out.length>240)throw new Error('PERIOD_RANGE_TOO_LARGE');}
  if(!out.length)throw new Error('INVALID_PERIOD_RANGE');
  return out;
}
async function observePeriodObservationSeries(input,measure){
  const from=String(input.period_from??'');const to=String(input.period_to??'');const periods=monthSequence(from,to);
  const baseFilters={...(input.filters??{})};delete baseFilters.date_from;delete baseFilters.date_to;delete baseFilters.period;
  const observations=[];
  for(const period of periods){
    const filters={...baseFilters,date_from:commercialDateForDay(period,1),date_to:commercialDateForDay(period,commercialMonthDays(period))};
    const observed=await observeSales({measure:measure.id,filters});
    observations.push({period_identity:period,value:observed.payload.value,evidence_id:observed.evidence_id});
  }
  const universe=String(baseFilters.commercial_universe??input.commercial_universe??'COMPANY').toUpperCase();
  const contract={shape:'PERIOD_OBSERVATION_SERIES',measure:measure.id,period_from:from,period_to:to,filters:baseFilters};
  return evidenceEnvelope(contract,'PERIOD_OBSERVATION_SERIES',{
    grain:'COMMERCIAL_MONTH',measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{commercial_universe:universe},dimensions:dimensions(baseFilters),
    temporal:{period_type:'COMMERCIAL_MONTH',period_from:from,period_to:to,ordering:'ASCENDING'},
    coverage:{requested_periods:periods.length,observed_periods:observations.length,gaps:[]},
    payload:{observations},
    lineage:{certifier:'salesCertifier',certifier_version:CERTIFIER_VERSION,source_dataset:'SALES_WORK',component_evidence_ids:observations.map(x=>x.evidence_id)},
  });
}
async function observeDimensionalQuantitativeDataset(input,measure){
  const dimension=String(input.dimension??'').toUpperCase();
  const config=DIMENSIONS[dimension];
  if(!config)throw new Error('UNSUPPORTED_DIMENSIONAL_DATASET_DIMENSION: '+dimension);
  const period=input.period==null?null:String(input.period);
  const scopedInput={...input,filters:{...(input.filters??{})}};
  if(period){
    if(scopedInput.filters.date_from!=null||scopedInput.filters.date_to!=null)throw new Error('DIMENSION_PERIOD_DATE_CONFLICT');
    const {cutoff}=await resolvePeriodCutoff(input,period);
    if(commercialMonthForDate(cutoff)!==period)throw new Error('CUTOFF_OUTSIDE_PERIOD');
    scopedInput.filters.date_from=commercialDateForDay(period,1);
    scopedInput.filters.date_to=cutoff;
  }
  const {q,u,base,filtered}=await dataset(scopedInput);
  // Recognition deliberately projects a fixed sale shape. Read the source field
  // by its chosen row id only for NETWORK; do not re-recognize or infer a channel.
  let networkCategories=new Map();
  if(dimension==='NETWORK'){
    const sourceIds=[...new Set(filtered.map(row=>row.source_id).filter(id=>id!=null).map(String))];
    if(sourceIds.length){
      const rows=await queryDb(`SELECT id AS source_id, categoria_cliente FROM ventas_raw WHERE id = ANY($1::text[])`,[sourceIds]);
      networkCategories=new Map(rows.map(row=>[String(row.source_id),row.categoria_cliente]));
    }
  }
  const modelLabels=new Map((u.resolution_resources?.model_catalog??[]).map(row=>[String(row.modelo_id),row.modelo??null]));
  const counts=new Map(),labels=new Map();let unresolved=0;
  for(const row of filtered){
    const id=dimension==='NETWORK'?networkCategories.get(String(row.source_id)):field(row,config.field);
    if(id==null){unresolved++;continue;}
    const key=dimension==='NETWORK'
      ? normalizeNetworkCategory(id)
      : String(id);
    if(key==null){unresolved++;continue;}
    counts.set(key,(counts.get(key)??0)+1);
    const label=dimension==='NETWORK' ? key : config.field==='model_id'?modelLabels.get(key):field(row,config.label_field);
    if(label!=null&&!labels.has(key))labels.set(key,label);
  }
  const members=[...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true})).map(([member_id,value])=>({member_id,member_label:labels.get(member_id)??null,value}));
  if(unresolved>0)members.push({member_id:'UNRESOLVED',member_label:'No resuelto',value:unresolved});
  const resolved=filtered.length-unresolved;
  const contract={shape:'DIMENSIONAL_QUANTITATIVE_DATASET',measure:measure.id,dimension,period,filters:q.filters};
  return evidenceEnvelope(contract,'DIMENSIONAL_QUANTITATIVE_DATASET',{
    grain:'FILTERED_SALES_UNIVERSE',measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{commercial_universe:q.commercial_universe},dimensions:dimensions(q.filters),temporal:{...temporal(q.filters),period_identity:period,period_type:period?'COMMERCIAL_MONTH':null,cutoff:period?q.filters.date_to:null,cutoff_resolution:period?(input.cutoff==null&&input.filters?.date_to==null?'LATEST_CERTIFIED_AVAILABLE':'EXPLICIT'):null},
    coverage:{source_n:base.length,filtered_n:filtered.length,dimension_resolved_n:resolved,dimension_unresolved_n:unresolved,dimension_resolution_rate:filtered.length?resolved/filtered.length:null,quality:quality(u)},
    payload:{dimension:{id:dimension,identity_contract:config.identity_contract,identity_version:config.identity_version,unresolved_member_policy:'EXPLICIT_UNRESOLVED_MEMBER'},members},
    lineage:{...u.lineage,certifier:'salesCertifier',certifier_version:CERTIFIER_VERSION,source_dataset:'SALES_WORK',source_filters:q.filters,dimension_identity:config.identity_contract},
  });
}

function shiftMonth(period,delta){
  const m=/^(\d{4})-(\d{2})$/.exec(String(period||''));if(!m)throw new Error('INVALID_PERIOD');
  const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1+delta,1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}
function historicalSliceEnricher(resources,colorMap){
  const resolutionMap=buildProductModelResolutionMap(resources.skuEvidence,resources.productAliases);
  return (sale)=>{
    if(!sale)return null;
    const resolved=resolveSaleModel(sale,resolutionMap);
    const model=resolved.modelo_id==null?null:resources.catalogs.models.get(String(resolved.modelo_id));
    const resolution=resolutionMap.get(normalizeProductKey(sale.producto_sku))??null;
    const candidates=(resolution?.candidate_model_ids??[]).map(id=>resources.catalogs.models.get(String(id))).filter(Boolean);
    const candidateBrandIds=[...new Set(candidates.map(x=>String(x.marca_id)))];
    const candidateBrand=model??(candidateBrandIds.length===1?candidates[0]:null);
    const rawBrand=resources.catalogs.brands?.get(normalizeProductKey(sale.marca))??null;
    const brand=candidateBrand??rawBrand;
    const org=enrichRecognizedSale({...resolved,commercial_universe:sale.canonical_commercial_universe},resources.organization);
    return {
      ...sale,...resolved,...org,
      marca_id:brand?.marca_id??null,
      marca_nombre:brand?.marca??null,
      certified_store_id:org.sucursal_id??sale.sucursal_venta_id??null,
      certified_dealer_id:org.dealer_id??sale.dealer_id??null,
      certified_dealer_group_id:org.dealer_group_id??sale.dealer_group_id??null,
      vehicle_color:sale.vin==null?null:(colorMap.get(String(sale.vin).trim().toUpperCase())??null),
    };
  };
}
function historicalStateKey(sale){return sale?.vin!=null?'VIN:'+String(sale.vin):'ROW:'+String(sale?.source_id??'');}
function historicalUniverseMatch(sale,universe){
  return universe==='COMPANY'||sale?.canonical_commercial_universe===universe;
}
export async function buildSalesTemporalFingerprint(input={},focusEvidence=null){
  const shape=String(input.evidence_shape??'QUANTITATIVE_OBSERVATION').toUpperCase();
  if(['PERIOD_CALENDAR','HISTORICAL_PERIOD_SERIES'].includes(shape))return null;
  const measureId=String(input.measure??'VIN_SALES').toUpperCase();const measure=MEASURES[measureId];if(!measure)throw unsupportedSalesIdentifier('MEASURE',measureId,Object.keys(MEASURES));
  const focusEnd=String(input.period_to??input.period??monthFromInput(input)??'');
  if(!/^\d{4}-\d{2}$/.test(focusEnd))return null;
  const contextStart=shiftMonth(focusEnd,-24);
  const baseFilters={...(input.filters??{})};delete baseFilters.date_from;delete baseFilters.date_to;delete baseFilters.period;
  const universe=String(baseFilters.commercial_universe??input.commercial_universe??'COMPANY').toUpperCase();
  const [timeline,colors]=await Promise.all([buildVentasHistoricalTimeline(contextStart,focusEnd),vehicleColorMap()]);
  const enrich=historicalSliceEnricher(timeline.resources,colors);
  const events=timeline.events.map(event=>({...event,previous:enrich(event.previous),next:enrich(event.next)}));
  const state=new Map(),history=[];let cursor=0;
  const dimension=shape==='DIMENSIONAL_QUANTITATIVE_DATASET'?String(input.dimension??'').toUpperCase():null;
  const modelRows=timeline.resources?.catalogs?.models instanceof Map?[...timeline.resources.catalogs.models.values()]:[];
  const modelLabels=new Map(modelRows.map(row=>[String(row.modelo_id),row.modelo??null]));
  for(const period of monthSequence(contextStart,focusEnd)){
    const boundary=new Date(commercialDateForDay(period,commercialMonthDays(period))+'T23:59:59.999Z').getTime();
    while(cursor<events.length&&Number(events[cursor].time)<=boundary){
      const event=events[cursor++];
      if(event.previous)state.delete(historicalStateKey(event.previous));
      if(event.next)state.set(historicalStateKey(event.next),event.next);
    }
    let value=0;const memberCounts=new Map();let unresolved=0;
    for(const sale of state.values()){
      if(!historicalUniverseMatch(sale,universe))continue;
      if(commercialMonthForDate(saleDate(sale))!==period)continue;
      const ok=Object.entries(baseFilters).every(([k,v])=>k==='commercial_universe'||match(sale,k,v));
      if(!ok)continue;
      value++;
      if(dimension==='MODEL'){
        const id=field(sale,'model_id');
        if(id==null)unresolved++;
        else memberCounts.set(String(id),(memberCounts.get(String(id))??0)+1);
      }
    }
    if(dimension==='MODEL'){
      const members=[...memberCounts.entries()].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true})).map(([member_id,count])=>({member_id,member_label:modelLabels.get(member_id)??null,value:count}));
      if(unresolved>0)members.push({member_id:'UNRESOLVED',member_label:'No resuelto',value:unresolved});
      history.push({period_identity:period,total_value:value,members});
    }else history.push({period_identity:period,value});
  }
  const contract={shape:'TEMPORAL_FINGERPRINT',measure:measure.id,dimension,context_start:contextStart,context_end:focusEnd,filters:baseFilters,focus_evidence_id:focusEvidence?.evidence_id??null};
  return {
    fingerprint_id:'p1.sales.temporal.'+evidenceId(contract).split('.').at(-1),
    evidence_contract:'p1.temporal_fingerprint',evidence_version:'0.1.0',authority:'P1_CERTIFIED',status:'CERTIFIED',
    source:DATA_SOURCE,measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{commercial_universe:universe},dimensions:{...dimensions(baseFilters),...(dimension?{breakdown_dimension:dimension}:{})},
    temporal:{period_type:'COMMERCIAL_MONTH',context_start:contextStart,context_end:focusEnd,history_window_months:24,semantics:'SAME_SLICE_CUTOFF_SAFE_HISTORY'},
    coverage:{periods:history.length,first_period:history[0]?.period_identity??null,last_period:history.at(-1)?.period_identity??null,tie_groups_resolved:timeline.tie_groups_resolved},
    payload:{history},
    delivery:{target:'LLM',p2_input:false},
    lineage:{universe_timeline:timeline.timeline,universe_timeline_version:timeline.version,recognition:timeline.lineage?.recognition??null,focus_evidence_id:focusEvidence?.evidence_id??null,certifier:'salesCertifier',certifier_version:CERTIFIER_VERSION},
  };
}

async function observeHistoricalPeriodSeries(input,measure){
  const period=monthFromInput(input);if(!period)throw new Error('PERIOD_REQUIRED');
  const [y,m]=period.split('-').map(Number);const prev=new Date(Date.UTC(y,m-2,1));
  const endMonth=`${prev.getUTCFullYear()}-${String(prev.getUTCMonth()+1).padStart(2,'0')}`;
  const startMonth=PERIOD_CLOSE_HISTORY_POLICY_V01.start_month;
  if(input.history_start_month!=null && String(input.history_start_month)!==startMonth)throw new Error('HISTORY_POLICY_VIOLATION: E06 v0.1 requires '+startMonth);
  const universe=String(input.filters?.commercial_universe??'OWN_STORES').toUpperCase();
  if(universe!=='OWN_STORES')throw new Error('UNSUPPORTED_HISTORY_UNIVERSE: '+universe);
  const timeline=await buildVentasHistoricalTimeline(startMonth,endMonth);
  const context=calculateDailyCloseBacktestContextFromTimeline(
    timeline,timeline.resources.organization,{start_month:startMonth,end_month:endMonth},new Date(),timeline.source_rows
  );
  if(context.status!=='ok')throw new Error('HISTORICAL_SERIES_NOT_CERTIFIED');
  const storeId=input.filters?.store_id==null?null:String(input.filters.store_id);
  const rows=storeId==null?context.company_observations:context.store_observations.filter(row=>String(row.sucursal_id)===storeId);
  const contract={shape:'HISTORICAL_PERIOD_SERIES',measure:measure.id,universe,period,startMonth,endMonth,store_id:storeId};
  return evidenceEnvelope(contract,'HISTORICAL_PERIOD_SERIES',{
    grain:'COMMERCIAL_MONTH_CUTOFF',measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{commercial_universe:universe},dimensions:storeId==null?{}:{store_id:storeId},
    temporal:{target_period:period,period_type:'COMMERCIAL_MONTH',history_start_month:startMonth,history_end_month:endMonth,closure:'CLOSED_PERIODS_ONLY',history_policy:PERIOD_CLOSE_HISTORY_POLICY_V01.policy_id},
    coverage:{...context.coverage,validation:context.validation,warnings:context.warnings},
    payload:{periods:rows.map(row=>({period_identity:row.target_month,cutoff:row.cutoff_date,day_of_period:row.day_of_month,observed_to_cutoff:row.observed_to_date,actual_close:row.actual_close}))},
    lineage:{...context.lineage,historical_timeline:timeline.timeline,historical_timeline_version:timeline.version,certifier:'salesCertifier',certifier_version:CERTIFIER_VERSION},
  });
}


function monthEnd(period){const [y,m]=String(period).split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);}
async function observeSellerContributionHistory(input,measure){
  const period=monthFromInput(input);if(!period)throw new Error('PERIOD_REQUIRED');
  const storeId=input.filters?.store_id==null?null:String(input.filters.store_id);if(!storeId)throw new Error('STORE_ID_REQUIRED');
  const {cutoff,resolution:cutoffResolution}=await resolvePeriodCutoff(input,period);
  const months=Array.from({length:5},(_,i)=>shiftMonth(period,-(5-i)));
  const startMonth=months[0],endMonth=months.at(-1);
  const timeline=await buildVentasHistoricalTimeline(startMonth,endMonth);
  const context=calculateDailyCloseBacktestContextFromTimeline(timeline,timeline.resources.organization,{start_month:startMonth,end_month:endMonth},new Date(),timeline.source_rows);
  if(context.status!=='ok')throw new Error('SELLER_HISTORY_NOT_CERTIFIED');
  const roster=await queryDb(`
    SELECT DISTINCT ps.persona_id::text AS seller_id, pm.nombre_canonico AS seller_label,
           ps.valid_from, ps.valid_to, ps.vigente, r.valid_from AS role_from, r.valid_to AS role_to, r.vigente AS role_vigente
    FROM persona_sucursal ps
    JOIN persona_roles r ON r.persona_id=ps.persona_id AND r.rol='VENDEDOR_TIENDA'
    JOIN personas_master pm ON pm.persona_id=ps.persona_id
    JOIN sucursales_master s ON s.sucursal_id=ps.sucursal_id
    WHERE ps.rol='VENDEDOR_TIENDA' AND ps.sucursal_id::text=$1 AND s.tipo_canal='CIDEF'
      AND COALESCE(ps.valid_from,'-infinity'::date) <= $2::date
      AND COALESCE(ps.valid_to,'infinity'::date) >= $2::date
      AND COALESCE(r.valid_from,'-infinity'::date) <= $2::date
      AND COALESCE(r.valid_to,'infinity'::date) >= $2::date
      AND ps.vigente=true AND r.vigente=true
  `,[storeId,cutoff]);
  const intervals=await queryDb(`
    SELECT ps.persona_id::text AS seller_id, ps.valid_from, ps.valid_to, r.valid_from AS role_from, r.valid_to AS role_to
    FROM persona_sucursal ps JOIN persona_roles r ON r.persona_id=ps.persona_id AND r.rol='VENDEDOR_TIENDA'
    WHERE ps.rol='VENDEDOR_TIENDA' AND ps.sucursal_id::text=$1
  `,[storeId]);
  const bySeller=new Map();for(const row of intervals){if(!bySeller.has(row.seller_id))bySeller.set(row.seller_id,[]);bySeller.get(row.seller_id).push(row);}
  const activeAt=(sellerId,date)=>(bySeller.get(String(sellerId))??[]).some(x=>{
    const from=[x.valid_from,x.role_from].filter(Boolean).map(v=>String(v).slice(0,10)).sort().at(-1)??null;
    const to=[x.valid_to,x.role_to].filter(Boolean).map(v=>String(v).slice(0,10)).sort()[0]??null;
    return (!from||from<=date)&&(!to||to>=date);
  });
  const storeClose=new Map();for(const row of context.store_observations){if(String(row.sucursal_id)!==storeId)continue;const key=row.target_month;const prior=storeClose.get(key);if(!prior||row.day_of_month>prior.day_of_month)storeClose.set(key,row);}
  const sellerClose=new Map();for(const row of context.seller_observations){if(String(row.sucursal_id)!==storeId)continue;const key=row.target_month+'|'+row.persona_id;const prior=sellerClose.get(key);if(!prior||row.day_of_month>prior.day_of_month)sellerClose.set(key,row);}
  const sellers=[];
  for(const seller of roster){
    const sellerMonths=months.map(m=>{const end=monthEnd(m),store=storeClose.get(m);if(!store||!activeAt(seller.seller_id,end))return null;const sr=sellerClose.get(m+'|'+seller.seller_id);return {period_identity:m,seller_sales:Number(sr?.actual_close??0),store_sales:Number(store.actual_close)};}).filter(Boolean);
    if(sellerMonths.length===5&&sellerMonths.every(x=>x.store_sales>0))sellers.push({seller_id:seller.seller_id,seller_label:seller.seller_label??null,months:sellerMonths});
  }
  const contract={shape:'SELLER_CONTRIBUTION_HISTORY',measure:measure.id,period,cutoff,store_id:storeId,months};
  return evidenceEnvelope(contract,'SELLER_CONTRIBUTION_HISTORY',{
    grain:'ACTIVE_SELLER_X_CLOSED_MONTH',measure:{id:measure.id,unit:measure.unit,aggregation:measure.aggregation},
    universe:{commercial_universe:'OWN_STORES'},dimensions:{store_id:storeId},
    temporal:{target_period:period,cutoff,cutoff_resolution:cutoffResolution,history_start_month:startMonth,history_end_month:endMonth,closure:'CLOSED_PERIODS_ONLY',window_months:5},
    coverage:{active_sellers:roster.length,evaluable_sellers:sellers.length,non_evaluable_active_sellers:roster.length-sellers.length,required_closed_months:5},
    payload:{sellers},
    lineage:{historical_timeline:timeline.timeline,historical_timeline_version:timeline.version,roster:'persona_sucursal + persona_roles',certifier:'salesCertifier',certifier_version:CERTIFIER_VERSION},
  });
}

export async function observeSalesEvidence(input={}){
  const measureId=String(input.measure??'VIN_SALES').toUpperCase();const measure=MEASURES[measureId];if(!measure)throw unsupportedSalesIdentifier('MEASURE',measureId,Object.keys(MEASURES));
  const shape=String(input.evidence_shape??'QUANTITATIVE_OBSERVATION').toUpperCase();
  if(shape==='QUANTITATIVE_OBSERVATION')return observeSales(input);
  if(shape==='CUMULATIVE_PERIOD_OBSERVATION')return observeCumulativePeriod(input,measure);
  if(shape==='PERIOD_CALENDAR')return observePeriodCalendar(input,measure);
  if(shape==='HISTORICAL_PERIOD_SERIES')return observeHistoricalPeriodSeries(input,measure);
  if(shape==='PERIOD_OBSERVATION_SERIES')return observePeriodObservationSeries(input,measure);
  if(shape==='DIMENSIONAL_QUANTITATIVE_DATASET')return observeDimensionalQuantitativeDataset(input,measure);
  if(shape==='SELLER_CONTRIBUTION_HISTORY')return observeSellerContributionHistory(input,measure);
  throw new Error('UNSUPPORTED_EVIDENCE_SHAPE: '+shape);
}
