import test from 'node:test';
import assert from 'node:assert/strict';
import { executeP2 } from '../lib/p2/execute.js';
import { classifyClosedPerformance } from '../lib/p2/closed-performance/classify.js';
import { shiftMonth } from '../lib/p2/closed-performance/legacy/expectation/monthSeries.js';

const slot = (a,b) => 'series_' + a.replace('-','_') + '_' + b.replace('-','_');
function series(from='2025-05', to='2026-09', values={}) {
  const observations=[];
  for(let m=from;m<=to;m=shiftMonth(m,1)) observations.push({period_identity:m,
    value:values[m]??120,evidence_id:'synthetic:'+m});
  return {[slot(from,to)]:{authority:'P1_CERTIFIED',status:'CERTIFIED',source:'SALES',
    evidence_id:'synthetic:series:'+from+to,evidence_contract:'p1.period_observation_series',evidence_version:'0.1.0',
    grain:'COMMERCIAL_MONTH',measure:{id:'VIN_SALES',unit:'VIN',aggregation:'COUNT_RECOGNIZED_SALE'},
    universe:{commercial_universe:'DEALERS'},dimensions:{dealer_group_id:3},
    temporal:{period_type:'COMMERCIAL_MONTH',period_from:from,period_to:to,ordering:'ASCENDING'},
    coverage:{requested_periods:observations.length,observed_periods:observations.length,gaps:[]},payload:{observations},
    lineage:{certifier:'salesCertifier',certifier_version:'0.13',component_evidence_ids:observations.map(o=>o.evidence_id)}}};
}
const run=(evidence,extra={})=>executeP2({run_id:'synthetic-dealer-test',unit_id:'p2.closed_period_sales_performance',
  evidence,parameters:{cutoff_month:'2026-09',dimension:'DEALER_GROUP',member_id:'3',...extra}});

test('dealer series preserves all four states and exact same-input statistical parity',async()=>{
  for(const [values,state] of [[{},'STABLE'],[{'2026-08':144,'2026-09':180},'IMPROVING'],
    [{'2026-08':96,'2026-09':60},'DETERIORATING'],[{'2026-08':0},'UNKNOWN']]){
    const evidence=series('2025-05','2026-09',values),before=structuredClone(evidence);
    const execution=await run(evidence);assert.equal(execution.status,'EXECUTED');
    const r=execution.result;assert.equal(r.state,state);
    const original=classifyClosedPerformance({observations:r.evidence.observations,storeId:'3',period:'2026-09'});
    for(const k of ['state','reason','current','original_deterioration','improvement_episode','statistical_evidence'])assert.deepEqual(r[k],original[k]);
    assert.deepEqual(evidence,before);assert.equal(r.identity_contract,null);
    assert.equal(r.grouping_semantics,'CURRENT_COMMERCIAL_GROUPING');
    assert.equal(execution.lineage.evidence_refs[0].evidence_id,Object.values(evidence)[0].evidence_id);
  }
});
test('13 months do not suffice; four actual preceding months allow percentiles and confirmation',async()=>{
  let r=(await run(series('2025-09'))).result;
  assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'DEVIATION_UNAVAILABLE');
  r=(await run({...series('2025-05','2025-08'),...series('2025-09')})).result;
  assert.equal(r.state,'STABLE');assert.equal(r.coverage.evaluable_rows,2);
  assert.equal(r.current.historical_percentile,.5);
});
test('zero sales, missing observation, and missing series are separate',async()=>{
  const zero=(await run(series('2025-05','2026-09',{'2026-09':0}))).result;
  assert.equal(zero.observed_sales,0);assert.equal(zero.observation_state,'ZERO_SALES_ACTIVITY_UNVERIFIED');
  assert.equal(zero.state,'UNKNOWN');
  const e=series(),s=Object.values(e)[0];s.payload.observations.pop();s.coverage.observed_periods--;s.coverage.gaps=['2026-09'];
  const absent=(await run(e)).result;assert.equal(absent.observed_sales,null);
  assert.equal(absent.reason,'P1_HISTORY_COVERAGE_INCOMPLETE');assert.deepEqual(absent.coverage.missing_p1_periods,['2026-09']);
  assert.equal((await run({})).result.reason,'P1_HISTORY_COVERAGE_INCOMPLETE');
});
test('retains original episode persistence when error stops deepening',async()=>{
  for(const [values,state] of [[{'2026-07':144,'2026-08':180,'2026-09':150},'IMPROVING'],
    [{'2026-07':96,'2026-08':60,'2026-09':90},'DETERIORATING']]){
    const r=(await run(series('2025-01','2026-09',values))).result;
    assert.equal(r.state,state);
    assert.equal((r.improvement_episode??r.original_deterioration).confirmation_month,'2026-08');
  }
});
test('rejects wrong source, filters, authority, coverage, component refs and overlapping history',async()=>{
  const mutations=[s=>s.authority='OBSERVED_NOT_CERTIFIED',s=>s.evidence_contract='p1.temporal_fingerprint',
    s=>s.source='FORUM',s=>s.universe.commercial_universe='COMPANY',s=>s.dimensions.dealer_group_id=4,
    s=>s.dimensions.brand_id=89,s=>s.coverage.observed_periods--,s=>s.temporal.cutoff='2026-09-29',
    s=>s.payload.observations[0].value=-1,s=>s.payload.observations[0].value='120',
    s=>s.payload.observations.push(s.payload.observations[0]),s=>s.lineage.component_evidence_ids=[],
    s=>s.temporal.period_to='2026-10',s=>s.lineage.certifier_version=null,s=>s.lineage.certifier_version='0.14'];
  for(const mutate of mutations){const e=series();mutate(Object.values(e)[0]);assert.equal((await run(e)).status,'INVALID_EXECUTION');}
  assert.equal((await run({...series(),...series('2025-09')})).status,'INVALID_EXECUTION');
  assert.equal((await run(series(),{threshold:.7})).status,'INVALID_EXECUTION');
  assert.equal((await run(series(),{cutoff_month:'2099-01'})).status,'INVALID_EXECUTION');
});
