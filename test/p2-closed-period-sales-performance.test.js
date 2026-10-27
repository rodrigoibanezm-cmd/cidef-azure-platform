import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeP2 } from '../lib/p2/execute.js';
import { describeP2Unit } from '../lib/p2/registry.js';
import { classifyClosedPerformance } from '../lib/p2/closed-performance/classify.js';
import { shiftMonth } from '../lib/p2/closed-performance/legacy/expectation/monthSeries.js';

const unit_id='p2.closed_period_sales_performance';
function fixture(dimension='SELLER',values={}){
  const config=dimension==='SELLER'?['OWN_STORES','personas_master']:['COMPANY','modelos_master_v01'];
  const evidence={};
  for(let p='2021-01';p<='2026-09';p=shiftMonth(p,1)){
    const [y,m]=p.split('-').map(Number),end=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);
    const value=Object.hasOwn(values,p)?values[p]:120;
    evidence['history_'+p.replace('-','_')]={
      authority:'P1_CERTIFIED',status:'CERTIFIED',source:'SALES',evidence_id:'synthetic:'+dimension+':'+p,
      evidence_contract:'p1.dimensional_quantitative_dataset',evidence_version:'0.1.0',
      grain:'FILTERED_SALES_UNIVERSE',measure:{id:'VIN_SALES'},universe:{commercial_universe:config[0]},dimensions:{},
      temporal:{period_identity:p,period_type:'COMMERCIAL_MONTH',cutoff:end,date_from:p+'-01',date_to:end},
      coverage:{filtered_n:value??0,dimension_resolved_n:value??0,dimension_unresolved_n:0},
      payload:{dimension:{id:dimension,identity_contract:config[1],identity_version:'0.1'},
        members:value==null?[]:[{member_id:'3',member_label:'Same label',value}]},lineage:{fixture:true},
    };
  }
  return evidence;
}
const run=(evidence=fixture(),dimension='SELLER',member_id='3',extra={})=>executeP2({
  run_id:'synthetic-extension-test',unit_id,evidence,parameters:{cutoff_month:'2026-09',dimension,member_id,...extra},
});
test('new contract admits only supported SALES identities and fixed rules',()=>{
  const c=describeP2Unit(unit_id);
  assert.deepEqual(c.deterministic_contract.parameters.dimension.allowed,['SELLER','MODEL','DEALER_GROUP']);
  assert.equal(describeP2Unit('p2.closed_period_store_performance').contract_version,'0.1.0');
});
for(const dimension of ['SELLER','MODEL']){
  test(dimension+' reuses exactly the four existing statistical outcomes',async()=>{
    const cases=[
      [{},'STABLE'],
      [{'2026-08':144,'2026-09':180},'IMPROVING'],
      [{'2026-08':96,'2026-09':60},'DETERIORATING'],
      [{'2026-09':null},'UNKNOWN'],
    ];
    for(const [values,state] of cases){
      const r=await run(fixture(dimension,values),dimension);
      assert.equal(r.status,'EXECUTED');assert.equal(r.result.state,state);
      const expected=classifyClosedPerformance({observations:r.result.evidence.observations,storeId:'3',storeLabel:'Same label',period:'2026-09'});
      for(const key of ['state','reason','current','original_deterioration','improvement_episode','statistical_evidence','sufficient_evidence']){
        assert.deepEqual(r.result[key],expected[key],key);
      }
    }
  });
  test(dimension+' keeps episode persistence and evidence thresholds',async()=>{
    const a=await run(fixture(dimension,{'2026-07':144,'2026-08':180,'2026-09':150}),dimension);
    assert.equal(a.result.state,'IMPROVING');assert.equal(a.result.improvement_episode.confirmation_month,'2026-08');
    assert.equal((await run(fixture(dimension,{'2026-07':96,'2026-08':60,'2026-09':90}),dimension)).result.state,'DETERIORATING');
    assert.equal((await run(fixture(dimension,{'2026-08':144,'2026-09':146}),dimension)).result.state,'STABLE');
    assert.equal((await run(fixture(dimension,{'2026-09':180}),dimension)).result.state,'STABLE');
  });
}
test('zero sales and missing information remain distinct without invented activity',async()=>{
  const zero=(await run(fixture('SELLER',{'2026-09':0}))).result;
  const absent=(await run(fixture('SELLER',{'2026-09':null}))).result;
  assert.equal(zero.observed_sales,0);assert.equal(zero.observation_state,'ZERO_SALES_ACTIVITY_UNVERIFIED');
  assert.equal(absent.observed_sales,null);assert.equal(absent.observation_state,'NOT_OBSERVED');
  assert.equal(zero.state,'UNKNOWN');assert.equal(absent.state,'UNKNOWN');
  assert.deepEqual(zero.coverage.explicit_zero_periods,['2026-09']);
  assert.deepEqual(absent.coverage.unobserved_member_periods,['2026-09']);
});
test('historical gaps break references, without stitching identities',async()=>{
  const r=(await run(fixture('SELLER',{'2026-08':null}))).result;
  assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'BASELINE_UNAVAILABLE');
  const e=fixture();
  for(const p of ['2026-08','2026-09'])e['history_'+p.replace('-','_')].payload.members[0].member_id='4';
  assert.equal((await run(e,'SELLER','3')).result.state,'UNKNOWN');
  assert.equal((await run(e,'SELLER','4')).result.state,'UNKNOWN');
});
test('equal labels with different IDs never merge',async()=>{
  const e=fixture();
  for(const x of Object.values(e)){x.payload.members.push({member_id:'4',member_label:'Same label',value:7});x.coverage.filtered_n+=7;x.coverage.dimension_resolved_n+=7;}
  assert.equal((await run(e,'SELLER','3')).result.observed_sales,120);
  assert.equal((await run(e,'SELLER','4')).result.observed_sales,7);
});
test('an arbitrary numeric ID is not certified as a canonical member',async()=>{
  const r=(await run(fixture(),'SELLER','999999')).result;
  assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'P1_MEMBER_IDENTITY_UNCONFIRMED');
  assert.equal(r.identity_status,'UNCONFIRMED');assert.equal(r.original_deterioration,null);
});
test('labels may change while the canonical ID remains continuous',async()=>{
  const e=fixture();e.history_2026_09.payload.members[0].member_label='Current canonical label';
  const r=(await run(e)).result;
  assert.equal(r.member_label,'Current canonical label');assert.equal(r.state,'STABLE');
  assert.equal(r.evidence.observations[0].member_label,'Same label');
});
test('missing P1 months and unresolved historical identity yield UNKNOWN, not truncated history',async()=>{
  const e=fixture('MODEL');delete e.history_2021_06;
  let r=(await run(e,'MODEL')).result;
  assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'P1_HISTORY_COVERAGE_INCOMPLETE');
  assert.deepEqual(r.coverage.missing_p1_periods,['2021-06']);
  const u=fixture('MODEL'),m=u.history_2021_06;
  m.payload.members.push({member_id:'UNRESOLVED',member_label:'No resuelto',value:1});
  m.coverage.filtered_n++;m.coverage.dimension_unresolved_n++;
  r=(await run(u,'MODEL')).result;
  assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'P1_IDENTITY_COVERAGE_INCOMPLETE');
  assert.deepEqual(r.coverage.unresolved_identity_periods,[{period:'2021-06',value:1,evidence_id:m.evidence_id}]);
  assert.equal(r.observed_sales,120);assert.equal(r.original_deterioration,null);
  assert.equal(r.coverage.observed_positive_months,69);assert.equal(r.coverage.first_observed_period,'2021-01');
});
test('rejects uncertified, wrong dimension/universe/identity, partial month and arbitrary rule parameters',async()=>{
  const mutations=[
    e=>e.history_2026_09.authority='OBSERVED_NOT_CERTIFIED',
    e=>e.history_2026_09.status='OBSERVED_NOT_CERTIFIED',
    e=>e.history_2026_09.source='RVM',
    e=>e.history_2026_09.universe.commercial_universe='COMPANY',
    e=>e.history_2026_09.payload.dimension.identity_version='0.2',
    e=>e.history_2026_09.payload.dimension.identity_contract='seller_raw',
    e=>e.history_2026_09.payload.dimension.id='MODEL',
    e=>e.history_2026_09.dimensions.store_id='3',
    e=>e.history_2026_09.temporal.cutoff='2026-09-29',
    e=>e.history_2026_09.payload.members.push(e.history_2026_09.payload.members[0]),
    e=>e.history_2026_09.coverage.filtered_n++,
    e=>e.history_2026_09.payload.members[0].value='120',
    e=>e.history_2026_09.payload.members[0].value=-1,
    e=>e.history_2026_09.payload.members[0].member_id='UNRESOLVED_RAW_ID',
    e=>e.bad=e.history_2026_09,
  ];
  for(const mutate of mutations){const e=fixture();mutate(e);assert.equal((await run(e)).status,'INVALID_EXECUTION');}
  assert.equal((await run(fixture(),'SELLER','3',{threshold:.7})).status,'INVALID_EXECUTION');
  assert.equal((await run(fixture(),'SELLER','3',{cutoff_month:'2099-01'})).status,'INVALID_EXECUTION');
});
test('does not accept dimensional evidence recast as dealer series, FETCH objects, temporal fingerprints or relabelled STORE evidence',async()=>{
  assert.equal((await run(fixture(),'DEALER_GROUP')).status,'INVALID_EXECUTION');
  for(const id of ['constructor','__proto__','toString',['SELLER'],null])assert.equal((await run({},id)).status,'INVALID_EXECUTION');
  assert.equal((await run({history_2026_09:{operation:'FETCH',source:'SALES',rows:[]}})).status,'INVALID_EXECUTION');
  const e=fixture();e.history_2026_09.evidence_contract='p1.temporal_fingerprint';
  assert.equal((await run(e)).status,'INVALID_EXECUTION');
  const store=JSON.parse(readFileSync(new URL('../docs/validation/closed-store-performance-2026-09-p1.json',import.meta.url)));
  assert.equal((await run(store.evidence)).status,'INVALID_EXECUTION');
});
test('evidence payloads and identities remain unchanged and P2 lineage preserves references',async()=>{
  const e=fixture(),before=structuredClone(e),r=await run(e);
  assert.deepEqual(e,before);assert.equal(r.lineage.evidence_refs.length,69);
  assert.equal(r.lineage.unit_id,unit_id);assert.equal(r.result.evidence.refs.length,69);
  assert.equal(r.result.policy.policy_id,'CLOSED_STORE_PERFORMANCE_MIRROR_V01');
});
test('STORE retains every prior result, value, coverage, trace input and original status',async()=>{
  const input=JSON.parse(readFileSync(new URL('../docs/validation/closed-store-performance-2026-09-p1.json',import.meta.url)));
  const baseline=JSON.parse(readFileSync(new URL('../docs/validation/closed-store-performance-2026-09-p2.json',import.meta.url)));
  const counts={IMPROVING:0,STABLE:0,DETERIORATING:0,UNKNOWN:0};
  for(const row of baseline.results){
    const old=row.result;
    const r=await executeP2({run_id:input.run_id,unit_id:'p2.closed_period_store_performance',evidence:input.evidence,parameters:old.parameters});
    assert.equal(r.status,'EXECUTED');
    const {evidence,...result}=r.result;
    assert.deepEqual(result,old);
    assert.deepEqual(evidence.observations,row.p1_observations);
    counts[result.state]++;
  }
  assert.deepEqual(counts,{IMPROVING:1,STABLE:9,DETERIORATING:0,UNKNOWN:4});
});
