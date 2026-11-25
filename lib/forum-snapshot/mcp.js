const URL = 'https://cidef-motor-test-azure.calmforest-1c67ab46.chilecentral.azurecontainerapps.io/api/mcp';
function unifiedCall(name, args) {
  // New public MCP surface: legacy operations remain registered as internal
  // actions under data_query. Keep their certified contracts unchanged.
  const {run_id, source, ...parameters} = args;
  if (name === 'data_observe') {
    const {measure, period, period_from, period_to, cutoff, dimension, filters} = parameters;
    if (!source || !measure) throw new Error('INVALID_CERTIFIED_OBSERVATION');
    const time = period_from && period_to
      ? (period_from === period_to ? {period: period_from} : {from_period: period_from, to_period: period_to})
      : {period};
    if (cutoff) time.cutoff = cutoff;
    return {name:'data_query', args:{run_id,source,request:{
      measure,time,filters:filters || {},group_by:dimension ? [dimension] : [],
    }}};
  }
  return {name:'data_query',args:{run_id,...(source?{source}:{}),action:name,arguments:parameters}};
}

async function requestCertified(name,args) {
  const routed=unifiedCall(name,args);
  const response=await fetch(URL,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:routed.name,arguments:routed.args}}),signal:AbortSignal.timeout(240000)});
  if(!response.ok)throw new Error('CERTIFIED_HTTP_'+response.status);
  const text=await response.text();
  const raw=text.startsWith('event:')?JSON.parse(text.split('\n').find(x=>x.startsWith('data: ')).slice(6)):JSON.parse(text);
  if(raw.error||raw.result?.isError)throw new Error('CERTIFIED_MCP_ERROR: '+JSON.stringify(raw.error||raw.result.content));
  const output=raw.result.structuredContent||JSON.parse(raw.result.content.find(x=>x.type==='text').text);
  if(output.error)throw new Error('CERTIFIED_RESULT_ERROR: '+JSON.stringify(output.error));
  return output;
}

export async function callCertified(name,args,{onAttempt=()=>{}}={}) {
  for(let attempt=1;attempt<=3;attempt++){
    try{onAttempt();return await requestCertified(name,args);}
    catch(error){
      const transient=error instanceof TypeError||error.name==='TimeoutError'||error.name==='AbortError'||/^CERTIFIED_HTTP_5/.test(error.message);
      if(!transient||attempt===3)throw new Error('P1_TRANSPORT '+name+' '+(args.period||args.period_from||args.filters?.date_to||'')+': '+error.message);
      console.log(JSON.stringify({event:'CERTIFIED_TRANSPORT_RETRY',tool:name,period:args.period||args.period_from||args.filters?.date_to,attempt}));
      await new Promise(resolve=>setTimeout(resolve,attempt*1000));
    }
  }
}
