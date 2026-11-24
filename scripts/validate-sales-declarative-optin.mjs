// Read-only exhaustive current-data parity for every recognized monthly SALES fact.
// One complete P1 scope + one conservative candidate preparation per month/network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getSalesRunFactSet } from '../lib/data-floor/sales/preparation.js';
import { field, match } from '../lib/data-floor/sales/dataset.js';
import { FIELDS } from '../lib/data-floor/sales/contract.js';
import { observeSalesSelection } from '../lib/data-floor/sales/operations.js';
import { resolveSalesObservation } from '../lib/data-floor/salesCertifier.js';
import { planSalesCandidates, semanticSalesCandidates } from './semantic-sales-prototype.mjs';

process.env.SALES_SQL_FIRST_ENABLED='false';
const now=new Date();
const months=[-1,-3].map(offset=>
  new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+offset,1))
    .toISOString().slice(0,7));
const lastDay=month=>new Date(Date.UTC(Number(month.slice(0,4)),
  Number(month.slice(5,7)),0)).toISOString().slice(0,10);
const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const project=row=>Object.fromEntries(['source_id',...FIELDS].map(key=>
  [key,key==='source_id'?row.source_id:field(row,key)]));
const normalize=rows=>rows.map(project).sort((a,b)=>
  JSON.stringify(a).localeCompare(JSON.stringify(b)));
const report=[];
const run='sql-first-exhaustive-'+randomUUID();
for(const period of months)for(const universe of ['OWN_STORES','DEALERS']){
  const cutoff=lastDay(period);
  const baseFilters={commercial_universe:universe,date_from:period+'-01',date_to:cutoff};
  const {factSet:full}=await getSalesRunFactSet(run,{
    commercial_universe:universe,cutoff_date:cutoff,
  });
  const reference=full.select(baseFilters).facts;
  const sample=reference.find(row=>positive(field(row,'brand_id'))&&
    positive(field(row,'model_id')));
  assert.ok(sample,'No certifiable brand/model available for '+universe+' '+period);
  const candidateFilters={...baseFilters,brand_id:positive(field(sample,'brand_id')),
    model_id:positive(field(sample,'model_id'))};
  const plan=planSalesCandidates(candidateFilters,cutoff);
  assert.ok(plan);
  const candidate=await semanticSalesCandidates(plan);
  const candidates=new Set(candidate.vins);
  const missingCandidateVins=[...new Set(reference.map(row=>field(row,'vin'))
    .filter(vin=>vin!=null&&!candidates.has(vin)))];
  const {factSet:partial}=await getSalesRunFactSet(run,{
    commercial_universe:universe,cutoff_date:cutoff,
    candidate_filters:candidateFilters,diagnostic_sql_first:true,
  });
  const candidateFacts=partial.base.filter(row=>Object.entries(baseFilters)
    .every(([key,value])=>match(row,key,value)));
  const expected=normalize(reference),actual=normalize(candidateFacts);
  const ok=JSON.stringify(expected)===JSON.stringify(actual) &&
    missingCandidateVins.length===0 &&
    partial.ref.source_scope==='PARTIAL_SOURCE';
  const test={period,universe,expected_rows:expected.length,actual_rows:actual.length,
    expected_null_vin_rows:expected.filter(row=>row.vin==null).length,
    missing_candidate_vins:missingCandidateVins.length,records_equal:ok};
  report.push(test);
  if(!ok){
    console.error(JSON.stringify({status:'FAIL',...test,
      missing_vins:missingCandidateVins.slice(0,10),
      missing_rows:expected.filter(row=>!actual.some(x=>JSON.stringify(x)===JSON.stringify(row))).slice(0,5),
      extra_rows:actual.filter(row=>!expected.some(x=>JSON.stringify(x)===JSON.stringify(row))).slice(0,5)}));
    throw new Error('SQL_FIRST_INCOMPLETE_MONTHLY_SCOPE');
  }
  if(report.length===1){
    // Both tiers must remain isolated even in the same run.
    process.env.SALES_SQL_FIRST_ENABLED='true';
    process.env.SALES_SQL_FIRST_SCOPE_CERTIFIED='true';
    try{
      const {factSet:certified}=await getSalesRunFactSet(run,{
        commercial_universe:universe,cutoff_date:cutoff,candidate_filters:candidateFilters,
      });
      assert.equal(certified.ref.source_scope,'SCOPED_CERTIFIED');
      assert.notEqual(certified.ref.preparation_id,partial.ref.preparation_id);
      const evidence=observeSalesSelection(certified.select(candidateFilters));
      assert.equal(evidence.authority,'P1_CERTIFIED');
      assert.equal(evidence.coverage.source_scope,'SCOPED_CERTIFIED');
      const matched=normalize(full.select(candidateFilters).facts);
      assert.deepEqual(normalize(certified.select(candidateFilters).facts),matched);
      const wrapped=await resolveSalesObservation({
        measure:'VIN_SALES',time:{period,cutoff},
        filters:{commercial_universe:universe,
          brand_id:candidateFilters.brand_id,model_id:candidateFilters.model_id},
      },run+'-wrapped');
      assert.equal(wrapped.authority,'P1_CERTIFIED');
      assert.equal(wrapped.status,'CERTIFIED');
      assert.equal(wrapped.evidence_contract,'p1.cumulative_period_observation');
      assert.equal(wrapped.coverage.source_scope,'SCOPED_CERTIFIED');
      assert.equal(wrapped.payload.observed_value,
        full.select({...baseFilters,brand_id:candidateFilters.brand_id,
          model_id:candidateFilters.model_id}).facts.length);
    }finally{
      process.env.SALES_SQL_FIRST_SCOPE_CERTIFIED='false';
      process.env.SALES_SQL_FIRST_ENABLED='false';
    }
  }
  console.log(JSON.stringify({status:'SCOPE_PASS',...test}));
}
assert.equal(report.length,months.length*2);
console.log(JSON.stringify({status:'PASS',checked_scopes:report.length,
  compared_facts:report.reduce((n,row)=>n+row.expected_rows,0),scopes:report,
  note:'All recognized facts in selected months and networks; not all historical months or future data.'}));
