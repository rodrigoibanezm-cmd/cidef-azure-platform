import {createHash} from 'node:crypto';
import { queryDb } from '../neon.js';

export const DATA_SOURCE = 'INVENTORY';
export const CERTIFIER_VERSION = '0.2';

const FILTERS = Object.freeze([
  'vin','brand','model','warehouse','color',
  'reserved','in_transit','in_yard','dealer_id','dealer_group_id'
]);

const FIELDS = Object.freeze([
  'vin','stock_number','brand','model','color','warehouse',
  'stock_entry_date','eta','reserved','in_transit','in_yard',
  'physical_raw','dealer_id','dealer_group_id'
]);

function values(v){ return Array.isArray(v) ? v : [v]; }
function iso(v){
  if (v == null) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0,10);
  const s=String(v).trim();
  if (/^\\d{4}-\\d{2}-\\d{2}/.test(s)) return s.slice(0,10);
  const d=new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}
function bool(v){ return v === true || String(v ?? '').trim().toLowerCase() === 'true'; }
function norm(v){ return v == null ? null : String(v).trim().toUpperCase(); }

function field(row,key){
  const map={
    vin:row.vin,
    stock_number:row.nro_stock,
    brand:row.marca_raw,
    model:row.modelo_raw,
    color:row.color_raw,
    warehouse:row.bodega_fuente,
    stock_entry_date:iso(row.fecha_ingreso_stock),
    eta:iso(row.fecha_eta),
    reserved:bool(row.esta_reservado),
    in_transit:bool(row.esta_en_transito),
    in_yard:bool(row.en_patio),
    physical_raw:row.esta_fisico_raw,
    dealer_id:row.dealer_id,
    dealer_group_id:row.dealer_group_id,
  };
  return map[key];
}

function match(row,key,wanted){
  const actual=field(row,key);
  if(actual==null) return false;
  if(['reserved','in_transit','in_yard'].includes(key)){
    return values(wanted).some(v=>bool(actual)===bool(v));
  }
  return values(wanted).some(v=>norm(actual)===norm(v));
}

function normalize(input={}){
  const filters=input.filters ?? {};
  const unsupported=Object.keys(filters).find(k=>!FILTERS.includes(k));
  if(unsupported) throw new Error('UNSUPPORTED_INVENTORY_FILTER: '+unsupported);
  return {filters};
}

const FILTER_COLUMNS = Object.freeze({
  vin:'vin',brand:'marca_raw',model:'modelo_raw',warehouse:'bodega_fuente',
  color:'color_raw',reserved:'esta_reservado',in_transit:'esta_en_transito',
  in_yard:'en_patio',dealer_id:'dealer_id',dealer_group_id:'dealer_group_id'
});

// Push selections into PostgreSQL; keep the complete-universe coverage statistics.
function inventoryWhere(filters){
  const clauses=['vigente = true'],params=[];
  for(const [key,wanted] of Object.entries(filters)){
    const column=FILTER_COLUMNS[key];
    if(!column)throw new Error('UNSUPPORTED_INVENTORY_FILTER: '+key);
    params.push(['reserved','in_transit','in_yard'].includes(key)
      ? values(wanted).map(bool)
      : values(wanted).filter(v=>v!=null).map(norm));
    const placeholder='$'+params.length;
    clauses.push(['reserved','in_transit','in_yard'].includes(key)
      ? `coalesce(lower(btrim(${column}::text)) = 'true', false) = ANY(${placeholder}::boolean[])`
      : `upper(btrim(${column}::text)) = ANY(${placeholder}::text[])`);
  }
  return {sql:'WHERE '+clauses.join(' AND '),params};
}

async function dataset(input={}){
  const q=normalize(input),w=inventoryWhere(q.filters);
  const [stats={},filtered]=await Promise.all([
    queryDb(`SELECT count(*)::bigint AS n,
      count(*) FILTER (WHERE fecha_ingreso_stock IS NULL)::bigint AS missing
      FROM vehiculo_canonico WHERE vigente = true`).then(rows=>rows[0]),
    queryDb(`SELECT
      vin, nro_stock, marca_raw, modelo_raw, color_raw, bodega_fuente,
      fecha_ingreso_stock, fecha_eta, esta_reservado, esta_en_transito,
      en_patio, esta_fisico_raw, dealer_id, dealer_group_id
      FROM vehiculo_canonico ${w.sql}`,w.params)
  ]);
  // Retain the existing JS predicate as a final consistency guard.
  return {q,base:{length:Number(stats.n||0),missingStockEntry:Number(stats.missing||0)},
    filtered:filtered.filter(row=>Object.entries(q.filters).every(([k,v])=>match(row,k,v)))};
}

function quality(base){
  const missingStockEntry=base.missingStockEntry;
  return {
    coverage:{
      stock_entry_date:{present_n:base.length-missingStockEntry,missing_n:missingStockEntry},
    },
    validation:{current_inventory_only:true},
    warnings:missingStockEntry ? ['Some current inventory lacks stock_entry_date'] : [],
  };
}

export function describeInventory(){
  return {
    source:DATA_SOURCE,version:CERTIFIER_VERSION,
    meaning:'Certified current CIDEF vehicle inventory facts.',
    grain:'one valid current VIN observed in vehiculos_raw and materialized in vehiculo_canonico',
    date_semantics:{stock_entry_date:'fecha_ingreso_stock',eta:'fecha_eta',history:'current state only; no historical inventory snapshots'},
    filters:FILTERS,fields:FIELDS,
    operations:['DESCRIBE','INSPECT','FETCH','OBSERVE'],
    measures:[{id:'VIN_STOCK',unit:'VIN',aggregation:'COUNT_DISTINCT_CURRENT_VIN'}],
    evidence_shapes:['QUANTITATIVE_OBSERVATION'],
    boolean_logic:'AND between filters; OR within array values',
    lineage:{universe:'vehiculo_canonico',raw_source:'vehiculos_raw',current_rule:'vigente=true'},
  };
}

export async function inspectInventory(input={}){
  const {q,base,filtered}=await dataset(input);
  const distinct=(key)=>new Set(filtered.map(r=>field(r,key)).filter(v=>v!=null).map(String)).size;
  return {
    source:DATA_SOURCE,operation:'INSPECT',filters:q.filters,
    size:{source_n:base.length,filtered_n:filtered.length},
    shape:{
      distinct_vin:distinct('vin'),distinct_brand:distinct('brand'),
      distinct_model:distinct('model'),distinct_warehouse:distinct('warehouse'),
      distinct_color:distinct('color')
    },
    quality:quality(base),
    lineage:{universe:'vehiculo_canonico',raw_source:'vehiculos_raw',current_rule:'vigente=true'},
  };
}

export async function fetchInventory(input={}){
  const {q,base,filtered}=await dataset(input);
  const fields=input.fields?.length ? input.fields : FIELDS;
  const bad=fields.find(k=>!FIELDS.includes(k));
  if(bad) throw new Error('UNSUPPORTED_INVENTORY_FIELD: '+bad);
  const rows=filtered.map(row=>Object.fromEntries(fields.map(k=>[k,field(row,k)])));
  return {
    source:DATA_SOURCE,operation:'FETCH',dataset:'INVENTORY_WORK',version:CERTIFIER_VERSION,
    filters:q.filters,grain:'CURRENT_VIN',
    size:{source_n:base.length,filtered_n:rows.length},
    rows,quality:quality(base),
    lineage:{universe:'vehiculo_canonico',raw_source:'vehiculos_raw',current_rule:'vigente=true'},
  };
}

/** Current-stock only. Historical periods are rejected: no snapshot authority exists. */
export async function resolveInventoryObservation(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !['measure','time','filters','group_by'].includes(key)))
    throw new Error('UNSUPPORTED_INVENTORY_DECLARATIVE_REQUEST');
  const {measure,time={},filters={},group_by=[]}=request;
  if (!['VIN_STOCK','INVENTORY.VIN_STOCK'].includes(measure))
    throw new Error('UNSUPPORTED_INVENTORY_MEASURE');
  if (!time || typeof time !== 'object' || Array.isArray(time) || Object.keys(time).length)
    throw new Error('INVENTORY_HISTORICAL_SNAPSHOT_NOT_AVAILABLE');
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) ||
      !Array.isArray(group_by) || group_by.length)
    throw new Error('UNSUPPORTED_INVENTORY_DECLARATIVE_GROUP_BY');
  const {q,base,filtered}=await dataset({filters});
  const vins=new Set(filtered.map(row=>field(row,'vin')).filter(v=>v!=null).map(v=>String(v).trim().toUpperCase()));
  const identity=JSON.stringify({filters:Object.entries(q.filters).sort(([a],[b])=>a.localeCompare(b)),vins:[...vins].sort(),source_n:base.length,missing_stock_entry:base.missingStockEntry});
  return {
    evidence_id:'p1.inventory.'+createHash('sha256').update(identity).digest('hex').slice(0,24),
    evidence_contract:'p1.quantitative_observation',evidence_version:CERTIFIER_VERSION,
    authority:'P1_CERTIFIED',status:'CERTIFIED',source:DATA_SOURCE,operation:'OBSERVE',
    grain:'CURRENT_VIN',measure:{id:'VIN_STOCK',unit:'VIN',aggregation:'COUNT_DISTINCT_CURRENT_VIN'},
    universe:{current_inventory_only:true},dimensions:q.filters,
    temporal:{snapshot:'CURRENT_STATE',historical_snapshot_available:false},
    coverage:{source_n:base.length,filtered_n:filtered.length,distinct_vin_n:vins.size,quality:quality(base)},
    payload:{value:vins.size},
    lineage:{universe:'vehiculo_canonico',raw_source:'vehiculos_raw',current_rule:'vigente=true'},
  };
}
