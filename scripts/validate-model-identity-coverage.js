import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { executeP2 } from '../lib/p2/execute.js';
import { classifyClosedPerformance } from '../lib/p2/closed-performance/classify.js';

const dir=resolve(process.argv[2]??'docs/validation/model-identity-coverage-2026-09');
const inputBytes=readFileSync(join(dir,'p1-inputs.json')),input=JSON.parse(inputBytes);
const target=input.evidence.history_2026_09;
const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
assert.equal(target.authority,'P1_CERTIFIED');assert.equal(target.status,'CERTIFIED');
assert.equal(input.total.authority,'P1_CERTIFIED');assert.equal(input.total.status,'CERTIFIED');
assert.equal(input.total.source,'SALES');assert.equal(input.total.measure.id,'VIN_SALES');
assert.equal(input.total.evidence_contract,'p1.quantitative_observation');assert.deepEqual(input.total.dimensions,{});
assert.equal(input.total.universe.commercial_universe,'COMPANY');
assert.equal(input.total.temporal.date_from,'2026-09-01');assert.equal(input.total.temporal.date_to,'2026-09-30');
assert.equal(target.coverage.dimension_unresolved_n,0);
const members=target.payload.members.filter(m=>m.member_id!=='UNRESOLVED'&&m.value>0);
assert.equal(members.length,20);assert.equal(Object.keys(input.evidence).length,69);
assert.equal(members.reduce((n,m)=>n+m.value,0),input.total.payload.value);
assert.equal(target.coverage.filtered_n,input.total.payload.value);
const counts={IMPROVING:0,STABLE:0,DETERIORATING:0,UNKNOWN:0},rows=[];
let p1Refs,p2Refs;
for(const m of members){
  const execution=await executeP2({run_id:input.run_id,unit_id:'p2.closed_period_sales_performance',
    evidence:input.evidence,parameters:{cutoff_month:'2026-09',dimension:'MODEL',member_id:m.member_id}});
  assert.equal(execution.status,'EXECUTED',JSON.stringify(execution.error));
  const r=execution.result;assert.equal(r.observed_sales,m.value);
  if(!r.coverage.unresolved_identity_periods.length){
    const core=classifyClosedPerformance({observations:r.evidence.observations,storeId:m.member_id,
      storeLabel:m.member_label,period:'2026-09'});
    for(const key of ['state','reason','current','original_deterioration','improvement_episode','statistical_evidence'])assert.deepEqual(r[key],core[key]);
  }
  p1Refs??=r.evidence.refs;p2Refs??=execution.lineage.evidence_refs;
  assert.deepEqual(r.evidence.refs,p1Refs);assert.deepEqual(execution.lineage.evidence_refs,p2Refs);
  const {evidence,...result}=r,{evidence_refs,...lineage}=execution.lineage;
  assert.ok(Object.hasOwn(counts,r.state));counts[r.state]++;
  rows.push({result,p1_observations:evidence.observations,
    result_sha256:hash(JSON.stringify(canonical(r))),
    p1_refs_pointer:'#/p1_refs',lineage:{...lineage,evidence_refs_pointer:'#/p2_evidence_refs'}});
}
const sourceFiles=['lib/p2/closed-performance/model-identity-coverage.js','lib/p2/closed-performance/sales-dataset-adapter.js',
  'lib/p2/units/closed-period-sales-performance.js','lib/p2/closed-performance/classify.js'];
const report={run_id:input.run_id,period:'2026-09',cutoff:'2026-09-30',mode:'LOCAL_P2_ORIGINAL_AZURE_P1',
  remote_p2_execution:false,deployed:false,evaluated_members:rows.length,state_counts:counts,
  september_p1_total:input.total.payload.value,history_start:'2021-01',history_end:'2026-09',
  p1_months:Object.keys(input.evidence).length,input_sha256:hash(inputBytes),result_hash_format:'SHA256_CANONICAL_SORTED_KEYS_FULL_P2_RESULT',
  source_sha256:Object.fromEntries(sourceFiles.map(p=>[p,hash(readFileSync(new URL('../'+p,import.meta.url)))])),
  p1_refs:p1Refs,p2_evidence_refs:p2Refs,results:rows};
for(const row of rows)assert.equal(hash(JSON.stringify(canonical({...row.result,
  evidence:{refs:report.p1_refs,observations:row.p1_observations}}))),row.result_sha256);
writeFileSync(join(dir,'p2-results.json'),JSON.stringify(report)+'\n');
const csv=[['model_id','model','september_vin','state','reason','formal_rows','evaluable_rows','identity_relevant_periods',
  'identity_excluded_periods','baseline','error','percentile','execution_id']];
for(const row of rows){const r=row.result,c=r.coverage;csv.push([r.member_id,r.member_label,r.observed_sales,r.state,r.reason,
  c.formal_rows,c.evaluable_rows,c.unresolved_identity_periods.map(p=>p.period).join('|'),
  c.identity_validation.excluded_unresolved_periods.map(p=>p.period).join('|'),
  r.current?.baseline,r.current?.error,r.current?.historical_percentile,row.lineage.execution_id]);}
writeFileSync(join(dir,'individual-results.csv'),csv.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n');
console.log(JSON.stringify({state_counts:counts,september_p1_total:report.september_p1_total,
  results:rows.map(({result:r})=>({id:r.member_id,model:r.member_label,sales:r.observed_sales,state:r.state,reason:r.reason}))},null,2));
