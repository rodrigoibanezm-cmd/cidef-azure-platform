// Incremental orchestration only. P1/P2/P3 and commercial projections unchanged.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { callCertified } from '../lib/forum-snapshot/mcp.js';
import { CONTRACT, loadDealerIdentities } from '../lib/forum-snapshot/projection.js';
import { replaceSnapshot } from '../lib/forum-snapshot/publication.js';
import { captureDependencies } from '../lib/forum-snapshot/dependencies.js';
import { generateBundles } from '../lib/forum-snapshot/generate.js';
import { assertSnapshotParity, digest, engineSignature, indexCache, inspectPlan } from '../lib/forum-snapshot/incremental.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

const flags=new Set(process.argv.slice(2));
if([...flags].some(x=>!['--validate','--publish','--compare','--full'].includes(x))||['--validate','--publish','--compare'].filter(x=>flags.has(x)).length>1)throw new Error('USE_VALIDATE_COMPARE_OR_PUBLISH_OPTIONALLY_FULL');
const publish=flags.has('--publish'), compare=flags.has('--compare'), forceFull=flags.has('--full');
if(publish&&process.env.FORUM_SNAPSHOT_PUBLISHER!=='azure-platform')throw new Error('PUBLISHER_HANDOFF_NOT_CONFIRMED');
const url=process.env.AZURE_DATABASE_URL;
if(!url||new URL(url).hostname!=='cidef-postgres-prod.postgres.database.azure.com')throw new Error('AZURE_DATABASE_REQUIRED');
const client=new pg.Client({connectionString:url,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,statement_timeout:240000});
const run_id='forum-ventas-'+randomUUID();
const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Santiago'}),year=today.slice(0,4);
let locked=false,installed=false,publicationAuthorized=false,comparisonReport;
async function state(payload){if(publish&&publicationAuthorized)await client.query(`INSERT INTO public.forum_ventas_snapshot_v01(period,network,dimension,payload,generation_id) VALUES ('STATE','ALL','STATUS',$1::jsonb,$2) ON CONFLICT(period,network,dimension) DO UPDATE SET payload=excluded.payload,generation_id=excluded.generation_id,updated_at=now()`,[JSON.stringify(payload),run_id]);}
async function snapshotHash(){return (await client.query("SELECT md5(coalesce(string_agg(md5(t::text),'' ORDER BY period,network,dimension),'')) hash FROM forum_ventas_snapshot_v01 t")).rows[0].hash;}
async function cutoffs(){return (await client.query(`SELECT (SELECT max(fecha_factura::date)::text FROM ventas_raw WHERE fecha_factura ~ '^\\d{4}-\\d{2}-\\d{2}' AND fecha_factura::date <= $1::date) sales, (SELECT max(snapshot_date)::text FROM forum_funnel_raw WHERE snapshot_date <= $1::date) forum`,[today])).rows[0];}
const engine=await engineSignature();
try{
  await client.connect();
  if(!publish)await client.query('SET default_transaction_read_only=on');
  await client.query('SET statement_timeout=0');
  await client.query("SELECT pg_advisory_lock(hashtext('forum_ventas_snapshot_v01'))");
  locked=true;
  await client.query('SET statement_timeout=240000');
  if(!(await client.query("SELECT to_regclass('public.forum_ventas_snapshot_v01')::text relation")).rows[0].relation)throw new Error('EXISTING_FORUM_SNAPSHOT_TABLE_REQUIRED');
  installed=true;
  const initialHash=await snapshotHash(),started=Date.now();
  const sourceCutoffs=await cutoffs();
  if(!sourceCutoffs.sales||!sourceCutoffs.forum)throw new Error('SOURCE_CUTOFF_MISSING');
  const context=await captureDependencies(client,{year,cutoffs:sourceCutoffs,engine});
  const dependency_ms=Date.now()-started;
  const contracts={};
  for(const source of ['SALES','FORUM'])contracts[source]=await callCertified('data_describe',{run_id,source});
  context.engine=digest({engine,contracts});
  // Pin the contracts observed during validation as well as the local source.
  if(publish){
    const attestation=JSON.parse(await readFile(new URL('../docs/forum-snapshot-parity.json',import.meta.url),'utf8'));
    if(attestation.status!=='PASS'||attestation.engine_signature!==context.engine)throw new Error('INCREMENTAL_LIVE_PARITY_REQUIRED');
    publicationAuthorized=true;
  }
  const cached=(await client.query("SELECT period,network,dimension,payload,sales_cutoff::text,forum_cutoff::text FROM forum_ventas_snapshot_v01 WHERE dimension='BUNDLE' AND period LIKE $1 ORDER BY network,period",[year+'-%'])).rows;
  const cache=indexCache(cached),dealerIdentities=await loadDealerIdentities(client);
  const metrics=[];
  async function generate(label,ctx,options={}){
    const begin=Date.now(),m={label,mcp_calls:0,transport_attempts:0,by_tool:{}};
    const result=await generateBundles(ctx,{cache,run_id,dealerIdentities,...options,
      callCertified:async(name,args)=>{m.mcp_calls++;m.by_tool[name]=(m.by_tool[name]||0)+1;
        return callCertified(name,args,{onAttempt:()=>m.transport_attempts++});}});
    Object.assign(m,{duration_ms:Date.now()-begin,...result.stats});metrics.push(m);
    console.log(JSON.stringify({event:'SNAPSHOT_EXECUTION',...m}));return result;
  }
  let result;
  if(compare){
    // Build a fresh independent full candidate, then exercise the warm cache
    // and a forced SALES refresh of the open month using REAL MCP responses.
    const full=await generate('full',context,{forceFull:true});
    const recaptureStarted=Date.now();
    const fresh=await captureDependencies(client,{year,cutoffs:await cutoffs(),engine});
    if(fresh.guard!==context.guard)throw new Error('SOURCE_CHANGED_DURING_GENERATION');
    fresh.engine=context.engine;
    const recapture_ms=Date.now()-recaptureStarted;
    const warm=await generate('incremental_unchanged',fresh,{cache:indexCache(full.rows)});
    assertSnapshotParity(warm.rows,full.rows);
    metrics.at(-1).dependency_ms=recapture_ms;
    metrics.at(-1).total_ms=recapture_ms+metrics.at(-1).duration_ms;
    const changed=structuredClone(fresh);
    const open=fresh.periods.at(-1);
    for(const network of ['OWN_STORES','DEALERS'])changed.sales_signatures[network+':'+open]+=':validation-invalidation';
    const partial=await generate('incremental_open_sales',changed,{cache:indexCache(full.rows)});
    assertSnapshotParity(partial.rows,full.rows);
    if(await snapshotHash()!==initialHash)throw new Error('READ_ONLY_SNAPSHOT_CHANGED');
    result=full;
    const report={status:'PASS',engine_signature:context.engine,source_guard:context.guard,dependency_ms,
      metrics,comparison:'Every business value, identity, dimension, cutoff and quality flag; volatile provenance excluded',
      historical_invalidation:'node --test test/forum-snapshot-incremental.test.js',published:false};
    comparisonReport=report;
  }else{
    console.log(JSON.stringify({event:'SNAPSHOT_PLAN',dependency_ms,plan:inspectPlan(context,cache,forceFull)}));
    await state({status:'BUILDING',source_signature:context.guard,sales_cutoff:sourceCutoffs.sales,forum_cutoff:sourceCutoffs.forum,run_id});
    result=await generate(forceFull?'full':'incremental',context,{forceFull});
  }
  const final=await captureDependencies(client,{year,cutoffs:await cutoffs(),engine});
  if(final.guard!==context.guard)throw new Error('SOURCE_CHANGED_DURING_GENERATION');
  const finalContracts={};
  for(const source of ['SALES','FORUM'])finalContracts[source]=await callCertified('data_describe',{run_id,source});
  if(digest(finalContracts)!==digest(contracts))throw new Error('CONTRACT_CHANGED_DURING_GENERATION');
  if(comparisonReport){
    comparisonReport.total_ms=Date.now()-started;
    comparisonReport.control_mcp_calls=4;
    const path=process.env.FORUM_SNAPSHOT_REPORT;
    if(path)await writeFile(path,JSON.stringify(comparisonReport,null,2)+'\n');
    console.log(JSON.stringify({event:'INCREMENTAL_FULL_PARITY',...comparisonReport}));
  }
  if(publish){
    const prior=await snapshotHash();
    try{await replaceSnapshot(client,result.rows.slice(0,1),run_id,{beforeCommit(){throw new Error('EXPECTED_ROLLBACK_PROBE');}});}catch(e){if(e.message!=='EXPECTED_ROLLBACK_PROBE')throw e;}
    if(await snapshotHash()!==prior)throw new Error('ROLLBACK_INVARIANT_FAILED');
    const ready={period:'STATE',network:'ALL',dimension:'STATUS',sales_cutoff:sourceCutoffs.sales,forum_cutoff:sourceCutoffs.forum,
      payload:{status:'READY',source_signature:context.guard,run_id,contract:CONTRACT,validation:result.validation,rollback_probe:'PASS',metrics,dependency_ms}};
    // All rows retain one publication generation for the existing history reader.
    // Unaffected payloads and original P3 provenance are preserved byte-for-byte.
    await replaceSnapshot(client,[...result.rows,ready],run_id);
    console.log(JSON.stringify({event:'SNAPSHOT_PUBLISHED',run_id,rows:result.rows.length,metrics,dependency_ms,total_ms:Date.now()-started}));
  }else if(await snapshotHash()!==initialHash)throw new Error('READ_ONLY_SNAPSHOT_CHANGED');
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,`\n## Forum snapshot ${compare?'parity comparison':publish?'publication':'validation'}\n\nDependency capture: ${dependency_ms} ms. Published: ${publish}.\n\n| Mode | Generation ms | MCP calls | Attempts | Rebuilt | Reused |\n|---|---:|---:|---:|---:|---:|\n${metrics.map(m=>`| ${m.label} | ${m.duration_ms} | ${m.mcp_calls} | ${m.transport_attempts} | ${m.rebuilt} | ${m.reused} |`).join('\n')}\n`);
}catch(error){
  if(installed&&locked)await state({status:'FAILED',run_id,error:error.message,retains_previous:true}).catch(()=>{});
  console.error(JSON.stringify({event:'SNAPSHOT_NOT_PUBLISHED',error:error.message,retains_previous:true}));process.exitCode=1;
}finally{
  if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('forum_ventas_snapshot_v01'))").catch(()=>{});
  await client.end().catch(()=>{});await closeAzurePool();
}
