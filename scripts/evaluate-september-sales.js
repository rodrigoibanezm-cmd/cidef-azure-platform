// Experimental read-only analysis; never P2 certification or publication.
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';
import { readMonthlySalesTrajectory } from './read-monthly-sales-trajectory.js';
import { classifyClosedPerformance, POLICY } from '../lib/p2/closed-performance/classify.js';

const TABLES = Object.freeze({
  STORE: ['sales_monthly_store', 'store_id', 'OWN_STORES'],
  SELLER: ['sales_monthly_seller', 'seller_id', 'OWN_STORES'],
  MODEL: ['sales_monthly_model', 'model_id', 'COMPANY'],
  DEALER_GROUP: ['sales_monthly_dealer', 'dealer_group_id', 'DEALERS'],
});
export async function evaluateSeptemberSales({
  pool = getAzurePool(), read = readMonthlySalesTrajectory,
  classify = classifyClosedPerformance, progress = () => {},
  dimensions = Object.keys(TABLES),
} = {}) {
  const period = '2026-09', from = '2025-04', results = [];
  for (const dimension of dimensions) {
    if (!TABLES[dimension]) throw new Error('UNSUPPORTED_SALES_DIMENSION');
    const [table, idColumn, universe] = TABLES[dimension];
    const { rows } = await pool.query(
      `SELECT DISTINCT ${idColumn} AS member_id FROM public.${table}
       WHERE period=$1 AND commercial_universe=$2 AND brand_id=$3
       ORDER BY member_id`, [period, universe, '']);
    for (const { member_id } of rows) {
      const history = await read({dimension, member_id:String(member_id),
        brand_id:'', from, to:period}, {pool});
      if (history.observations.length !== 18 || history.observations.at(-1)?.state === 'MISSING_RECORD')
        throw new Error('INVALID_SEPTEMBER_TRAJECTORY');
      const observations = history.observations.map(x => ({
        period_identity:x.period, value:x.vin_sales, evidence_id:x.evidence_id,
      }));
      const statistical = classify({observations,storeId:String(member_id),period});
      const observed_months = observations.filter(x=>x.value!=null).length;
      const insufficient_history = from > POLICY.history_start_month
        || statistical.sufficient_evidence !== true;
      const discontinuous_history = !history.continuous;
      results.push({
        dimension,member_id:String(member_id),brand_id:'',period,
        state:discontinuous_history || statistical.sufficient_evidence !== true
          ? 'UNKNOWN' : statistical.state,
        experimental_state:statistical.state,
        reason:discontinuous_history ? 'INCOMPLETE_STORED_HISTORY'
          : statistical.reason,
        observed_months,evaluable_months:statistical.coverage.evaluable_rows,
        missing_months:history.missing_months,zero_months:history.zero_months,
        insufficient_history,discontinuous_history,
        evidence_refs:observations.filter(x=>x.evidence_id).map(x=>({
          period:x.period_identity,evidence_id:x.evidence_id,
        })),
      });
    }
    progress({dimension,entities:rows.length});
  }
  const counts = {IMPROVING:0,STABLE:0,DETERIORATING:0,UNKNOWN:0};
  for (const result of results) counts[result.state]++;
  return {experimental:true,p2_certified:false,period,from,brand_id:'',
    policy_id:POLICY.policy_id,policy_history_start:POLICY.history_start_month,
    months_requested:18,counts,results};
}

if (process.argv[1]?.endsWith('/evaluate-september-sales.js')) {
  try {
    const output = await evaluateSeptemberSales({progress:x=>console.error(JSON.stringify(x))});
    console.log(JSON.stringify(output,null,2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally { await closeAzurePool(); }
}
