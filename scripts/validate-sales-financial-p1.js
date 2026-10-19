import assert from 'node:assert/strict';
import { observeSalesMany } from '../lib/data-floor/sales/multiObserve.js';

if(!process.env.AZURE_DATABASE_URL)throw new Error('AZURE_DATABASE_URL is required');
function evidenceFor(result,kind){
  const item=result.results.find(entry=>entry.operation.kind===kind);
  assert.ok(item,'Missing '+kind+' evidence');
  assert.equal(item.evidence.authority,'P1_CERTIFIED');
  assert.equal(item.evidence.measure.id,'VIN_SALES');
  return item.evidence;
}
function oneDimMap(evidence){
  assert.equal(evidence.payload.dimension.id,'STORE');
  return new Map(evidence.payload.members.map(item=>[item.member_id,item.value]));
}
function tupleRows(evidence){
  assert.deepEqual(evidence.payload.dimensions.map(item=>item.id),['STORE','FINANCIAL_ENTITY']);
  return evidence.payload.members.map(item=>{
    const byDimension=Object.fromEntries(item.members.map(member=>[member.dimension,member]));
    return {store:byDimension.STORE.member_id,entity:byDimension.FINANCIAL_ENTITY.member_id,value:item.value};
  });
}
function totals(rows){
  const output=new Map();
  for(const row of rows)output.set(row.store,(output.get(row.store)??0)+row.value);
  return output;
}
const now=new Date();
  const currentPeriod=now.toISOString().slice(0,7);
  const currentCutoff=now.toISOString().slice(0,10);
  const previousEnd=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),0));
  const cases=[
    {period:previousEnd.toISOString().slice(0,7),cutoff:previousEnd.toISOString().slice(0,10)},
    {period:currentPeriod,cutoff:currentCutoff},
  ];
  const report=[];
  for(const item of cases){
    const result=await observeSalesMany({
      period:item.period,cutoff:item.cutoff,commercial_universe:'OWN_STORES',
      operations:[{kind:'TOTAL'},{kind:'STORE'},{kind:'STORE_FINANCIAL_ENTITY'}],
    });
    assert.equal(result.execution.preparations,1);
    assert.equal(result.execution.recognitions,1);
    assert.equal(result.execution.fact_sets,1);
    const totalEvidence=evidenceFor(result,'TOTAL');
    const storeEvidence=evidenceFor(result,'STORE');
    const financeEvidence=evidenceFor(result,'STORE_FINANCIAL_ENTITY');
    const total=totalEvidence.payload.value;
    const stores=oneDimMap(storeEvidence);
    const financeRows=tupleRows(financeEvidence);
    const byStore=totals(financeRows);
    const storeRows=[...stores.entries()].map(([store,value])=>({store,value}));
    const allStoreCount=[...stores.values()].reduce((sum,value)=>sum+value,0);
    assert.equal(allStoreCount,total,'Store totals do not reconcile to recognized SALES total');
    assert.equal(financeRows.reduce((sum,row)=>sum+row.value,0),total,'Finance split does not reconcile to recognized SALES total');
    for(const [store,value] of stores)assert.equal(byStore.get(store)??0,value,'Finance split does not reconcile for store '+store);
    const unresolved=financeRows.filter(row=>row.entity==='UNRESOLVED').reduce((sum,row)=>sum+row.value,0);
    const forum=financeRows.filter(row=>row.entity!=='UNRESOLVED'&&String(row.entity).trim().toUpperCase()==='FORUM').reduce((sum,row)=>sum+row.value,0);
    const other=financeRows.filter(row=>row.entity!=='UNRESOLVED'&&String(row.entity).trim().toUpperCase()!=='FORUM').reduce((sum,row)=>sum+row.value,0);
    assert.equal(forum+other+unresolved,total,'FORUM/other/unresolved classifications do not reconcile');
    report.push({period:item.period,cutoff:item.cutoff,recognized_sales:total,store_count:stores.size,store_totals:storeRows,
      ufi_ejecutadas_forum:forum,otros_creditos:other,financiera_no_resuelta:unresolved,
      reconciliation:'PASS'});
  }
  console.log(JSON.stringify({source:'Azure PostgreSQL via certified SALES P1 engine',cases:report},null,2));
