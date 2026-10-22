import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSales, assertFacts, assertParity, selectionsForEnd } from '../lib/forum-snapshot/projection.js';
import { replaceSnapshot } from '../lib/forum-snapshot/publication.js';
import { loadDealerIdentities, projectDealerUfis, assertDealerUfiParity } from '../lib/forum-snapshot/projection.js';
import { DEALER_IDENTITY_JOINS } from '../lib/data-floor/forum/query.js';
import { spawnSync } from 'node:child_process';
const catalogs={brands:{89:'FOTON',71:'DONGFENG'},groups:{5:'AUTOS OGAZ'}};
test('unresolved identities remain visible; missing financial entity is not cash',()=>{
  const p=projectSales([{vin:'A',store_id:null,brand_id:89,financial_entity:null},{vin:'B',store_id:78,store_label:'CIDEF Las Condes',brand_id:71,financial_entity:' FORUM '}],'OWN_STORES',catalogs);
  assert.equal(p.totals.total,2);assert.equal(p.totals.total_ufis,1);assert.deepEqual(p.unresolved_vins,['A']);
  assert.equal(p.rows.find(r=>r.sucursal_id==='UNRESOLVED').total,1);
  assert.equal(p.financing.unresolved,1);assert.equal(p.financing.without_financing,null);assert.equal(p.totals.penetration,null);
});
const forumWork=rows=>({source:'FORUM',dataset:'FORUM_FUNNEL_WORK',grain:'FORUM_OPERATION',size:{filtered_n:rows.length},rows});
const curse=(operation_number,extra={})=>({operation_number,network:'DEALERS',distributor:'ALIAS A',brand_id:'89',brand:'FOTON',curse_date:'2026-10-12',ufi_curse:1,has_curse_evidence:true,...extra});
const identities=new Map([['ALIAS A',{dealer_group_id:'5',dealer_label:'GRUPO CANÓNICO'}],['ALIAS B',{dealer_group_id:'5',dealer_label:'GRUPO CANÓNICO'}],['SIN ALIAS',{dealer_group_id:null,dealer_label:'SIN ALIAS'}]]);
test('UFI pivot respects event month, vehicle units, canonical aliases and unresolved identities',()=>{
  const work=forumWork([curse(1,{ufi_curse:2}),curse(2,{distributor:'ALIAS B',brand:'DONGFENG',brand_id:'71'}),curse(3,{curse_date:'2026-09-30'}),curse(4,{curse_date:'2026-10-21'}),curse(5,{distributor:'SIN ALIAS',brand_id:null,brand:null})]);
  const p=projectDealerUfis(work,'2026-10','2026-10-20',identities);
  assert.equal(p.total,4);assert.equal(p.members.find(m=>m.brand_id==='89').ufis,2);
  assert.equal(p.members.filter(m=>m.dealer_group_id==='5').length,2);
  assert.equal(p.members.find(m=>m.brand_id==='UNRESOLVED').dealer_key,'UNRESOLVED:SIN ALIAS');
});
test('FORUM pivot rejects missing evidence, duplicate operations, invalid units and identity drift',()=>{
  for(const rows of [[curse(1),curse(1)],[curse(1,{has_curse_evidence:false})],[curse(1,{ufi_curse:null})],[curse(1,{ufi_curse:-1})],[curse(1,{ufi_curse:1.5})],[curse(1,{network:'OWN_STORES'})],[curse(1,{curse_date:null})],[curse(1,{distributor:'UNKNOWN'})]])assert.throws(()=>projectDealerUfis(forumWork(rows),'2026-10','2026-10-20',identities));
});
test('dealer × brand pivot independently reconciles both P1 dimensional margins',()=>{
  const p=projectDealerUfis(forumWork([curse(1,{ufi_curse:2}),curse(2,{brand:'DONGFENG',brand_id:'71'})]),'2026-10','2026-10-20',identities);
  const evidence=members=>({authority:'P1_CERTIFIED',coverage:{complete:true},payload:{members}});
  const observation={value:3,dimensions:{BRAND:evidence([{member_label:'FOTON',value:2},{member_label:'DONGFENG',value:1}]),DISTRIBUTOR:evidence([{member_label:'GRUPO CANÓNICO',value:3}])}};
  assert.doesNotThrow(()=>assertDealerUfiParity(p,observation));
  assert.throws(()=>assertDealerUfiParity({...p,total:4},observation),/TOTAL_PARITY/);
  assert.throws(()=>assertDealerUfiParity({...p,members:p.members.map(m=>({...m,dealer_label:'WRONG'}))},observation),/DISTRIBUTOR_PARITY/);
});
test('identity loading reuses the existing P1 joins and preserves canonical group ids',async()=>{
  const client={query:async sql=>{assert.ok(sql.includes(DEALER_IDENTITY_JOINS));return {rows:[{raw:'ALIAS A',dealer_group_id:'5',dealer_label:'GRUPO CANÓNICO'}]};}};
  assert.equal((await loadDealerIdentities(client)).get('ALIAS A').dealer_group_id,'5');
});
test('replacement publisher cannot write without explicit activation after caller handoff',()=>{
  const result=spawnSync(process.execPath,['scripts/refresh-forum-ventas-snapshot-azure.js','--publish'],{cwd:new URL('..',import.meta.url),env:{...process.env,FORUM_SNAPSHOT_PUBLISHER:''},encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/PUBLISHER_HANDOFF_NOT_CONFIRMED/);
});
test('dealer grouping uses certified ids and canonical group labels',()=>{
  const p=projectSales([{vin:'A',dealer_id:39,dealer_group_id:5,brand_id:89,financial_entity:'TANNER'}],'DEALERS',catalogs);
  assert.equal(p.rows[0].sucursal,'AUTOS OGAZ');assert.equal(p.totals.total_ufis,0);assert.equal(p.unresolved_vins.length,0);
});
test('P1 guards reject duplicate VIN and changed totals',()=>{
  assert.throws(()=>assertFacts({source:'SALES',dataset:'SALES_WORK',grain:'RECOGNIZED_SALE',rows:[{vin:'A'},{vin:'A'}],size:{filtered_n:2}}),/DUPLICATE/);
  assert.throws(()=>assertParity([{}],{authority:'P1_CERTIFIED',payload:{value:2}}),/PARITY/);
});
test('noncontiguous month filters are preserved without changing recognition',()=>{
  const selections=selectionsForEnd('2026',3);
  assert.equal(selections.length,4);assert.ok(selections.some(x=>x.join(',')==='2026-01,2026-03'));
});
test('failed second insert rolls back all candidate rows and leaves previous generation',async()=>{
  const published=new Map([['old',{value:175}]]);let tx,rolled=false;
  const client={async query(sql,params){if(sql==='BEGIN')tx=new Map(published);else if(sql==='ROLLBACK'){tx=null;rolled=true;}else if(sql==='COMMIT'){published.clear();for(const [k,v] of tx)published.set(k,v);}else {if(params[0]==='fail')throw Error('injected');tx.set(params[0],params[3]);}return {rows:[]};}};
  const row={period:'ok',network:'OWN_STORES',dimension:'BUNDLE',payload:{value:101},sales_cutoff:'2026-10-20',forum_cutoff:'2026-10-20'};
  await assert.rejects(replaceSnapshot(client,[row,{...row,period:'fail'}],'new'),/injected/);
  assert.equal(rolled,true);assert.deepEqual([...published],[['old',{value:175}]]);
});
