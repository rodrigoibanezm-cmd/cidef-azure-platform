// Descriptive only: arithmetic mirrors observed-sequence, without P1/P2 certification.
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';
import { evaluateSeptemberSales } from './evaluate-september-sales.js';
import { readMonthlySalesTrajectory } from './read-monthly-sales-trajectory.js';

export function describeDealerMovements(history) {
  const movements = [];
  const values = history.observations;
  for (let i = 1; i < values.length; i++) {
    const previous = values[i-1], current = values[i];
    if (previous.vin_sales == null || current.vin_sales == null) continue;
    const absolute = current.vin_sales - previous.vin_sales;
    movements.push({
      from_period:previous.period, to_period:current.period,
      from_value:previous.vin_sales, to_value:current.vin_sales,
      absolute_delta:absolute,
      relative_delta:previous.vin_sales===0?null:absolute/previous.vin_sales,
      relative_delta_status:previous.vin_sales===0?'ZERO_BASELINE':'CALCULATED',
      direction:absolute>0?'UP':absolute<0?'DOWN':'FLAT',
      evidence_ids:[previous.evidence_id,current.evidence_id],
    });
  }
  const last = movements.at(-1);
  return {movements, recent_direction:last?.direction ?? 'INSUFFICIENT_EVIDENCE',
    last_movement:last ?? null,
    recent_consecutive_months:(()=>{
      let n=0;
      for(let i=values.length-1;i>=0&&values[i].vin_sales!=null;i--)n++;
      return n;
    })()};
}
export async function evaluateUnknownDealers({
  pool=getAzurePool(), evaluate=evaluateSeptemberSales,
  read=readMonthlySalesTrajectory,
}={}) {
  const evaluated = await evaluate({pool,dimensions:['DEALER_GROUP']});
  const unknown = evaluated.results.filter(row=>row.state==='UNKNOWN'
    && row.dimension==='DEALER_GROUP' && row.brand_id==='');
  const dealers=[];
  for (const row of unknown) {
    const history = await read({dimension:'DEALER_GROUP',member_id:row.member_id,
      brand_id:'',from:'2025-04',to:'2026-09'},{pool});
    const september = history.observations.at(-1);
    if (september?.period !== '2026-09' || !(september.vin_sales > 0)) continue;
    dealers.push({...row,dealer_group_id:row.member_id,dealer_group_name:null,
      september_vin:september.vin_sales,coverage:{observed_months:row.observed_months,
      evaluable_months:row.evaluable_months,missing_months:history.missing_months,
      zero_months:history.zero_months},...describeDealerMovements(history)});
  }
  return {experimental:true,p2_certified:false,period:'2026-09',brand_id:'',
    total_dealers_evaluated:evaluated.results.length,unknown_count:dealers.length,
    expected_unknown_count:9,expected_count_matches:dealers.length===9,
    dealers,limitation:'Stored monthly aggregates, not original P1 period series. Descriptive movements only.'};
}
if (process.argv[1]?.endsWith('/evaluate-unknown-dealers.js')) {
  try {
    const result = await evaluateUnknownDealers();
    console.table(result.dealers.map(d=>({
      dealer_group_id:d.dealer_group_id, name:d.dealer_group_name,
      september_vin:d.september_vin,observed:d.coverage.observed_months,
      missing:d.coverage.missing_months.length,recent_streak:d.recent_consecutive_months,
      last_delta_vin:d.last_movement?.absolute_delta??null,
      last_delta_percent:d.last_movement?.relative_delta==null?null:100*d.last_movement.relative_delta,
      direction:d.recent_direction,unknown_reason:d.reason,
    })));
    console.log(JSON.stringify(result,null,2));
  }
  catch(error){console.error(error.message);process.exitCode=1;}
  finally {await closeAzurePool();}
}
