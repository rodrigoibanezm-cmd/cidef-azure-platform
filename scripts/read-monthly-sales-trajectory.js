// Read-only trajectories from stored P1 monthly aggregates; not a P1 evidence envelope.
import { getAzurePool } from '../lib/azure-postgres.js';

const TABLES = Object.freeze({
  STORE: ['sales_monthly_store','store_id','OWN_STORES'],
  SELLER: ['sales_monthly_seller','seller_id','OWN_STORES'],
  MODEL: ['sales_monthly_model','model_id','COMPANY'],
  DEALER_GROUP: ['sales_monthly_dealer','dealer_group_id','DEALERS'],
});
function nextMonth(month) {
  const [y,m] = month.split('-').map(Number);
  return new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);
}
export async function readMonthlySalesTrajectory({
  dimension, member_id, brand_id = '', from = '2025-04', to = '2026-09',
} = {}, { pool = getAzurePool() } = {}) {
  const entry = TABLES[dimension];
  if (!entry) throw new Error('UNSUPPORTED_SALES_DIMENSION');
  if (!/^\d+$/.test(String(member_id ?? ''))) throw new Error('CANONICAL_MEMBER_ID_REQUIRED');
  if (!['','89','71'].includes(String(brand_id))) throw new Error('UNSUPPORTED_BRAND_ID');
  const validMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  if (!validMonth(from) || !validMonth(to) || from > to || from < '2025-04'
    || to > '2026-09') throw new Error('INVALID_MONTHLY_TRAJECTORY_RANGE');

  const [table, idColumn, universe] = entry;
  const { rows } = await pool.query(
    `SELECT period, vin_sales, evidence_id
     FROM public.${table}
     WHERE commercial_universe=$1 AND brand_id=$2 AND ${idColumn}=$3
       AND period >= $4 AND period <= $5 ORDER BY period`,
    [universe, String(brand_id), String(member_id), from, to],
  );
  const found = new Map();
  for (const row of rows) {
    const month = String(row.period);
    const value = Number(row.vin_sales);
    if (found.has(month) || !validMonth(month) || month < from || month > to
      || !Number.isSafeInteger(value) || value < 0 || !/^p1\.sales\.[a-f0-9]{24}$/.test(row.evidence_id ?? ''))
      throw new Error('INVALID_STORED_SALES_ROW');
    found.set(month, {period:month, vin_sales:value, evidence_id:row.evidence_id});
  }
  const observations = [], missing_months = [], zero_months = [];
  for (let month = from; month <= to; month = nextMonth(month)) {
    const item = found.get(month);
    if (!item) {
      missing_months.push(month);
      observations.push({period:month,vin_sales:null,evidence_id:null,state:'MISSING_RECORD'});
    } else {
      if (item.vin_sales === 0) zero_months.push(month);
      observations.push({...item,state:item.vin_sales===0?'EXPLICIT_ZERO':'OBSERVED_POSITIVE'});
    }
  }
  return {source:'STORED_P1_MONTHLY_AGGREGATES',certification:'REFERENCED_NOT_RECONSTRUCTED',
    dimension,member_id:String(member_id),brand_id:String(brand_id),
    commercial_universe:universe,from,to,continuous:missing_months.length===0,
    missing_months,zero_months,observations,
    limitation:'Not an original P1 evidence envelope; cannot be passed to P2 evidence validators.'};
}
