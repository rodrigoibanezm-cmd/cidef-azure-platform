// Experimental SALES candidate reader. P1 remains the recognition authority.
import { queryDb } from '../lib/neon.js';
import { FILTERS } from '../lib/data-floor/sales/contract.js';

// SQL candidate selection must be a necessary-condition superset of P1 recognition.
// Certified candidate superset: only predicates necessary for a recognized
// monthly sale may run before P1. Product, seller, dealer and store identities
// are resolved later by P1 and must never eliminate candidate VINs here.
const supported = new Set(['commercial_universe','date_from','date_to',
  'brand_id','model_id','store_id','dealer_id','seller_id']);
const positiveId = value => Number.isSafeInteger(value) && value > 0;

// This compiler is independent of any MCP tool, group_by, and aggregation.
// Unsupported filter shapes fall back to full P1 rather than guessing.
export function planSalesCandidates(filters, cutoffDate) {
  if (!filters || Object.keys(filters).some(key => !FILTERS.includes(key) || !supported.has(key)))
    return null;
  const {commercial_universe:universe,date_from:from,date_to:to,brand_id:brand,model_id:model,...rest} = filters;
  if (!['OWN_STORES','DEALERS'].includes(universe) ||
      !positiveId(brand) || !positiveId(model) ||
      !/^\d{4}-\d{2}-01$/.test(from ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ||
      from.slice(0,7) !== to.slice(0,7) || to !== cutoffDate ||
      (universe==='DEALERS' && rest.store_id != null) ||
      (universe!=='DEALERS' && rest.dealer_id != null) ||
      Object.entries(rest).some(([key,value]) => !supported.has(key) || !positiveId(value)))
    return null;
  return Object.freeze({filters:{...filters},year:Number(from.slice(0,4)),
    month:Number(from.slice(5,7)),commercial_universe:universe});
}

// Mirrors the MONTH component accepted by parseFechaFactura: ISO and MM/DD.
// Superset of valid input dates; all final date filtering remains in P1.
export function monthCandidateDatePattern(year,month){
  const mm=String(month).padStart(2,'0'), yy=String(year).slice(-2);
  return '^('+year+'-'+mm+'-[0-9]{2}|0?'+month+
    '/[0-9]{1,2}/'+year+'|0?'+month+'/[0-9]{1,2}/'+yy+
    ')([[:space:]]|$)';
}

export async function semanticSalesCandidates(input) {
  // Preserve the original diagnostic reader contract for existing callers.
  const plan = input?.filters ? input : (() => {
    const {year,month,commercial_universe='OWN_STORES',...dimensions}=input??{};
    if (!Number.isSafeInteger(year)||!Number.isSafeInteger(month)||
        year<2020||year>2100||month<1||month>12)
      throw new Error('INVALID_PERIOD');
    const mm=String(month).padStart(2,'0');
    const date_from=year+'-'+mm+'-01';
    const date_to=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
    const filters={commercial_universe,date_from,date_to,...dimensions};
    return planSalesCandidates(filters,date_to);
  })();
  if (!plan) throw new Error('UNSUPPORTED_SALES_CANDIDATE_PLAN');
  const {filters,year,month,commercial_universe:universe}=plan;
  if (!planSalesCandidates(filters,filters.date_to)) throw new Error('UNSUPPORTED_SALES_CANDIDATE_PLAN');
  const params=[];
  const bind=value => {params.push(value);return '$'+params.length;};
  const datePattern=monthCandidateDatePattern(year,month);
  const conditions=[
    'btrim(v.categoria_cliente) = '+bind(universe==='DEALERS'?'Concesionaria':'Cliente General'),
    "nullif(btrim(v.nro_vin_chasis),'') IS NOT NULL",
    'btrim(v.fecha_factura) ~ '+bind(datePattern),
  ];
  const sql='SELECT DISTINCT btrim(v.nro_vin_chasis) AS vin FROM ventas_raw v WHERE '+
    conditions.join(' AND ')+' ORDER BY vin';
  const start=performance.now();
  const rows=await queryDb(sql,params);
  return {vins:rows.map(row=>row.vin),count:rows.length,
    elapsed_ms:Math.round(performance.now()-start),status:'CANDIDATES_ONLY_NOT_CERTIFIED'};
}
