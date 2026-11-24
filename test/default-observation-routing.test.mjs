import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const code=readFileSync(new URL('../lib/data-floor/registry.js',import.meta.url),'utf8');
const start=code.indexOf('export function planDefaultObservation(');
const end=code.indexOf('\nexport async function resolveDataObservation(',start);
assert.ok(start>=0&&end>start);
const plan=new Function(code.slice(start,end).replace('export function ','function ')+
  '\nreturn planDefaultObservation;')();

test('eligible SALES cumulative observation takes declarative route',()=>{
  const input={measure:'VIN_SALES',period:'2026-08',cutoff:'2026-08-31',
    evidence_shape:'CUMULATIVE_PERIOD_OBSERVATION',filters:{commercial_universe:'OWN_STORES',store_id:4}};
  assert.deepEqual(plan('SALES',input),{measure:'VIN_SALES',
    time:{period:'2026-08',cutoff:'2026-08-31'},filters:input.filters});
  assert.equal(plan('SALES',{...input,cutoff:undefined}),null);
  assert.equal(plan('SALES',{...input,evidence_shape:'DIMENSIONAL_QUANTITATIVE_DATASET'}),null);
});
test('scalar FORUM and other certified domains use deterministic declarative path',()=>{
  const examples=[
    ['FORUM','QUOTATIONS','QUANTITATIVE_OBSERVATION'],
    ['RVM','RVM_UNITS','QUANTITATIVE_OBSERVATION'],
    ['SELL_OUT','VIN_SELL_OUT','QUANTITATIVE_OBSERVATION'],
    ['TARGETS','VIN_TARGET','REFERENCE_OBSERVATION'],
    ['PRICING','PRICE_EPISODES','COMMERCIAL_CONDITION_WINDOWS'],
  ];
  for(const [source,measure,evidence_shape] of examples){
    assert.deepEqual(plan(source,{measure,period:'2026-08',evidence_shape}),
      {measure,time:{period:'2026-08'},filters:{}},source);
  }
  assert.equal(plan('FORUM',{measure:'OPERATION_STATES',period:'2026-08'}),null);
  assert.equal(plan('INVENTORY',{measure:'VIN_STOCK',period:'2026-08'}),null);
});
test('specialized and explicit declarative paths remain untouched',()=>{
  assert.equal(plan('SALES',{measure:'VIN_SALES',period_from:'2026-07',period_to:'2026-08'}),null);
  assert.equal(plan('FORUM',{measure:'QUOTATIONS',period:'2026-08',dimension:'STORE'}),null);
  assert.equal(plan('SELL_OUT',{measure:'VIN_SELL_OUT',period:'2026-08',request:{measure:'VIN_SELL_OUT'}}),null);
  assert.equal(plan('PRICING',{measure:'PRICE_EPISODES',period:'2026-08',cutoff:'2026-08-31',
    evidence_shape:'COMMERCIAL_CONDITION_WINDOWS'}),null);
  assert.match(code,/const request = input\.request \?\? planDefaultObservation\(key, input\)/);
  assert.match(code,/item\.resolveObservation\(request, runId\)/);
});
