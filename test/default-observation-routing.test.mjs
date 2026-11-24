import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const code=readFileSync(new URL('../lib/data-floor/registry.js',import.meta.url),'utf8');
const start=code.indexOf('export function planDefaultObservation(');
const end=code.indexOf('\nexport async function resolveDataObservation(',start);
assert.ok(start>=0&&end>start);
const plan=new Function(code.slice(start,end).replace('export function ','function ')+
  '\nreturn planDefaultObservation;')();

const contract=(source,measure,shape,object=false)=>({
  source,evidence_shapes:[shape],
  measures:object?{[measure]:{id:measure}}:[{id:measure}],
});

test('any advertised scalar measure routes with the original filters',()=>{
  for(const [source,measure,shape,object] of [
    ['SALES','VIN_SALES','CUMULATIVE_PERIOD_OBSERVATION',false],
    ['FORUM','QUOTATIONS','QUANTITATIVE_OBSERVATION',true],
    ['RVM','RVM_UNITS','QUANTITATIVE_OBSERVATION',true],
    ['SELL_OUT','VIN_SELL_OUT','QUANTITATIVE_OBSERVATION',false],
    ['TARGETS','VIN_TARGET','REFERENCE_OBSERVATION',false],
    ['PRICING','PRICE_EPISODES','COMMERCIAL_CONDITION_WINDOWS',false],
  ]){
    const input={measure,period:'2026-08',evidence_shape:shape,filters:{store_id:4}};
    assert.deepEqual(plan(contract(source,measure,shape,object),input),
      {measure,time:{period:'2026-08'},filters:input.filters},source);
  }
});

test('optional cumulative cutoff routes when the contract advertises the shape',()=>{
  const spec=contract('SALES','VIN_SALES','CUMULATIVE_PERIOD_OBSERVATION');
  const input={measure:'SALES.VIN_SALES',period:'2026-08',cutoff:'2026-08-31',
    evidence_shape:'CUMULATIVE_PERIOD_OBSERVATION'};
  assert.deepEqual(plan(spec,input),{
    measure:input.measure,time:{period:'2026-08',cutoff:'2026-08-31'},filters:{},
  });
});

test('unsupported or ambiguous requests keep the previous route',()=>{
  const spec=contract('FORUM','QUOTATIONS','QUANTITATIVE_OBSERVATION',true);
  for(const input of [
    {measure:'QUOTATIONS',period:'2026-08',dimension:'STORE'},
    {measure:'QUOTATIONS',period:'2026-08',period_to:'2026-09'},
    {measure:'QUOTATIONS',period:'2026-08',cutoff:'2026-08-31'},
    {measure:'QUOTATIONS',period:'2026-08',request:{measure:'QUOTATIONS'}},
    {measure:'QUOTATIONS',period:'2026-13'},
    {measure:'UNKNOWN',period:'2026-08'},
    {measure:'QUOTATIONS',period:'2026-08',evidence_shape:'REFERENCE_OBSERVATION'},
  ])assert.equal(plan(spec,input),null,JSON.stringify(input));
  assert.equal(plan(contract('INVENTORY','VIN_STOCK','QUANTITATIVE_OBSERVATION'),
    {measure:'VIN_STOCK'}),null);
  assert.match(code,/planDefaultObservation\(item\.describe\(\), input\)/);
  assert.match(code,/item\.resolveObservation\(request, runId\)/);
  assert.doesNotMatch(code,/SALES: scalar|FORUM: scalar|TARGETS: scalar/);
});
