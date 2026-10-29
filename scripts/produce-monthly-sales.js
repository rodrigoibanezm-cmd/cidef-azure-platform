// Certified monthly P1 aggregates. Existing tables are append-only.
import { prepareSalesInput } from '../lib/data-floor/sales/preparation.js';
import { createSalesFactSet } from '../lib/data-floor/sales/factSet.js';
import { observeSalesSelection } from '../lib/data-floor/sales/operations.js';
import { getAzurePool } from '../lib/azure-postgres.js';
import { commercialDateForDay, commercialMonthDays } from '../lib/ventas/commercialMonth.js';

const DIMENSIONS = [
  ['STORE', 'OWN_STORES', 'sales_monthly_store', 'store_id'],
  ['SELLER', 'OWN_STORES', 'sales_monthly_seller', 'seller_id'],
  ['MODEL', 'COMPANY', 'sales_monthly_model', 'model_id'],
  ['DEALER_GROUP', 'DEALERS', 'sales_monthly_dealer', 'dealer_group_id'],
];
const BRANDS = ['', '89', '71']; // Empty string denotes the company opening.
const validId = x => /^\d+$/.test(String(x));
function assertCertified(e, dimension, universe, brand, period, end) {
  if (e?.authority !== 'P1_CERTIFIED' || e.status !== 'CERTIFIED'
    || e.source !== 'SALES' || !/^p1\.sales\.[a-f0-9]{24}$/.test(e.evidence_id ?? '')
    || e.evidence_contract !== 'p1.dimensional_quantitative_dataset'
    || e.payload?.dimension?.id !== dimension || e.universe?.commercial_universe !== universe
    || e.temporal?.period_identity !== period || e.temporal?.cutoff !== end
    || String(e.dimensions?.brand_id ?? '') !== brand)
    throw new Error('INVALID_P1_MONTHLY_EVIDENCE');
  const members = e.payload.members;
  if (!Array.isArray(members) || members.some(m => !Number.isInteger(m.value) || m.value < 0))
    throw new Error('INVALID_P1_MEMBERS');
  if (members.reduce((n,m) => n+m.value,0) !== e.coverage?.filtered_n)
    throw new Error('P1_MONTHLY_TOTAL_MISMATCH');
  return members;
}
async function producePreparedMonth(period, prepared, {
  pool, makeFactSet, observe,
}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || period >= new Date().toISOString().slice(0,7))
    throw new Error('CLOSED_PERIOD_REQUIRED');
  const end = commercialDateForDay(period, commercialMonthDays(period));
  const factSets = new Map();
  const staged = [];
  for (const [dimension, universe, table, idColumn] of DIMENSIONS) {
    if (!factSets.has(universe)) {
      const certified = prepared.recognize({commercial_universe:universe,cutoff_date:end});
      factSets.set(universe,makeFactSet(certified,prepared.identity));
    }
    const factSet = factSets.get(universe);
    for (const brand of BRANDS) {
      const filters = {commercial_universe:universe,date_from:commercialDateForDay(period,1),date_to:end,
        ...(brand?{brand_id:brand}:{})};
      const evidence = observe(factSet.select(filters),{group_by:[dimension],period});
      const members = assertCertified(evidence,dimension,universe,brand,period,end);
      for (const member of members) {
        if (!validId(member.member_id)) continue; // Explicit unresolved cannot be given a canonical ID.
        staged.push({table,idColumn,universe,brand,id:String(member.member_id),
          vin_sales:member.value,evidence_id:evidence.evidence_id});
      }
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    for (const row of staged) {
      const sql = `INSERT INTO public.${row.table}
        (period,commercial_universe,brand_id,${row.idColumn},vin_sales,evidence_id,certified_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`;
      const result = await client.query(sql,[period,row.universe,row.brand,row.id,row.vin_sales,row.evidence_id]);
      inserted += result.rowCount;
    }
    await client.query('COMMIT');
    return {period,status:'STORED',prepared:1,recognized_universes:factSets.size,
      certified_rows:staged.length,inserted};
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function produceMonthlySales(period, {
  prepare = prepareSalesInput, pool = getAzurePool(),
  makeFactSet = createSalesFactSet, observe = observeSalesSelection,
} = {}) {
  // Validate the month before loading the shared P1 inputs.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || period >= new Date().toISOString().slice(0,7))
    throw new Error('CLOSED_PERIOD_REQUIRED');
  const prepared = await prepare();
  return producePreparedMonth(period, prepared, {pool,makeFactSet,observe});
}

export async function produceMonthlySalesRange(from, to, {
  prepare = prepareSalesInput, pool = getAzurePool(),
  makeFactSet = createSalesFactSet, observe = observeSalesSelection,
  progress = console.log,
} = {}) {
  const valid = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  if (!valid(from) || !valid(to) || from > to || from < '2025-04'
    || to > '2026-08') throw new Error('HISTORICAL_RANGE_OUT_OF_BOUNDS');
  const periods = [];
  for (let m = from; m <= to;) {
    periods.push(m);
    const [y,n] = m.split('-').map(Number);
    m = new Date(Date.UTC(y,n,1)).toISOString().slice(0,7);
  }
  const prepared = await prepare(); // One resource load for the entire range.
  const results = [];
  for (const [index, period] of periods.entries()) {
    progress(`[${index+1}/${periods.length}] ${period}: iniciando`);
    const result = await producePreparedMonth(period, prepared, {pool,makeFactSet,observe});
    results.push(result);
    progress(`[${index+1}/${periods.length}] ${period}: ${result.status}, insertados=${result.inserted}`);
  }
  return {from,to,months:periods.length,prepared:1,results};
}
