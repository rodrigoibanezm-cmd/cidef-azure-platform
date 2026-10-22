import assert from 'node:assert/strict';
import { FIELDS } from '../data-floor/sales/contract.js';
import { CONTRACT, NETWORKS, monthEnd, projectSales, assertFacts, assertParity, selectionsForEnd, projectDealerUfis, assertDealerUfiParity } from './projection.js';
import { bundleKey, planBundle, tagBundle } from './incremental.js';
const sortedFacts=rows=>rows.map(r=>Object.fromEntries(FIELDS.map(k=>[k,r[k]]))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export async function generateBundles(context,{cache=new Map(),forceFull=false,callCertified,run_id,dealerIdentities,log=console.log}) {
  const {year,cutoffs,maps,customers}=context;
  const before=context.guard,rows=[],validation=[],stats={reused:0,rebuilt:0};
  let dealerWork;
  const getDealerWork=async()=>dealerWork??=await callCertified('data_fetch',{run_id,source:'FORUM',filters:{network:['DEALERS'],stage:['CURSE']},fields:['operation_number','network','distributor','brand_id','brand','curse_date','ufi_curse','has_curse_evidence']});
  for(const network of NETWORKS){
    const history=[];
    for(const period of context.periods){
      const month=Number(period.slice(5,7));
      const cached=cache.get(bundleKey({network,period}));
      const plan=planBundle(context,network,period,cached,forceFull);
      if(plan.reuse){
        rows.push(structuredClone(cached));
        history.push(structuredClone(cached.payload.history.find(h=>h.period===period)));
        validation.push(structuredClone(cached.payload.refresh.validation));
        stats.reused++;
        continue;
      }
      stats.rebuilt++;
      const salesCutoff=[monthEnd(period),cutoffs.sales].sort()[0];
      const forumCutoff=[monthEnd(period),cutoffs.forum].sort()[0];
      if(salesCutoff<period+'-01'||forumCutoff<period+'-01')throw new Error('INDEPENDENT_SOURCE_PERIOD_UNAVAILABLE: '+period);
      const sales=plan.sales?await callCertified('data_fetch',{run_id,source:'SALES',filters:{commercial_universe:network,date_from:year+'-01-01',date_to:salesCutoff}}):{source:'SALES',dataset:'SALES_WORK',grain:'RECOGNIZED_SALE',rows:cached.payload.facts.map(f=>Object.fromEntries(FIELDS.map(k=>[k,f[k]]))),size:{filtered_n:cached.payload.facts.length}};
      assertFacts(sales);
      assert.deepEqual(sortedFacts(sales.rows),sortedFacts(context.sales_facts[bundleKey({network,period})]),'LOCAL_REMOTE_SALES_FACTS_DIFFER');
      const observed=plan.sales?await callCertified('sales_observe_many',{run_id,commercial_universe:network,period,cutoff:salesCutoff,operations:[{kind:'TOTAL'},{kind:'BRAND_NETWORK'},{kind:'STORE_FINANCIAL_ENTITY'}]}):cached.payload.sales_p1;
      const monthFacts=sales.rows.filter(r=>r.sale_date?.startsWith(period));
      assertParity(monthFacts,observed.results.find(x=>x.operation.kind==='TOTAL').evidence);
      const forum=plan.forum?{}:structuredClone(cached.payload.forum_p1);
      if(plan.forum)for(const measure of ['QUOTATIONS','APPLICATIONS','CURSES','UFIS']){
        const dimensions={};
        for(const dimension of ['BRAND',network==='OWN_STORES'?'STORE':'DISTRIBUTOR']){
          const e=await callCertified('data_observe',{run_id,source:'FORUM',measure,period_from:period,period_to:period,cutoff:forumCutoff,evidence_shape:'DIMENSIONAL_QUANTITATIVE_DATASET',dimension,filters:{network:[network]}});
          if(e.authority!=='P1_CERTIFIED'||!e.coverage.complete)throw new Error('FORUM_NOT_CERTIFIED');
          dimensions[dimension]=e;
        }
        const values=Object.values(dimensions).map(e=>e.payload.members.reduce((s,m)=>s+m.value,0));
        if(values[0]!==values[1])throw new Error('FORUM_DIMENSION_PARITY_FAILED');
        forum[measure]={value:values[0],dimensions};
      }
      const brandEvidence=observed.results.find(x=>x.operation.kind==='BRAND_NETWORK').evidence;
      const groupedBrands=new Map();
      for(const member of brandEvidence.payload.members){
        const id=member.members.find(m=>m.dimension==='BRAND').member_id;
        groupedBrands.set(id,(groupedBrands.get(id)||0)+member.value);
      }
      const fetchedBrands=new Map();
      for(const f of monthFacts)fetchedBrands.set(String(f.brand_id??'UNRESOLVED'),(fetchedBrands.get(String(f.brand_id??'UNRESOLVED'))||0)+1);
      if(JSON.stringify([...groupedBrands].sort())!==JSON.stringify([...fetchedBrands].sort()))throw new Error('P1_BRAND_PARITY_FAILED');
      const projected=projectSales(monthFacts,network,maps);
      const dealer_ufis=network==='DEALERS'?(plan.forum?projectDealerUfis(await getDealerWork(),period,forumCutoff,dealerIdentities):structuredClone(cached.payload.history.find(h=>h.period===period).dealer_ufis)):null;
      if(dealer_ufis)assertDealerUfiParity(dealer_ufis,forum.UFIS);
      history.push({period,total:projected.totals.total,total_ufis:projected.totals.total_ufis,penetration:null,sales_cutoff:salesCutoff,forum_cutoff:forumCutoff,forum,...(dealer_ufis?{dealer_ufis}:{})});
      const reports={};
      for(const months of selectionsForEnd(year,month)){
        const facts=sales.rows.filter(r=>months.includes(r.sale_date?.slice(0,7)));
        const p=projectSales(facts,network,maps);
        // Selection and pivot of certified FETCH facts, never re-recognition.
        reports[months.join(',')]={...p,network,entity_label:network==='OWN_STORES'?'Sucursal':'Dealer',selected_months:months,date_from:months[0]+'-01',date_to:salesCutoff,authority:'SALES P1 FETCH / FORUM P1 OBSERVE',mode:'CERTIFIED_SNAPSHOT',sales_cutoff:salesCutoff,forum_cutoff:forumCutoff,
          derived_status:'UNAVAILABLE_NO_CERTIFIED_COMBINATION'};
      }
      const facts=sales.rows.map(f=>({...f,brand:maps.brands[String(f.brand_id)]||'SIN MARCA RESUELTA',model:maps.models[String(f.model_id)]||'SIN MODELO RESUELTO',entity_label:network==='OWN_STORES'?f.store_label:maps.groups[String(f.dealer_group_id)]||'SIN RESOLVER',seller:maps.sellers[String(f.seller_id)]||'SIN VENDEDOR RESUELTO',rut:customers.get(f.vin)||''}));
      rows.push({period,network,dimension:'BUNDLE',payload:{contract:CONTRACT,reports,facts,history:structuredClone(history),sales_p1:observed,forum_p1:forum,source_signature:before,run_id},sales_cutoff:salesCutoff,forum_cutoff:forumCutoff});
      validation.push({network,period,sales:monthFacts.length,unresolved:projected.unresolved_vins.length,brands:projected.totals,forum:Object.fromEntries(Object.entries(forum).map(([k,v])=>[k,v.value]))});
      tagBundle(rows.at(-1),{...plan.signatures,validation:validation.at(-1)},context.engine);
      log(JSON.stringify({event:'P1_RECONCILED',...validation.at(-1)}));
    }
  }
  // Independent required acceptance fixture. Never used to fill a payload.
  if(stats.rebuilt)for(const network of NETWORKS){
    const fixture=await callCertified('data_fetch',{run_id,source:'SALES',filters:{commercial_universe:network,date_from:'2026-10-01',date_to:'2026-10-20'}});
    assertFacts(fixture);
    const p=projectSales(fixture.rows,network,maps);
    if(fixture.rows.length!==(network==='OWN_STORES'?175:101)||p.unresolved_vins.length)throw new Error('OCTOBER_20_ACCEPTANCE_FAILED');
    log(JSON.stringify({event:'ACCEPTANCE_2026_10_20',network,total:fixture.rows.length,unresolved:0,brands:p.totals,vins:fixture.rows.map(r=>r.vin).sort()}));
  }
  return {rows,validation,stats};
}
