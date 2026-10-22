// Orchestration only: certified Azure MCP -> presentation payload -> atomic snapshot.
// Azure platform and all commercial engines are reused unchanged over their current interface.
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { callCertified } from '../lib/forum-snapshot/mcp.js';
import { CONTRACT, NETWORKS, monthEnd, projectSales, assertFacts, assertParity, selectionsForEnd, loadDealerIdentities, projectDealerUfis, assertDealerUfiParity } from '../lib/forum-snapshot/projection.js';
import { replaceSnapshot } from '../lib/forum-snapshot/publication.js';
// Replacement publisher: inactive until the three legacy Action callers are
// switched together. Validation never changes STATUS or BUNDLE rows.
const mode=process.argv[2]||'--validate';
if(!['--validate','--publish'].includes(mode)||process.argv.length>3)throw new Error('USE_VALIDATE_OR_PUBLISH');
const publish=mode==='--publish';
if(publish&&process.env.FORUM_SNAPSHOT_PUBLISHER!=='azure-platform')throw new Error('PUBLISHER_HANDOFF_NOT_CONFIRMED');
const url=process.env.AZURE_DATABASE_URL;
if(!url||new URL(url).hostname!=='cidef-postgres-prod.postgres.database.azure.com')throw new Error('AZURE_DATABASE_REQUIRED');
const client=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,statement_timeout:240000});
const run_id='forum-ventas-'+randomUUID(), rows=[], validation=[];
const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Santiago'});
const year=today.slice(0,4);
// Fingerprints run after loads, never on a front request. Include identity inputs.
const sources=['ventas_raw','vehiculos_raw','notas_venta_raw','notas_credito_raw','vehiculo_canonico','sucursales_master','dealers_master','dealer_groups','dealer_aliases','sucursal_aliases','producto_aliases_v01','marcas_master_v01','forum_funnel_raw'];
async function signatures(){
  const result={};
  for(const table of sources){
    const {rows:[r]}=await client.query(`SELECT count(*)::int n,md5(coalesce(string_agg(h,'' ORDER BY h),'')) hash FROM (SELECT md5(t::text) h FROM public.${table} t) q`);
    result[table]=r;
  }
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
async function state(payload){if(!publish)return;await client.query(`INSERT INTO public.forum_ventas_snapshot_v01(period,network,dimension,payload,generation_id) VALUES ('STATE','ALL','STATUS',$1::jsonb,$2) ON CONFLICT(period,network,dimension) DO UPDATE SET payload=excluded.payload,generation_id=excluded.generation_id,updated_at=now()`,[JSON.stringify(payload),run_id]);}
let locked=false, installed=false;
try {
  await client.connect();
  if(!publish)await client.query('SET default_transaction_read_only=on');
  await client.query('SET statement_timeout=0');
  await client.query("SELECT pg_advisory_lock(hashtext('forum_ventas_snapshot_v01'))");
  await client.query('SET statement_timeout=240000');
  locked=true;
  if(!locked)throw new Error('SNAPSHOT_REFRESH_ALREADY_RUNNING');
  const {rows:[existing]}=await client.query("SELECT to_regclass('public.forum_ventas_snapshot_v01')::text AS relation");
  if(!existing.relation)throw new Error('EXISTING_FORUM_SNAPSHOT_TABLE_REQUIRED');
  installed=true;
  const before=await signatures();
  const {rows:[cutoffs]}=await client.query(`SELECT (SELECT max(fecha_factura::date)::text FROM ventas_raw WHERE fecha_factura ~ '^\\d{4}-\\d{2}-\\d{2}' AND fecha_factura::date <= $1::date) sales, (SELECT max(snapshot_date)::text FROM forum_funnel_raw WHERE snapshot_date <= $1::date) forum`,[today]);
  if(!cutoffs.sales||!cutoffs.forum)throw new Error('SOURCE_CUTOFF_MISSING');
  await state({status:'BUILDING',source_signature:before,sales_cutoff:cutoffs.sales,forum_cutoff:cutoffs.forum,run_id});
  const maps={};
  for(const [key,query] of Object.entries({brands:'SELECT marca_id::text id,nombre_canonico label FROM marcas_master_v01',groups:'SELECT dealer_group_id::text id,nombre_canonico label FROM dealer_groups',models:'SELECT modelo_id::text id,nombre_canonico label FROM modelos_master_v01',sellers:'SELECT persona_id::text id,nombre_canonico label FROM personas_master'}))maps[key]=Object.fromEntries((await client.query(query)).rows.map(r=>[r.id,r.label]));
  // Non-commercial XLSX metadata, keyed to certified VIN; does not select sales.
  const customerRows=await client.query(`SELECT DISTINCT ON(upper(btrim(vin_chasis))) upper(btrim(vin_chasis)) vin,rut FROM vehiculos_raw WHERE nullif(btrim(vin_chasis),'') IS NOT NULL ORDER BY upper(btrim(vin_chasis)),fecha_factura DESC NULLS LAST`);
  const customers=new Map(customerRows.rows.map(r=>[r.vin,r.rut]));
  const dealerIdentities=await loadDealerIdentities(client);
  const dealerWork=await callCertified('data_fetch',{run_id,source:'FORUM',filters:{network:['DEALERS'],stage:['CURSE']},fields:['operation_number','network','distributor','brand_id','brand','curse_date','ufi_curse','has_curse_evidence']});
  const last=Math.max(Number(cutoffs.sales.slice(5,7)),Number(cutoffs.forum.slice(5,7)));
  for(const network of NETWORKS){
    const history=[];
    for(let month=1;month<=last;month++){
      const period=year+'-'+String(month).padStart(2,'0');
      const salesCutoff=[monthEnd(period),cutoffs.sales].sort()[0];
      const forumCutoff=[monthEnd(period),cutoffs.forum].sort()[0];
      if(salesCutoff<period+'-01'||forumCutoff<period+'-01')throw new Error('INDEPENDENT_SOURCE_PERIOD_UNAVAILABLE: '+period);
      const sales=await callCertified('data_fetch',{run_id,source:'SALES',filters:{commercial_universe:network,date_from:year+'-01-01',date_to:salesCutoff}});
      assertFacts(sales);
      const observed=await callCertified('sales_observe_many',{run_id,commercial_universe:network,period,cutoff:salesCutoff,operations:[{kind:'TOTAL'},{kind:'BRAND_NETWORK'},{kind:'STORE_FINANCIAL_ENTITY'}]});
      const monthFacts=sales.rows.filter(r=>r.sale_date?.startsWith(period));
      assertParity(monthFacts,observed.results.find(x=>x.operation.kind==='TOTAL').evidence);
      const forum={};
      for(const measure of ['QUOTATIONS','APPLICATIONS','CURSES','UFIS']){
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
      const dealer_ufis=network==='DEALERS'?projectDealerUfis(dealerWork,period,forumCutoff,dealerIdentities):null;
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
      console.log(JSON.stringify({event:'P1_RECONCILED',...validation.at(-1)}));
    }
  }
  // Independent required acceptance fixture. Never used to fill a payload.
  for(const network of NETWORKS){
    const fixture=await callCertified('data_fetch',{run_id,source:'SALES',filters:{commercial_universe:network,date_from:'2026-10-01',date_to:'2026-10-20'}});
    assertFacts(fixture);
    const p=projectSales(fixture.rows,network,maps);
    if(fixture.rows.length!==(network==='OWN_STORES'?175:101)||p.unresolved_vins.length)throw new Error('OCTOBER_20_ACCEPTANCE_FAILED');
    console.log(JSON.stringify({event:'ACCEPTANCE_2026_10_20',network,total:fixture.rows.length,unresolved:0,brands:p.totals,vins:fixture.rows.map(r=>r.vin).sort()}));
  }
  if(await signatures()!==before)throw new Error('SOURCE_CHANGED_DURING_GENERATION');
  if(!publish){
    console.log(JSON.stringify({event:'SNAPSHOT_VALIDATED_NOT_PUBLISHED',run_id,rows:rows.length,validation}));
    if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'\nForum replacement publisher: read-only validation complete; no snapshot or status writes.\n');
  }else{
    // Real PostgreSQL failure injection: prove that no candidate became visible.
    const {rows:[prior]}=await client.query("SELECT md5(coalesce(string_agg(md5(t::text),'' ORDER BY period,network,dimension),'')) hash FROM forum_ventas_snapshot_v01 t WHERE dimension='BUNDLE'");
    try {await replaceSnapshot(client,rows.slice(0,1),run_id,{beforeCommit(){throw new Error('EXPECTED_ROLLBACK_PROBE');}});} catch(e){if(e.message!=='EXPECTED_ROLLBACK_PROBE')throw e;}
    const {rows:[afterProbe]}=await client.query("SELECT md5(coalesce(string_agg(md5(t::text),'' ORDER BY period,network,dimension),'')) hash FROM forum_ventas_snapshot_v01 t WHERE dimension='BUNDLE'");
    if(prior.hash!==afterProbe.hash)throw new Error('ROLLBACK_INVARIANT_FAILED');
    // READY state is published in the same transaction as every complete result.
    const ready={period:'STATE',network:'ALL',dimension:'STATUS',sales_cutoff:cutoffs.sales,forum_cutoff:cutoffs.forum,payload:{status:'READY',source_signature:before,run_id,contract:CONTRACT,validation,rollback_probe:'PASS'}};
    await replaceSnapshot(client,[...rows,ready],run_id);
    console.log(JSON.stringify({event:'SNAPSHOT_PUBLISHED',run_id,rows:rows.length,source_signature:before,rollback_probe:'PASS'}));
    if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,`\nForum snapshot: ${rows.length} bundles published atomically; dealer × brand UFI reconciled to P1; rollback probe PASS. SALES financial identity and FORUM dated events remain separate.\n`);
  }
} catch(error){
  if(installed&&locked)await state({status:'FAILED',run_id,error:error.message,retains_previous:true}).catch(()=>{});
  console.error(JSON.stringify({event:'SNAPSHOT_NOT_PUBLISHED',error:error.message,retains_previous:true}));
  process.exitCode=1;
} finally {
  if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('forum_ventas_snapshot_v01'))").catch(()=>{});
  await client.end().catch(()=>{});
}
