import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { executeP2 } from '../lib/p2/execute.js';

const dir=resolve(process.argv[2]??'docs/validation/closed-sales-performance-2026-09');
const root=new URL('../',import.meta.url);
const hash=v=>createHash('sha256').update(v).digest('hex');
const read=path=>JSON.parse(readFileSync(path));
const states=()=>({IMPROVING:0,STABLE:0,DETERIORATING:0,UNKNOWN:0});
const sourceFiles=['lib/p2/closed-performance/classify.js','lib/p2/closed-performance/sales-dimensions.js',
  'lib/p2/closed-performance/sales-dataset-adapter.js','lib/p2/units/closed-period-sales-performance.js','lib/p2/registry.js'];
const report={period:'2026-09',cutoff:'2026-09-30',generated_at:new Date().toISOString(),
  mode:'LOCAL_P2_WITH_ORIGINAL_AZURE_P1',remote_p2_execution:false,deployed:false,
  source_sha256:Object.fromEntries(sourceFiles.map(p=>[p,hash(readFileSync(new URL(p,root)))])),dimensions:{}};

function compact(execution,dimension,refsPointer){
  const r=execution.result,{evidence_refs,...lineage}=execution.lineage;
  const id=r.member_id??r.store_id,label=r.member_label??r.store_label;
  return {dimension,member_id:id,member_label:label,observed_sales:r.observed_sales,state:r.state,reason:r.reason,
    identity_contract:r.identity_contract??'sucursales_master',identity_version:r.identity_version??'0.1',
    identity_status:r.identity_status??'P1_OBSERVED',
    observation_state:r.observation_state??r.evidence.observations.at(-1)?.observation_state,
    current:r.current,sufficient_evidence:r.sufficient_evidence,original_deterioration:r.original_deterioration,
    improvement_episode:r.improvement_episode,coverage:r.coverage,
    policy:r.policy,result_sha256:hash(JSON.stringify(r)),statistical_rows:r.statistical_evidence.length,
    last_four_months:r.evidence.observations.filter(o=>o.period_identity>='2026-06'),
    lineage:{...lineage,evidence_refs_pointer:refsPointer}};
}
for(const dimension of ['SELLER','MODEL']){
  const file=join(dir,'p1-'+dimension.toLowerCase()+'.json'),bytes=readFileSync(file),input=JSON.parse(bytes);
  assert.equal(input.period,report.period);
  const target=input.evidence.history_2026_09;assert.ok(target);
  const members=new Map();
  for(const e of Object.values(input.evidence)){
    for(const m of e.payload.members)if(/^\d+$/.test(String(m.member_id)))members.set(String(m.member_id),m.member_label);
  }
  const rows=[],counts=states(),septemberCounts=states();
  for(const memberId of [...members.keys()].sort((a,b)=>Number(a)-Number(b))){
    const execution=await executeP2({run_id:input.run_id,unit_id:'p2.closed_period_sales_performance',
      evidence:input.evidence,parameters:{cutoff_month:input.period,dimension,member_id:memberId}});
    assert.equal(execution.status,'EXECUTED',JSON.stringify(execution.error));
    const row=compact(execution,dimension,'#/dimensions/'+dimension+'/p1_refs');
    rows.push(row);counts[row.state]++;if(row.observed_sales!=null)septemberCounts[row.state]++;
  }
  const sum=rows.reduce((s,r)=>s+(r.observed_sales??0),0);
  assert.equal(sum,target.coverage.dimension_resolved_n);
  const missing=[];for(let y=2021;y<=2026;y++)for(let m=1;m<=12;m++){
    const p=y+'-'+String(m).padStart(2,'0');if(p<=input.period&&!input.evidence['history_'+p.replace('-','_')])missing.push(p);
  }
  report.dimensions[dimension]={status:'LOCAL_VALIDATED',run_id:input.run_id,
    census:'UNION_OF_CANONICAL_IDS_OBSERVED_IN_P1_2021_01_TO_2026_09_NOT_AN_ACTIVE_ROSTER',
    evaluated_members:rows.length,classified_members:rows.filter(r=>r.state!=='UNKNOWN').length,state_counts:counts,
    september_observed_members:rows.filter(r=>r.observed_sales!=null).length,september_state_counts:septemberCounts,
    p1_months:Object.keys(input.evidence).length,missing_p1_months:missing,
    input_sha256:hash(bytes),input_file:'p1-'+dimension.toLowerCase()+'.json',
    september_p1_total:target.coverage.filtered_n,september_unresolved_sales:target.coverage.dimension_unresolved_n,
    history_unresolved_identity:Object.values(input.evidence).filter(e=>e.coverage.dimension_unresolved_n>0)
      .map(e=>({period:e.temporal.period_identity,value:e.coverage.dimension_unresolved_n,evidence_id:e.evidence_id})),
    p1_refs:Object.entries(input.evidence).map(([slot,e])=>({slot,evidence_id:e.evidence_id,
      evidence_contract:e.evidence_contract,evidence_version:e.evidence_version,temporal:e.temporal})),results:rows};
}

// Replay the immutable original STORE evidence; no current source refresh or edits.
const storeInput=read(new URL('docs/validation/closed-store-performance-2026-09-p1.json',root));
const storeBaseline=read(new URL('docs/validation/closed-store-performance-2026-09-p2.json',root));
const storeRows=[],storeCounts=states();
for(const baseline of storeBaseline.results){
  const execution=await executeP2({run_id:storeInput.run_id,unit_id:'p2.closed_period_store_performance',
    evidence:storeInput.evidence,parameters:baseline.result.parameters});
  assert.equal(execution.status,'EXECUTED');
  const {evidence,...result}=execution.result;
  assert.deepEqual(result,baseline.result);assert.deepEqual(evidence.observations,baseline.p1_observations);
  const row=compact(execution,'STORE','#/dimensions/STORE/p1_refs');
  storeRows.push(row);storeCounts[row.state]++;
}
assert.deepEqual(storeCounts,{IMPROVING:1,STABLE:9,DETERIORATING:0,UNKNOWN:4});
report.dimensions.STORE={status:'EXACT_PREVIOUS_BASELINE_MATCH_14_OF_14',run_id:storeInput.run_id,
  census:'ORIGINAL_C3EE707_SEPTEMBER_P1_CENSUS_UNCHANGED',evaluated_members:14,
  state_counts:storeCounts,p1_months:69,p1_refs:storeBaseline.p1_refs,results:storeRows};
const dealer=read(join(dir,'dealer-group-capability.json')),fetch=dealer.p1_fetch;
const groupIds=[...new Set(fetch.rows.map(r=>r.dealer_group_id).filter(v=>v!=null).map(String))].sort((a,b)=>Number(a)-Number(b));
report.dimensions.DEALER_GROUP={status:'BLOCKED_P1_IDENTITY_CONTRACT',evaluated_members:0,state_counts:null,
  run_id:dealer.run_id,observed_group_ids:groupIds,observed_group_ids_count:groupIds.length,
  p1_september_sales:fetch.size.filtered_n,p2_execution:null,
  reason:'P1 exposes dealer_group_id fields/filters, but no dimensional identity contract/version, group membership history or dimension roster.',
  results:groupIds.map(member_id=>({member_id,state:null,status:'BLOCKED_P1_IDENTITY_CONTRACT',p2_execution:null}))};
writeFileSync(join(dir,'p2-results.json'),JSON.stringify(report)+'\n');
const csv=[['dimension','member_id','member_label','september_sales','state','reason','baseline','error','percentile',
  'positive_months','evaluable_rows','execution_id']];
for(const d of ['STORE','SELLER','MODEL'])for(const r of report.dimensions[d].results){
  csv.push([d,r.member_id,r.member_label,r.observed_sales,r.state,r.reason,r.current?.baseline,r.current?.error,
    r.current?.historical_percentile,r.coverage.observed_positive_months,r.coverage.evaluable_rows,r.lineage.execution_id]);
}
for(const r of report.dimensions.DEALER_GROUP.results)csv.push(['DEALER_GROUP',r.member_id,null,null,null,r.status]);
writeFileSync(join(dir,'individual-results.csv'),csv.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.dimensions).map(([d,r])=>[d,{
  status:r.status,evaluated:r.evaluated_members,state_counts:r.state_counts,
  september_members:r.september_observed_members,september_state_counts:r.september_state_counts,
  unknown_history:r.history_unresolved_identity,p1_months:r.p1_months,observed_groups:r.observed_group_ids_count,
}])),null,2));
