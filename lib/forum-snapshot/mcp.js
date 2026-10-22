const URL = 'https://cidef-motor-test-azure.calmforest-1c67ab46.chilecentral.azurecontainerapps.io/api/mcp';
async function requestCertified(name,args) {
  const response=await fetch(URL,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(240000)});
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
