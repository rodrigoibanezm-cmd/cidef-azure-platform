import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { executeP2 } from '../lib/p2/execute.js';
import { classifyClosedPerformance } from '../lib/p2/closed-performance/classify.js';

const dir=resolve(process.argv[2]??'docs/validation/closed-dealer-performance-2026-09');
const input=JSON.parse(readFileSync(join(dir,'p1-inputs.json')));
const hash=x=>createHash('sha256').update(x).digest('hex');
const counts={IMPROVING:0,STABLE:0,DETERIORATING:0,UNKNOWN:0},results=[];
assert.equal(input.total.payload.value,661);
assert.equal(input.total.authority,'P1_CERTIFIED');assert.equal(input.total.status,'CERTIFIED');
assert.equal(input.total.source,'SALES');assert.equal(input.total.evidence_contract,'p1.quantitative_observation');
assert.equal(input.total.measure.id,'VIN_SALES');assert.equal(input.total.universe.commercial_universe,'DEALERS');
assert.deepEqual(input.total.dimensions,{});
assert.equal(input.total.temporal.date_from,'2026-09-01');assert.equal(input.total.temporal.date_to,'2026-09-30');
assert.equal(input.roster.source,'SALES');assert.equal(input.roster.version,'0.13');
assert.equal(input.roster.quality.validation.valid,true);
assert.equal(input.roster.rows.length,input.total.payload.value);
const ids=[...new Set(input.roster.rows.map(r=>String(r.dealer_group_id)))].sort((a,b)=>Number(a)-Number(b));
assert.equal(ids.length,18);assert.ok(ids.every(x=>/^\d+$/.test(x)));
for(const id of ids){
  const evidence=input.groups[id]??{};
  const execution=await executeP2({run_id:input.run_id,unit_id:'p2.closed_period_sales_performance',
    evidence,parameters:{cutoff_month:'2026-09',dimension:'DEALER_GROUP',member_id:id}});
  assert.equal(execution.status,'EXECUTED',JSON.stringify(execution.error));
  const r=execution.result;
  if(r.observed_sales!=null)assert.equal(r.observed_sales,input.roster.rows.filter(row=>String(row.dealer_group_id)===id).length,'P1 September group reconciliation '+id);
  if(!r.coverage.missing_p1_periods.length){
    const same=classifyClosedPerformance({observations:r.evidence.observations,storeId:id,period:'2026-09'});
    for(const key of ['state','reason','current','original_deterioration','improvement_episode','statistical_evidence'])assert.deepEqual(r[key],same[key]);
  }
  counts[r.state]++;results.push(execution);
}
const sum=results.reduce((n,e)=>n+(e.result.observed_sales??0),0);
const complete=results.every(e=>e.result.observed_sales!=null);
if(complete)assert.equal(sum,input.total.payload.value);
const root=new URL('../',import.meta.url);
const sources=['lib/p2/closed-performance/classify.js','lib/p2/closed-performance/dealer-series-adapter.js',
  'lib/p2/units/closed-period-sales-performance.js','lib/p2/registry.js'];
const report={run_id:input.run_id,period:'2026-09',cutoff:'2026-09-30',
  mode:'LOCAL_P2_ORIGINAL_AZURE_P1',remote_p2_execution:false,deployed:false,
  grouping_semantics:'CURRENT_COMMERCIAL_GROUPING',evaluated_members:results.length,state_counts:counts,
  reconciliation:{expected:input.total.payload.value,observed:sum,complete,passed:complete&&sum===661},
  input_sha256:hash(readFileSync(join(dir,'p1-inputs.json'))),
  source_sha256:Object.fromEntries(sources.map(p=>[p,hash(readFileSync(new URL(p,root)))])),results};
writeFileSync(join(dir,'p2-results.json'),JSON.stringify(report)+'\n');
const csv=[['dealer_group_id','september_vin','state','reason','history_start','history_end','positive_months',
  'evaluable_rows','explicit_zero_periods','missing_periods','baseline','error','percentile','execution_id']];
for(const e of results){const r=e.result;csv.push([r.member_id,r.observed_sales,r.state,r.reason,
  r.coverage.history_start,r.coverage.history_end,r.coverage.observed_positive_months,r.coverage.evaluable_rows,
  r.coverage.explicit_zero_periods.join('|'),r.coverage.missing_p1_periods.join('|'),r.current?.baseline,
  r.current?.error,r.current?.historical_percentile,e.lineage.execution_id]);}
writeFileSync(join(dir,'individual-results.csv'),csv.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n');
console.log(JSON.stringify({state_counts:counts,reconciliation:report.reconciliation,
  results:results.map(e=>({id:e.result.member_id,sales:e.result.observed_sales,state:e.result.state,
    reason:e.result.reason,start:e.result.coverage.history_start,evaluable:e.result.coverage.evaluable_rows}))},null,2));
