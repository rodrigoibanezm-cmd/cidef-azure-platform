import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { generateBundles } from '../lib/forum-snapshot/generate.js';
import { assertSnapshotParity, bundleKey, digest, indexCache, inspectPlan, planBundle } from '../lib/forum-snapshot/incremental.js';
import { FIELDS } from '../lib/data-floor/sales/contract.js';

function fixture(){
  const periods=['2026-01','2026-02','2026-03'];
  const maps={brands:{89:'FOTON'},groups:{5:'DEALER'},models:{1:'MODEL'},sellers:{1:'SELLER'}};
  const facts=Object.fromEntries(['OWN_STORES','DEALERS'].map(network=>[network,periods.map((p,i)=>Object.fromEntries(FIELDS.map(k=>[k,({vin:network+i,sale_date:p+'-10',invoice:String(i),operation:String(i),brand_id:'89',model_id:'1',version_id:null,store_id:network==='OWN_STORES'?'1':null,store_label:network==='OWN_STORES'?'STORE':null,dealer_id:network==='DEALERS'?'5':null,dealer_group_id:network==='DEALERS'?'5':null,seller_id:'1',color:'WHITE',financial_entity:'FORUM'})[k]])))]));
  const context={engine:'engine1',year:'2026',periods,cutoffs:{sales:'2026-03-31',forum:'2026-03-31'},maps,customers:new Map(),guard:'guard',sales_signatures:{},forum_signatures:{},sales_facts:{}};
  const refresh=()=>{for(const n of Object.keys(facts))for(const p of periods){const rows=facts[n].filter(r=>r.sale_date.slice(0,7)<=p);context.sales_facts[n+':'+p]=rows;context.sales_signatures[n+':'+p]=digest(rows);}for(const p of periods)context.forum_signatures[p]='forum:'+p+':'+(quotations[p]||0);};
  const quotations={};refresh();
  const calls=[];
  const envelope=rows=>({source:'SALES',dataset:'SALES_WORK',grain:'RECOGNIZED_SALE',size:{filtered_n:rows.length},rows});
  const callCertified=async(name,a)=>{
    calls.push({name,args:a});
    if(name==='data_fetch'&&a.source==='SALES'){
      const n=a.filters.commercial_universe;
      if(a.filters.date_to==='2026-10-20')return envelope(Array.from({length:n==='OWN_STORES'?175:101},(_,i)=>({...facts[n][0],vin:n+'acceptance'+i})));
      return envelope(structuredClone(facts[n].filter(f=>f.sale_date<=a.filters.date_to)));
    }
    if(name==='sales_observe_many'){
      const rows=facts[a.commercial_universe].filter(f=>f.sale_date.startsWith(a.period));
      return {results:[{operation:{kind:'TOTAL'},evidence:{authority:'P1_CERTIFIED',payload:{value:rows.length}}},
        {operation:{kind:'BRAND_NETWORK'},evidence:{payload:{members:rows.length?[{members:[{dimension:'BRAND',member_id:'89'}],value:rows.length}]:[]}}},
        {operation:{kind:'STORE_FINANCIAL_ENTITY'},evidence:{payload:{members:rows.map(r=>({member_id:r.store_id||r.dealer_id,financial_entity:r.financial_entity,value:1}))}}}]};
    }
    if(name==='data_fetch')return {source:'FORUM',dataset:'FORUM_FUNNEL_WORK',grain:'FORUM_OPERATION',size:{filtered_n:0},rows:[]};
    const count=a.measure==='QUOTATIONS'?(quotations[a.period_from]||0):0;
    const label=a.dimension==='BRAND'?'FOTON':a.dimension==='STORE'?'STORE':'DEALER';
    return {authority:'P1_CERTIFIED',coverage:{complete:true},payload:{members:count?[{member_id:label,member_label:label,value:count}]:[]},evidence_id:String(calls.length)};
  };
  const run=(extra={})=>generateBundles(context,{log:()=>{},run_id:'fixture',dealerIdentities:new Map(),callCertified,...extra});
  return {context,facts,refresh,quotations,calls,run};
}

test('unchanged periods: exact parity, zero MCP calls and cached payloads preserved',async()=>{
  const f=fixture(),full=await f.run({forceFull:true}),cache=indexCache(full.rows),prior=JSON.stringify(full.rows);
  f.calls.length=0;
  const warm=await f.run({cache});
  assert.equal(f.calls.length,0);assert.equal(warm.stats.reused,6);
  assertSnapshotParity(warm.rows,full.rows);assert.equal(JSON.stringify(full.rows),prior);
});
test('current SALES change reuses all FORUM evidence and matches a full reconstruction',async()=>{
  const f=fixture(),old=await f.run({forceFull:true});
  f.facts.OWN_STORES[2].financial_entity='OTHER';f.refresh();f.calls.length=0;
  const inc=await f.run({cache:indexCache(old.rows)});
  assert.equal(inc.stats.rebuilt,1);assert.equal(inc.stats.reused,5);
  assert.equal(f.calls.filter(c=>c.name==='data_observe').length,0);
  assert.equal(f.calls.length,4); // fetch + observe + two original acceptance checks
  assertSnapshotParity(inc.rows,(await f.run({forceFull:true})).rows);
});
test('historical SALES correction invalidates its cumulative descendants, both old and new months on date moves',async()=>{
  const f=fixture(),old=await f.run({forceFull:true});
  f.facts.OWN_STORES[1].sale_date='2026-03-10';f.refresh();
  const cache=indexCache(old.rows),plan=inspectPlan(f.context,cache);
  assert.equal(plan.find(x=>x.network==='OWN_STORES'&&x.period==='2026-01').reuse,true);
  assert.equal(plan.find(x=>x.network==='OWN_STORES'&&x.period==='2026-02').sales,true);
  assert.equal(plan.find(x=>x.network==='OWN_STORES'&&x.period==='2026-03').sales,true);
  assertSnapshotParity((await f.run({cache})).rows,(await f.run({forceFull:true})).rows);
});
test('historical FORUM correction refreshes its month and propagates history without repeating later P1 calls',async()=>{
  const f=fixture(),old=await f.run({forceFull:true});
  f.quotations['2026-02']=2;f.refresh();f.calls.length=0;
  const inc=await f.run({cache:indexCache(old.rows)});
  assert.equal(inc.stats.rebuilt,4);
  assert.equal(f.calls.filter(c=>c.name==='sales_observe_many').length,0);
  assert.equal(f.calls.filter(c=>c.name==='data_observe').length,16);
  assert.equal(f.calls.filter(c=>c.name==='data_observe'&&c.args.period_from==='2026-03').length,0);
  assertSnapshotParity(inc.rows,(await f.run({forceFull:true})).rows);
});
test('contract/identity invalidation and legacy snapshots fall back safely to full regeneration',async()=>{
  const f=fixture(),old=await f.run({forceFull:true}),cache=indexCache(old.rows);
  f.context.engine='changed-contract';assert.ok(inspectPlan(f.context,cache).every(p=>p.sales&&p.forum));
  f.context.engine='engine1';
  const corrupted=structuredClone(old.rows[0]);corrupted.payload.reports['2026-01'].totals.total=99;
  assert.equal(planBundle(f.context,corrupted.network,corrupted.period,corrupted).reuse,false);
  const legacy=structuredClone(old.rows[0]);delete legacy.payload.refresh;
  assert.equal(planBundle(f.context,legacy.network,legacy.period,legacy).reuse,false);
  assert.ok(inspectPlan(f.context,cache,true).every(p=>p.sales&&p.forum));
});
test('parity rejects changed numbers and dimension members while allowing new evidence ids',async()=>{
  const f=fixture(),full=await f.run({forceFull:true}),changed=structuredClone(full.rows);
  changed[0].payload.forum_p1.QUOTATIONS.dimensions.BRAND.evidence_id='new-id';
  assertSnapshotParity(changed,full.rows);
  changed[0].payload.facts[0].brand_id='71';assert.throws(()=>assertSnapshotParity(changed,full.rows),/PARITY/);
});
test('failed generation never mutates existing payloads',async()=>{
  const f=fixture(),old=await f.run({forceFull:true}),cache=indexCache(old.rows),before=JSON.stringify(old.rows);
  f.facts.OWN_STORES[1].financial_entity='OTHER';f.refresh();
  await assert.rejects(f.run({cache,callCertified:async()=>{throw Error('transport failure');}}),/transport failure/);
  assert.equal(JSON.stringify(old.rows),before);
});
test('benchmark fixture reports actual calls and duration; production timing is measured separately',async()=>{
  const f=fixture();let t=performance.now();const full=await f.run({forceFull:true});const fullMs=performance.now()-t,fullCalls=f.calls.length;
  f.calls.length=0;t=performance.now();await f.run({cache:indexCache(full.rows)});
  console.log(JSON.stringify({fixture:true,full_ms:fullMs,incremental_ms:performance.now()-t,full_calls:fullCalls,incremental_calls:f.calls.length}));
});
