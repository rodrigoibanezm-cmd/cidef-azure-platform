import { createHash } from 'node:crypto';
import { azureQuery } from '../azure-postgres.js';

const VERSION = '0.1.0';
const FILTERS = ['period','brand','dealer_group_id'];
const FIELDS = ['period','dealer_group_id','dealer_name','brand','vin_count'];
const isoMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));

function validate(input = {}) {
  const f = { ...input.filters };
  for (const key of Object.keys(f)) if (!FILTERS.includes(key)) throw new Error('UNSUPPORTED_SELL_OUT_FILTER: ' + key);
  if (input.period != null) f.period = input.period;
  if (!isoMonth(f.period)) throw new Error('SELL_OUT_PERIOD_REQUIRED');
  if (f.brand != null && !['FOTON','DONGFENG','UNRESOLVED'].includes(String(f.brand).toUpperCase()))
    throw new Error('UNSUPPORTED_SELL_OUT_BRAND');
  return f;
}
async function rows(input = {}) {
  const f = validate(input), params = [f.period], conditions = ['s.period=$1'];
  if (f.brand != null) { params.push(String(f.brand).toUpperCase()); conditions.push('s.brand=$' + params.length); }
  if (f.dealer_group_id != null) { params.push(Number(f.dealer_group_id)); conditions.push('s.dealer_group_id=$' + params.length); }
  const [available] = await azureQuery("SELECT count(*)::int AS n FROM public.dealer_monthly_sellout_snapshots");
  if (!Number(available?.n)) throw new Error('SELL_OUT_SNAPSHOT_NOT_PUBLISHED');
  const result = await azureQuery(`SELECT s.period,s.dealer_group_id,
    coalesce(g.nombre_canonico,'No resuelto') AS dealer_name,
    s.brand,s.vin_count
    FROM public.dealer_monthly_sellout_snapshots s
    LEFT JOIN public.dealer_groups g ON g.dealer_group_id=s.dealer_group_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.vin_count DESC,s.dealer_group_id,s.brand`,params);
  return { f, result: result.map(r=>({...r,vin_count:Number(r.vin_count)})) };
}
export function describeSellout() {
  return {
    source:'SELL_OUT',version:VERSION,meaning:'CIDEF dealer VIN registered in RVM, grouped by dealer and brand.',
    grain:'one dealer, brand and calendar month; unique registered VIN',
    date_semantics:{period:'vehiculo_canonico.fecha_inscripcion_rvm, not sale invoice date'},
    filters:FILTERS,fields:FIELDS,
    measures:[{id:'VIN_SELL_OUT',unit:'VIN',aggregation:'SUM_PRECOMPUTED_DISTINCT_VIN'}],
    dimensions:['DEALER_GROUP','BRAND','DEALER_BRAND'],
    semantic_constraints:['No sell-in date restriction. Snapshot refreshed with canonical SALES/RVM data.',
      'Unresolved dealers use dealer_group_id=0; unresolved brands are shown separately.'],
    operations:['DESCRIBE','INSPECT','FETCH','OBSERVE'],
    evidence_shapes:['QUANTITATIVE_OBSERVATION','DIMENSIONAL_QUANTITATIVE_DATASET'],
    boolean_logic:'AND between filters',
    lineage:{source:'vehiculo_canonico',snapshot:'dealer_monthly_sellout_snapshots'}
  };
}
export async function inspectSellout(input = {}) {
  const {f,result} = await rows(input);
  return {source:'SELL_OUT',operation:'INSPECT',filters:f,
    size:{source_n:result.length,filtered_n:result.length},
    shape:{brands:new Set(result.map(r=>r.brand)).size,dealers:new Set(result.map(r=>r.dealer_group_id)).size},
    quality:{coverage:{unresolved_vins:result.filter(r=>r.dealer_group_id===0||r.brand==='UNRESOLVED').reduce((n,r)=>n+r.vin_count,0)},validation:{snapshot_based:true},warnings:[]},
    lineage:{snapshot:'dealer_monthly_sellout_snapshots'}};
}
export async function fetchSellout(input = {}) {
  const fields = input.fields?.length ? input.fields : FIELDS;
  if (fields.some(f=>!FIELDS.includes(f))) throw new Error('UNSUPPORTED_SELL_OUT_FIELD');
  const {f,result}=await rows(input);
  return {source:'SELL_OUT',operation:'FETCH',dataset:'DEALER_SELLOUT_SNAPSHOT',version:VERSION,
    filters:f,grain:'DEALER_BRAND_MONTH',size:{source_n:result.length,filtered_n:result.length},
    rows:result.map(row=>Object.fromEntries(fields.map(field=>[field,row[field]]))),
    quality:{validation:{snapshot_based:true},warnings:[]},lineage:{snapshot:'dealer_monthly_sellout_snapshots'}};
}
export async function observeSellout(input = {}) {
  if (input.measure !== 'VIN_SELL_OUT') throw new Error('UNSUPPORTED_SELL_OUT_MEASURE');
  const dim=String(input.dimension||'').toUpperCase();
  if (input.evidence_shape==='DIMENSIONAL_QUANTITATIVE_DATASET' && !['DEALER_GROUP','BRAND','DEALER_BRAND'].includes(dim))
    throw new Error('UNSUPPORTED_SELL_OUT_DIMENSION');
  const {f,result}=await rows(input);
  const value=result.reduce((n,r)=>n+r.vin_count,0);
  const grouped = new Map();
  for (const r of result) {
    const key = dim==='BRAND' ? r.brand : dim==='DEALER_GROUP' ? String(r.dealer_group_id) : r.dealer_group_id+'|'+r.brand;
    const prior=grouped.get(key);
    if (prior) prior.value+=r.vin_count;
    else grouped.set(key,{dealer_group_id:r.dealer_group_id,dealer_name:r.dealer_name,brand:r.brand,value:r.vin_count});
  }
  const members=[...grouped.values()].map(r=>dim==='BRAND'
    ? {member_id:r.brand,member_label:r.brand,value:r.value}
    : dim==='DEALER_GROUP' ? {member_id:String(r.dealer_group_id),member_label:r.dealer_name,value:r.value}
    : r);
  const identity = JSON.stringify([VERSION,f,dim,members]);
  return {evidence_id:'p1.sellout.'+createHash('sha256').update(identity).digest('hex').slice(0,24),
    evidence_contract:'p1.'+(dim?'dimensional_quantitative_dataset':'quantitative_observation'),
    evidence_version:VERSION,authority:'P1_CERTIFIED',status:'CERTIFIED',source:'SELL_OUT',operation:'OBSERVE',
    grain:'REGISTERED_DEALER_VIN',measure:{id:'VIN_SELL_OUT',unit:'VIN',aggregation:'SUM_PRECOMPUTED_DISTINCT_VIN'},
    universe:{commercial_universe:'DEALERS'},dimensions:{...(dim?{dimension:dim}:{})},
    temporal:{period_identity:f.period,date_semantics:'fecha_inscripcion_rvm'},
    coverage:{filtered_n:value,unresolved_n:result.filter(r=>r.dealer_group_id===0).reduce((n,r)=>n+r.vin_count,0)},
    payload:dim?{members}: {value},lineage:{snapshot:'dealer_monthly_sellout_snapshots',filters:f}};
}
