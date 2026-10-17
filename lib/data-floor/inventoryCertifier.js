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

async function dataset(input={}){
  const q=normalize(input);
  const base=await queryDb(`
    SELECT
      vin, nro_stock, marca_raw, modelo_raw, color_raw, bodega_fuente,
      fecha_ingreso_stock, fecha_eta, esta_reservado, esta_en_transito,
      en_patio, esta_fisico_raw, dealer_id, dealer_group_id
    FROM vehiculo_canonico
    WHERE vigente = true
  `);
  const filtered=base.filter(row=>Object.entries(q.filters).every(([k,v])=>match(row,k,v)));
  return {q,base,filtered};
}

function quality(base){
  const missingStockEntry=base.filter(r=>r.fecha_ingreso_stock==null).length;
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
    operations:['DESCRIBE','INSPECT','FETCH'],
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
