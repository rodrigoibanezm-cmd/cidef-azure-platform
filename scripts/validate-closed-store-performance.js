import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { executeP2 } from '../lib/p2/execute.js';
import { buildCurrentDeteriorationStatus } from '../lib/p2/closed-performance/legacy/deterioration/buildCurrentDeteriorationStatus.js';
import { calculateDeviations } from '../lib/p2/closed-performance/legacy/deterioration/orgDeviations.js';
import { shiftMonth } from '../lib/p2/closed-performance/legacy/expectation/monthSeries.js';

const inputPath=process.argv[2],outputPath=process.argv[3];
if(!inputPath||!outputPath)throw new Error('Usage: node scripts/validate-closed-store-performance.js INPUT.json OUTPUT.json');
const bytes=readFileSync(inputPath),input=JSON.parse(bytes);
assert.equal(input.period,'2026-09');
const evidence=input.evidence,target=evidence.history_2026_09;
assert.ok(target,'Certified September STORE evidence is required even if older history is unavailable');
const stores=target.payload.members.filter(r=>/^\d+$/.test(String(r.member_id)));
const results=[];
for(const store of stores){
  const execution=await executeP2({run_id:input.run_id,unit_id:'p2.closed_period_store_performance',
    contract_version:'0.1.0',evidence,parameters:{cutoff_month:input.period,store_id:String(store.member_id)}});
  assert.equal(execution.status,'EXECUTED',JSON.stringify(execution.error));
  const r=execution.result;
  let parity='NOT_EVALUATED_MISSING_P1_HISTORY';
  if(r.original_deterioration){
    const months=new Map(r.evidence.observations.filter(o=>o.value>0).map(o=>[o.period_identity,o.value]));
    const rows=[],errors=[];
    for(const [month,sales] of months){
      const history=Array.from({length:12},(_,i)=>months.get(shiftMonth(month,-i-1)));
      if(history.some(v=>v==null))continue;
      const baseline=history.reduce((a,b)=>a+b,0)/12;
      const deviations=calculateDeviations(sales,baseline,errors);
      rows.push({unit_id:r.store_id,month,sales,baseline:'moving_average_12',baseline_value:baseline,deviations});
      errors.push(deviations.error);
    }
    const expected=buildCurrentDeteriorationStatus(rows,new Map([[r.store_id,{unit_id:r.store_id,unit_label:r.store_label??r.store_id,months}]]),input.period).statuses[0];
    assert.deepEqual(r.original_deterioration,expected);
    assert.equal(r.state==='DETERIORATING',expected.status==='DETERIORATING');
    parity='SAME_INPUT_FULL_ORIGINAL_STATUS_MATCH';
  }
  // Compact report: original P1 objects remain unmodified in the input artifact.
  const {evidence:detail,...result}=r;
  const {evidence_refs,...lineage}=execution.lineage;
  results.push({result,parity,p1_observations:detail.observations,
    lineage:{...lineage,evidence_refs_pointer:'#/p1_refs'}});
}
assert.equal(stores.reduce((s,r)=>s+r.value,0),target.coverage.filtered_n);
const report={
  validation_mode:'LOCAL_P2_EXECUTION_WITH_ORIGINAL_AZURE_P1_EVIDENCE',
  generated_at:new Date().toISOString(),run_id:input.run_id,period:input.period,cutoff:'2026-09-30',
  p1_input_sha256:createHash('sha256').update(bytes).digest('hex'),
  repository_base_commit:input.repository_base_commit,legacy_reference:'16f01f381238bc058c3e25e88dca7b550aa487f7',
  p2_source_sha256:Object.fromEntries([
    'lib/p2/closed-performance/classify.js','lib/p2/units/closed-period-store-performance.js',
    'lib/p2/registry.js','lib/p2/execute.js',
  ].map(path=>[path,createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex')])),
  production_deployed:false,remote_p2_execution:false,legacy_raw_acquisition_parity:'NOT_VERIFIED',
  coverage:{stores:stores.length,september_sales:target.coverage.filtered_n,p1_months:Object.keys(evidence).length},
  counts:results.reduce((a,x)=>(a[x.result.state]++,a),{IMPROVING:0,STABLE:0,DETERIORATING:0,UNKNOWN:0}),
  p1_refs:Object.entries(evidence).map(([slot,e])=>({slot,evidence_id:e.evidence_id,evidence_contract:e.evidence_contract,evidence_version:e.evidence_version,temporal:e.temporal})),
  results,
};
writeFileSync(outputPath,JSON.stringify(report)+'\n');
console.log(JSON.stringify({coverage:report.coverage,counts:report.counts,results:results.map(x=>({
  store_id:x.result.store_id,store:x.result.store_label,sales:x.result.observed_sales,
  state:x.result.state,original:x.result.original_deterioration?.status??null,
  reason:x.result.reason,baseline:x.result.current?.baseline??null,
  error:x.result.current?.error??null,percentile:x.result.current?.historical_percentile??null,
  improvement:x.result.improvement_episode,parity:x.parity,
}))},null,2));
