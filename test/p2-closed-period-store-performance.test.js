import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { executeP2 } from '../lib/p2/execute.js';
import { describeP2Unit } from '../lib/p2/registry.js';
import { shiftMonth } from '../lib/p2/closed-performance/legacy/expectation/monthSeries.js';
import { calculateDeviations } from '../lib/p2/closed-performance/legacy/deterioration/orgDeviations.js';
import { buildCurrentDeteriorationStatus } from '../lib/p2/closed-performance/legacy/deterioration/buildCurrentDeteriorationStatus.js';

const unit_id = 'p2.closed_period_store_performance';
export function fixture(values = {}) {
  const evidence = {};
  for (let p = '2021-01'; p <= '2026-09'; p = shiftMonth(p, 1)) {
    const [y,m] = p.split('-').map(Number), end = new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);
    const value = Object.hasOwn(values,p) ? values[p] : 120;
    evidence['history_' + p.replace('-','_')] = {
      authority:'P1_CERTIFIED',status:'CERTIFIED',source:'SALES',evidence_id:'synthetic:'+p,
      evidence_contract:'p1.dimensional_quantitative_dataset',evidence_version:'0.1.0',
      grain:'FILTERED_SALES_UNIVERSE',measure:{id:'VIN_SALES'},universe:{commercial_universe:'OWN_STORES'},
      dimensions:{},temporal:{period_identity:p,period_type:'COMMERCIAL_MONTH',cutoff:end,date_from:p+'-01',date_to:end},
      coverage:{dimension_unresolved_n:0,filtered_n:value??0},
      payload:{dimension:{id:'STORE',identity_contract:'sucursales_master',identity_version:'0.1'},
        members:value==null?[]:[{member_id:'3',member_label:'Synthetic store',value}]},lineage:{fixture:true},
    };
  }
  return evidence;
}
const run = (evidence=fixture(),parameters={cutoff_month:'2026-09',store_id:'3'}) => executeP2({run_id:'synthetic-test',unit_id,evidence,parameters});

test('contract is registered, fixed and restricted to closed SALES stores',()=>{
  const c=describeP2Unit(unit_id);
  assert.equal(c.contract_version,'0.1.0');
  assert.deepEqual(Object.keys(c.deterministic_contract.parameters),['cutoff_month','store_id']);
});
test('historical statistical sources match pinned legacy Git blob hashes',()=>{
  const manifest=JSON.parse(readFileSync(new URL('./fixtures/closed-performance-legacy-hashes.json',import.meta.url)));
  for(const [path,sha] of Object.entries(manifest.files)){
    const b=readFileSync(new URL('../lib/p2/closed-performance/legacy/'+path,import.meta.url));
    assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from('blob '+b.length+'\0'),b])).digest('hex'),sha,path);
  }
});
test('empirical percentiles retain half ties and three-error requirement',()=>{
  assert.equal(calculateDeviations(12,10,[2,2,2]).historical_percentile,.5);
  assert.equal(calculateDeviations(12,10,[0,0]).historical_percentile,null);
  assert.equal(calculateDeviations(12,10,[0,1,2]).historical_percentile,5/6);
});
test('two favorable growing errors confirm IMPROVING',async()=>{
  const r=await run(fixture({'2026-08':144,'2026-09':180}));
  assert.equal(r.status,'EXECUTED');assert.equal(r.result.state,'IMPROVING');
  assert.equal(r.result.original_deterioration.status,'NOT_DETERIORATING');
  assert.deepEqual(r.result.improvement_episode.evidence_months,['2026-08','2026-09']);
});
test('two adverse deepening errors preserve DETERIORATING',async()=>{
  const r=await run(fixture({'2026-08':96,'2026-09':60}));
  assert.equal(r.result.state,'DETERIORATING');
  assert.deepEqual(r.result.original_deterioration.persistence_rows.map(x=>x.month),['2026-08','2026-09']);
});
test('confirmed deterioration persists while adverse, even without further deepening',async()=>{
  const r=await run(fixture({'2026-07':96,'2026-08':60,'2026-09':90}));
  assert.equal(r.result.state,'DETERIORATING');
  assert.equal(r.result.original_deterioration.confirmation_month,'2026-08');
});
test('confirmed improvement persists while favorable, even without further growth',async()=>{
  const r=await run(fixture({'2026-07':144,'2026-08':180,'2026-09':150}));
  assert.equal(r.result.state,'IMPROVING');assert.equal(r.result.improvement_episode.confirmation_month,'2026-08');
});
test('percentile .5 is neutral and STABLE with sufficient evidence',async()=>{
  const r=await run();assert.equal(r.result.state,'STABLE');assert.equal(r.result.current.historical_percentile,.5);
});
test('one favorable or adverse month is unconfirmed and STABLE',async()=>{
  assert.equal((await run(fixture({'2026-09':180}))).result.state,'STABLE');
  assert.equal((await run(fixture({'2026-09':60}))).result.state,'STABLE');
});
test('equal errors never confirm a new episode in either direction',async()=>{
  assert.equal((await run(fixture({'2026-08':144,'2026-09':146}))).result.state,'STABLE');
  assert.equal((await run(fixture({'2026-08':96,'2026-09':94}))).result.state,'STABLE');
});
test('episodes terminate on neutral/nonfavorable and can reverse only after confirmation',async()=>{
  assert.equal((await run(fixture({'2026-06':144,'2026-07':180,'2026-08':60,'2026-09':36}))).result.state,'DETERIORATING');
  assert.equal((await run(fixture({'2026-06':96,'2026-07':60,'2026-08':180,'2026-09':204}))).result.state,'IMPROVING');
});
test('missing or zero current sales is UNKNOWN, never an invented active zero',async()=>{
  for(const v of [null,0]){
    const r=await run(fixture({'2026-09':v}));
    assert.equal(r.result.state,'UNKNOWN');assert.equal(r.result.reason,'UNKNOWN_ACTUAL');
    assert.equal(r.result.original_deterioration.observation_state,'UNKNOWN');
  }
});
test('missing baseline history breaks continuity and yields UNKNOWN',async()=>{
  const r=await run(fixture({'2026-07':180,'2026-08':null,'2026-09':240}));
  assert.equal(r.result.state,'UNKNOWN');assert.equal(r.result.reason,'BASELINE_UNAVAILABLE');
  assert.equal(r.result.improvement_episode,null);
});
test('one evaluable percentile is insufficient to declare STABLE',async()=>{
  const values={};for(let p='2021-01';p<'2025-06';p=shiftMonth(p,1))values[p]=null;
  const r=await run(fixture(values));
  assert.equal(r.result.original_deterioration.status,'NOT_DETERIORATING');
  assert.equal(r.result.state,'UNKNOWN');assert.equal(r.result.reason,'TWO_CONSECUTIVE_EVALUABLE_MONTHS_REQUIRED');
});
test('missing P1 calendar dataset returns UNKNOWN with explicit coverage',async()=>{
  const e=fixture();delete e.history_2021_01;
  const r=await run(e);assert.equal(r.result.state,'UNKNOWN');assert.equal(r.result.original_deterioration,null);
  assert.deepEqual(r.result.coverage.missing_p1_periods,['2021-01']);
});
test('no history returns UNKNOWN instead of estimating',async()=>{
  const r=await run({});assert.equal(r.status,'EXECUTED');assert.equal(r.result.state,'UNKNOWN');
});
test('P2 lineage preserves original P1 refs, cutoff, parameters and evidence without mutations',async()=>{
  const e=fixture(),before=structuredClone(e),r=await run(e);
  assert.deepEqual(e,before);assert.equal(r.lineage.evidence_refs.length,69);
  assert.equal(r.result.evidence.refs.length,69);assert.equal(r.result.cutoff,'2026-09-30');
  assert.equal(r.lineage.contract_version,'0.1.0');assert.equal(r.lineage.run_id,'synthetic-test');
});
test('rejects uncertified, incompatible or incomplete-month evidence and rule knobs',async()=>{
  const mutations=[
    e=>e.history_2026_09.authority='OBSERVED_NOT_CERTIFIED',
    e=>e.history_2026_09.status='OBSERVED_NOT_CERTIFIED',
    e=>e.history_2026_09.source='FORUM',
    e=>e.history_2026_09.universe.commercial_universe='DEALERS',
    e=>e.history_2026_09.measure.id='OTHER',
    e=>e.history_2026_09.dimensions.brand_id='1',
    e=>e.history_2026_09.payload.dimension.id='SELLER',
    e=>e.history_2026_09.payload.dimension.identity_version='other',
    e=>e.history_2026_09.temporal.cutoff='2026-09-29',
    e=>e.history_2026_09.coverage.dimension_unresolved_n=1,
    e=>e.history_2026_09.payload.members.push(e.history_2026_09.payload.members[0]),
    e=>e.history_2026_09.payload.members[0].value=-1,
    e=>e.history_2026_09.payload.members[0].value='120',
    e=>e.history_2026_09.coverage.filtered_n=121,
    e=>e.wrong_slot=e.history_2026_09,
  ];
  for(const mutate of mutations){const e=fixture();mutate(e);assert.equal((await run(e)).status,'INVALID_EXECUTION');}
  for(const parameters of [
    {cutoff_month:'2026-99',store_id:'3'},
    {cutoff_month:'2099-01',store_id:'3'},
    {cutoff_month:'2026-09',store_id:['3']},
    {cutoff_month:'2026-09',store_id:'3',threshold:.6},
  ])assert.equal((await run(fixture(),parameters)).status,'INVALID_EXECUTION');
});
test('same-input parity with the unchanged original core across deterministic histories',async()=>{
  let seed=834;
  for(let trial=0;trial<50;trial++){
    const vals={};
    for(let p='2021-01';p<='2026-09';p=shiftMonth(p,1)){
      seed=(seed*1664525+1013904223)>>>0;vals[p]=seed%31===0?null:1+seed%300;
    }
    const r=(await run(fixture(vals))).result;
    // Rebuild inputs independently from P1 observations and compare complete
    // original status (including UNKNOWN, onset and confirmation evidence).
    const rows=[],months=new Map(),errors=[];
    for(const o of r.evidence.observations)if(o.value>0)months.set(o.period_identity,o.value);
    for(const [month,sales] of months){
      const prior=Array.from({length:12},(_,i)=>months.get(shiftMonth(month,-i-1)));
      if(prior.some(x=>x==null))continue;
      const baseline=prior.reduce((a,b)=>a+b,0)/12,deviations=calculateDeviations(sales,baseline,errors);
      rows.push({unit_id:'3',month,sales,baseline:'moving_average_12',baseline_value:baseline,deviations});errors.push(deviations.error);
    }
    const oracle=buildCurrentDeteriorationStatus(rows,new Map([['3',{unit_id:'3',unit_label:r.store_label??'3',months}]]),'2026-09').statuses[0];
    assert.deepEqual(r.original_deterioration,oracle);
    assert.equal(r.state==='DETERIORATING',oracle.status==='DETERIORATING');
    if(oracle.status==='UNKNOWN')assert.equal(r.state,'UNKNOWN');
  }
});
