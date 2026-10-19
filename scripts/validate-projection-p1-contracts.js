import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint=process.env.MCP_URL;
if(!endpoint)throw new Error('MCP_URL is required');
const client=new Client({name:'projection-p1-contract-validation',version:'1.0.0'});
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

async function call(name,args){
  const result=await client.callTool({name,arguments:args});
  assert.notEqual(result.isError,true,name+' MCP error: '+(result.content||[]).map(x=>x.text||'').join('\n'));
  assert.ok(result.structuredContent,name+' returned no structured content');
  return result.structuredContent;
}
function sum(members){return members.reduce((total,row)=>total+Number(row.value||0),0);}
function memberId(row,dimension){return row.members?.find(item=>item.dimension===dimension)?.member_id??null;}

try{
  const run_id='projection-contract-'+randomUUID();
  const salesContract=await call('data_describe',{run_id:run_id+'-sales',source:'SALES'});
  assert.ok(salesContract.fields.includes('financial_entity'),'SALES field financial_entity is not exposed');
  assert.ok(salesContract.dimensions.includes('FINANCIAL_ENTITY'),'SALES dimension FINANCIAL_ENTITY is not exposed');

  const cutoff=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago'}).format(new Date());
  const period=cutoff.slice(0,7);
  const filters={commercial_universe:'OWN_STORES',date_from:period+'-01',date_to:cutoff};
  const finance=await call('data_observe',{
    run_id:run_id+'-sales-finance',source:'SALES',measure:'VIN_SALES',
    evidence_shape:'DIMENSIONAL_QUANTITATIVE_DATASET',dimension:'FINANCIAL_ENTITY',filters
  });
  assert.equal(finance.authority,'P1_CERTIFIED');
  assert.equal(finance.payload.dimension.id,'FINANCIAL_ENTITY');
  assert.equal(typeof finance.dimensions,'object');
  assert.equal(sum(finance.payload.members),finance.coverage.filtered_n,'SALES finance split does not reconcile to recognized rows');

  const salesMany=await call('sales_observe_many',{
    run_id:run_id+'-sales-stores',period,cutoff,commercial_universe:'OWN_STORES',
    operations:[{kind:'TOTAL'},{kind:'STORE'},{kind:'STORE_FINANCIAL_ENTITY'}]
  });
  const byKind=new Map(salesMany.results.map(item=>[item.operation.kind,item.evidence]));
  const total=byKind.get('TOTAL'),stores=byKind.get('STORE'),storeFinance=byKind.get('STORE_FINANCIAL_ENTITY');
  assert.equal(total.authority,'P1_CERTIFIED');
  assert.equal(stores.authority,'P1_CERTIFIED');
  assert.equal(storeFinance.authority,'P1_CERTIFIED');
  assert.equal(sum(stores.payload.members),total.payload.value,'SALES store totals do not reconcile');
  assert.equal(sum(storeFinance.payload.members),total.payload.value,'SALES store-finance totals do not reconcile');
  const financeByStore=new Map();
  for(const row of storeFinance.payload.members){
    const id=memberId(row,'STORE');
    financeByStore.set(id,(financeByStore.get(id)||0)+Number(row.value||0));
  }
  for(const row of stores.payload.members)assert.equal(financeByStore.get(row.member_id)||0,row.value,'SALES finance split differs for store '+row.member_id);

  const forumContract=await call('data_describe',{run_id:run_id+'-forum',source:'FORUM'});
  assert.ok(forumContract.dimensions.includes('STORE'));
  assert.ok(forumContract.dimensions.includes('SELLER'));
  const forumFilters={network:'OWN_STORES'};
  const precurse=await call('data_observe',{
    run_id:run_id+'-forum-precurse',source:'FORUM',measure:'PRECURSE',
    evidence_shape:'QUANTITATIVE_OBSERVATION',filters:forumFilters
  });
  assert.equal(precurse.authority,'P1_CERTIFIED');
  assert.ok(Object.hasOwn(precurse,'dimensions'),'FORUM PRECURSE scalar response lacks dimensions');
  assert.equal(Object.keys(precurse.dimensions).length,0);
  const snapshot=precurse.temporal.snapshot_date;
  assert.match(snapshot,/^\d{4}-\d{2}-\d{2}$/);

  const dimensional={};
  for(const dimension of ['STORE','SELLER']){
    const evidence=await call('data_observe',{
      run_id:run_id+'-forum-precurse-'+dimension.toLowerCase(),source:'FORUM',measure:'PRECURSE',
      evidence_shape:'DIMENSIONAL_QUANTITATIVE_DATASET',dimension,cutoff:snapshot,filters:forumFilters
    });
    assert.equal(evidence.authority,'P1_CERTIFIED');
    assert.equal(evidence.temporal.snapshot_date,snapshot);
    assert.equal(evidence.dimensions.group_by,dimension);
    assert.equal(evidence.payload.dimension.id,dimension);
    assert.equal(sum(evidence.payload.members),precurse.payload.value,'FORUM PRECURSE '+dimension+' does not reconcile to total');
    dimensional[dimension]={value:sum(evidence.payload.members),members:evidence.payload.members.length};
  }

  console.log(JSON.stringify({
    status:'PASS',database:'AZURE_POSTGRESQL',period,cutoff,
    sales:{recognized:total.payload.value,financial_entity_members:finance.payload.members.length,store_finance_members:storeFinance.payload.members.length},
    forum_precurse:{snapshot_date:snapshot,own_stores:precurse.payload.value,dimensions:dimensional}
  }));
}finally{
  await client.close().catch(()=>{});
}
