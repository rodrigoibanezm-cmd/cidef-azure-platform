import { createHash } from 'node:crypto';
import { loadSalesAttributes, enrichSalesAttributes } from './attributes.js';
export { vehicleColorMap } from './attributes.js';
import { buildVentasUniverse } from '../../ventas-universe/buildVentasUniverse.js';
import { FILTERS } from './contract.js';
import { unsupportedSalesIdentifier } from './errors.js';

function values(v){ return Array.isArray(v) ? v.map(String) : [String(v)]; }
function iso(v){ return v == null ? null : String(v).slice(0,10); }
export function saleDate(row){ return iso(row.fecha_venta_iso ?? row.fecha_factura_iso ?? row.fecha_factura); }
function color(row){ return row.vehicle_color ?? row.color ?? row.color_raw ?? row.desc_color ?? null; }
function financialEntity(row){ const value=row.entidad_financiera??row.financial_entity??null; return value==null||String(value).trim()===''?null:value; }
function stable(value){ if(Array.isArray(value)) return value.map(stable); if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])); return value; }
export function evidenceId(payload){ return 'p1.sales.'+createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex').slice(0,24); }
async function enrichVehicleAttributes(rows){
  return enrichSalesAttributes(rows,await loadSalesAttributes());
}
export function field(row,key){
  const map={
    vin:row.vin,sale_date:saleDate(row),invoice:row.nro_factura??row.factura??null,
    operation:row.nro_operacion??row.operacion??null,brand_id:row.marca_id??null,
    model_id:row.modelo_id??null,version_id:row.version_id??null,store_id:row.certified_store_id??row.sucursal_venta_id??null,
    store_label:row.certified_store_label??null,
    dealer_id:row.certified_dealer_id??row.dealer_id??null,
    dealer_group_id:row.certified_dealer_group_id??row.dealer_group_id??null,
    seller_id:row.persona_id??row.vendedor_id??null,seller_label:row.certified_seller_label??null,color:color(row),
    financial_entity:financialEntity(row),
  };
  return map[key];
}
export function match(row,key,wanted){
  if(key==='date_from') return saleDate(row)>=String(wanted);
  if(key==='date_to') return saleDate(row)<=String(wanted);
  if(key==='commercial_universe') return true;
  const actual=field(row,key);if(actual==null)return false;
  return values(wanted).some(v=>String(actual).trim().toUpperCase()===v.trim().toUpperCase());
}
export function normalize(input={}){
  const filters=input.filters??{};
  const unsupported=Object.keys(filters).find(k=>!FILTERS.includes(k));if(unsupported)throw unsupportedSalesIdentifier('FILTER',unsupported,FILTERS);
  const commercial_universe=String(filters.commercial_universe??input.commercial_universe??'COMPANY').toUpperCase();
  return {filters:{...filters,commercial_universe},commercial_universe};
}
export async function dataset(input={}){
  const q=normalize(input);
  const u=await buildVentasUniverse({commercial_universe:q.commercial_universe,cutoff_date:q.filters.date_to??input.cutoff_date??null});
  const rawBase=u.analytical_events??[];const base=await enrichVehicleAttributes(rawBase);
  const filtered=base.filter(row=>Object.entries(q.filters).every(([k,v])=>match(row,k,v)));
  return {q,u,base,filtered};
}
export function quality(u){return {coverage:u.coverage??null,validation:u.validation??null,warnings:u.warnings??[]};}
export function dimensions(filters){
  const keys=['brand_id','model_id','version_id','store_id','dealer_id','dealer_group_id','seller_id','color'];
  return Object.fromEntries(keys.filter(k=>filters[k]!=null).map(k=>[k,filters[k]]));
}
export function temporal(filters){return {date_from:filters.date_from??null,date_to:filters.date_to??null,date_semantics:'fecha_factura'};}
