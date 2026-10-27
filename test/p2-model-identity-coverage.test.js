import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { executeP2 } from '../lib/p2/execute.js';
import { modelIdentityCoverage } from '../lib/p2/closed-performance/model-identity-coverage.js';
import { classifyClosedPerformance } from '../lib/p2/closed-performance/classify.js';
import { shiftMonth } from '../lib/p2/closed-performance/legacy/expectation/monthSeries.js';

const archive=()=>JSON.parse(readFileSync(new URL('../docs/validation/closed-sales-performance-2026-09/p1-model.json',import.meta.url)));
const run=(input,id)=>executeP2({run_id:input.run_id,unit_id:'p2.closed_period_sales_performance',
  evidence:input.evidence,parameters:{cutoff_month:'2026-09',dimension:'MODEL',member_id:id}});

test('irrelevant identity residual does not truncate history, alter values or discard prior errors',async()=>{
  const input=archive(),before=structuredClone(input),execution=await run(input,'17');
  assert.equal(execution.status,'EXECUTED');const r=execution.result;
  assert.equal(r.state,'IMPROVING');assert.equal(r.coverage.history_start,'2021-01');
  assert.equal(r.evidence.observations.length,69);assert.equal(r.evidence.refs.length,69);
  assert.equal(r.coverage.identity_validation.history_truncated,false);
  assert.equal(r.coverage.identity_validation.allocated_unresolved_sales,false);
  assert.deepEqual(r.coverage.unresolved_identity_periods,[]);
  const excluded=r.coverage.identity_validation.excluded_unresolved_periods;
  assert.equal(excluded.length,1);assert.equal(excluded[0].period,'2021-06');
  assert.equal(excluded[0].value,1);assert.equal(excluded[0].evidence_id,input.evidence.history_2021_06.evidence_id);
  const same=classifyClosedPerformance({observations:r.evidence.observations,storeId:'17',storeLabel:r.member_label,period:'2026-09'});
  for(const key of ['state','reason','current','original_deterioration','improvement_episode','statistical_evidence'])assert.deepEqual(r[key],same[key]);
  assert.ok(r.statistical_evidence.length>5);assert.deepEqual(input,before);
});

test('old residual still blocks a model whose historical errors can change current percentiles',async()=>{
  const r=(await run(archive(),'176')).result;
  assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'P1_IDENTITY_COVERAGE_INCOMPLETE');
  const affected=r.coverage.identity_validation.relevant_unresolved_periods[0];
  assert.equal(affected.period,'2021-06');assert.ok(affected.affected_statistical_periods.includes('2022-01'));
  assert.equal(r.statistical_evidence.length,0);
});

test('insufficient recent history remains UNKNOWN after unrelated residual is excluded',async()=>{
  const r=(await run(archive(),'612')).result;
  assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'BASELINE_UNAVAILABLE');
  assert.equal(r.coverage.identity_validation.excluded_unresolved_periods.length,1);
});

test('a residual can create a previously missing formal row; it cannot be ignored',()=>{
  const observations=[];
  for(let m='2024-01';m<='2026-09';m=shiftMonth(m,1))observations.push({period_identity:m,value:m==='2024-06'?null:10});
  const c=modelIdentityCoverage(observations,[{period:'2024-06',value:1,evidence_id:'synthetic:missing'}],'2026-09');
  assert.equal(c.relevant_unresolved_periods.length,1);
  assert.ok(c.relevant_unresolved_periods[0].affected_statistical_periods.includes('2025-01'));
});

test('multiple unresolved months are considered jointly and missing P1 evidence is never waived',()=>{
  const observations=[];
  for(let m='2024-01';m<='2026-09';m=shiftMonth(m,1))observations.push({period_identity:m,value:['2024-06','2024-07'].includes(m)?null:10});
  const unresolved=['2024-06','2024-07'].map(period=>({period,value:1,evidence_id:'synthetic:'+period}));
  assert.equal(modelIdentityCoverage(observations,unresolved,'2026-09').relevant_unresolved_periods.length,2);
  const c=modelIdentityCoverage([],unresolved,'2026-09',['2025-01']);
  assert.equal(c.analysis_complete,false);assert.equal(c.relevant_unresolved_periods.length,2);
});

test('dependency scoping is generic across dates and has no VIN/member-ID exceptions',()=>{
  for(const start of ['2021-01','2023-03','2024-05']){
    const observations=[];const end=shiftMonth(start,35),gap=shiftMonth(start,2);
    for(let m=start;m<=end;m=shiftMonth(m,1))observations.push({period_identity:m,value:m<shiftMonth(start,15)?null:10});
    const c=modelIdentityCoverage(observations,[{period:gap,value:1,evidence_id:'synthetic:'+gap}],end);
    assert.equal(c.relevant_unresolved_periods.length,0);assert.equal(c.excluded_unresolved_periods.length,1);
  }
});

test('excluded residuals cannot affect statistical rows under any synthetic allocation',()=>{
  let seed=112358;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let trial=0;trial<150;trial++){
    const observations=Array.from({length:36},(_,k)=>({period_identity:shiftMonth('2023-01',k),value:next()%7===0?null:1+next()%30}));
    const residuals=[2,8,17].map(k=>({period:observations[k].period_identity,value:1,evidence_id:'synthetic:'+k}));
    const c=modelIdentityCoverage(observations,residuals,'2025-12');
    for(let mask=0;mask<8;mask++){
      const baseRows=observations.map(o=>{const k=residuals.findIndex(u=>u.period===o.period_identity);
        return k>=0&&(mask&(1<<k))?{...o,value:(o.value??0)+1}:o;});
      const base=classifyClosedPerformance({observations:baseRows,storeId:'synthetic',period:'2025-12'}).statistical_evidence;
      for(const u of c.excluded_unresolved_periods){
        const changed=baseRows.map(o=>o.period_identity===u.period?{...o,value:(o.value??0)+1}:o);
        assert.deepEqual(classifyClosedPerformance({observations:changed,storeId:'synthetic',period:'2025-12'}).statistical_evidence,base);
      }
    }
  }
});

test('all 250 previous STORE, SELLER and DEALER_GROUP results remain identical',async()=>{
  const read=p=>JSON.parse(readFileSync(new URL('../docs/validation/'+p,import.meta.url)));
  const stores=read('closed-store-performance-2026-09-p1.json');
  const storeBaseline=read('closed-store-performance-2026-09-p2.json');
  for(const row of storeBaseline.results){
    const e=await executeP2({run_id:stores.run_id,unit_id:'p2.closed_period_store_performance',
      evidence:stores.evidence,parameters:row.result.parameters});
    assert.equal(e.status,'EXECUTED');const {evidence,...result}=e.result;
    assert.deepEqual(result,row.result);assert.deepEqual(evidence.observations,row.p1_observations);
  }
  const sellers=read('closed-sales-performance-2026-09/p1-seller.json');
  const sellerBaseline=read('closed-sales-performance-2026-09/p2-results.json').dimensions.SELLER.results;
  for(const row of sellerBaseline){
    const e=await executeP2({run_id:sellers.run_id,unit_id:'p2.closed_period_sales_performance',evidence:sellers.evidence,
      parameters:{cutoff_month:'2026-09',dimension:'SELLER',member_id:row.member_id}});
    assert.equal(e.status,'EXECUTED');
    assert.equal(createHash('sha256').update(JSON.stringify(e.result)).digest('hex'),row.result_sha256);
  }
  const dealers=read('closed-dealer-performance-2026-09/p1-inputs.json');
  const dealerBaseline=read('closed-dealer-performance-2026-09/p2-results.json');
  for(const row of dealerBaseline.results){
    const e=await executeP2({run_id:dealers.run_id,unit_id:'p2.closed_period_sales_performance',
      evidence:dealers.groups[row.result.member_id],parameters:row.result.parameters});
    assert.equal(e.status,'EXECUTED');assert.deepEqual(e.result,row.result);
  }
  assert.equal(storeBaseline.results.length+sellerBaseline.length+dealerBaseline.results.length,250);
});
