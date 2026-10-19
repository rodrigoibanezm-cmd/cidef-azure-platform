import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { commercialDateForDay } from '../ventas/commercialMonth.js';
import { describeDataSource, inspectDataSource, fetchDataSource, observeDataSource, temporalFingerprintDataSource, listDataSources } from '../data-floor/registry.js';
import { discoverP2Units, describeP2Unit } from '../p2/registry.js';
import { executeP2 } from '../p2/execute.js';
import { resolveIdentity, listIdentityDimensions } from '../data-floor/identityResolver.js';
import { DIMENSIONS as SALES_DIMENSIONS } from '../data-floor/sales/contract.js';
import { observeCrmMany } from '../data-floor/crmCertifier.js';
import { observeSalesWindows } from '../data-floor/sales/windowObserve.js';
import { observeSalesMany } from '../data-floor/sales/multiObserve.js';
import { journalP3Tool, getP3Run, resolveP1EvidenceRefs } from '../p3/executionJournal.js';

async function traced(run_id,floor,tool_name,input,fn){const started=Date.now();try{const out=await fn();await journalP3Tool({run_id,floor,tool_name,input,output:out,duration_ms:Date.now()-started});return out;}catch(error){await journalP3Tool({run_id,floor,tool_name,input,status:'FAILED',error_code:error?.code||error?.name||'ERROR',output:{error:{code:error?.code||error?.name||'ERROR',message:error?.message??String(error),...(error?.details?{details:error.details}:{})}},duration_ms:Date.now()-started}).catch(()=>{});throw error;}}

export function createMcpServer(){
  const server=new McpServer(
    {name:'cidef',version:'1.5.0'},
    {instructions:'Resolve CIDEF business questions using three authority levels. P1 alone certifies factual evidence and P2 alone certifies deterministic transformations. Keep one stable run_id for the complete user question. Use P1 and P2 in whatever sequence the investigation requires. Read data_describe for exact measure ids, fields, filters and supported dimensions; never guess aliases. Use crm_observe_many for multiple compatible CRM measures and dimensions so one universe load serves the question; reuse its individual evidence instead of repeating data_observe. CRM observations require explicit commercial_universe and date_axis/cohort_axis in filters. CRM SOLD is a declared outcome, not an ERP-verified sale. Its conversion denominator includes all cohort leads. Past CRM cohorts use current state, never a certified historical close; retain freshness, incomplete-period and identity coverage warnings. Use data_observe for certified counts and dimensional splits, and data_resolve for supported identity dimensions. When one question needs multiple compatible SALES totals/groupings at one explicit cutoff, use sales_observe_many so preparation, recognition and the Certified Fact Set are shared inside that one request. Use data_fetch only when individual facts are needed; reuse already returned facts instead of fetching the same universe again with fewer fields. On validation errors use the returned allowed values. P2 is needed for analytical transformations, not for a factual SALES count or network split. For PRICING × SALES use one brand-wide data_observe PRICING, one sales_observe_windows with that original complete evidence_id and explicit cutoff, then p2.pricing_window_sales with pricing and sales evidence slots. The reference includes all models/versions/windows even when its payload is large; do not split by model or use data_fetch. For a question bounded to the requested period use INTERSECTION; use FULL_EPISODE only when explicitly requested. P2 computes VIN/day and same-version previous-window acceleration/deceleration; do not calculate them freely or override the evidence scope. Preserve partial/open-window denominators and coexistence limitations. External material or P3 reasoning does not become P1_CERTIFIED or P2_CERTIFIED. Treat failed or ambiguous observations as evidence about the attempted hypothesis rather than automatic proof that the overall question is impossible; revised factual hypotheses must be certified by P1 before being used as certified evidence. Eligible quantitative P1 observations automatically include a certified temporal fingerprint of the same slice for LLM interpretation; eligibility is determined by the P1 evidence contract, not by a semantic classification of the question. It is context, not P2 input. Do not invent evidence or recompute a material analytical transformation that belongs to P2.'}
  );

  server.registerTool('data_describe',{
    title:'Describe a certified CIDEF factual source',
    description:'Piso 1 discovery. Returns the semantic contract for a factual source without exposing physical tables or SQL. Use its exact measure ids, fields, filters, dimensions and semantic constraints to construct subsequent calls.',
    inputSchema:{run_id:z.string().min(1),source:z.enum(listDataSources())},
    outputSchema:{source:z.string(),version:z.string(),meaning:z.string(),grain:z.string(),date_semantics:z.object({}).catchall(z.any()),measures:z.union([z.object({}).catchall(z.any()),z.array(z.object({}).catchall(z.any()))]).optional(),dimensions:z.array(z.string()).optional(),semantic_constraints:z.array(z.string()).optional(),filters:z.array(z.string()),fields:z.array(z.string()),operations:z.array(z.string()),evidence_shapes:z.array(z.string()).optional(),boolean_logic:z.string(),lineage:z.object({}).catchall(z.any())},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await traced(args.run_id,'P1','data_describe',args,()=>describeDataSource(args.source));return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};});

  server.registerTool('data_inspect',{
    title:'Inspect a certified CIDEF factual universe',
    description:'Piso 1 planning. Applies semantic filters and returns N, shape, coverage and quality without returning the factual rows.',
    inputSchema:{run_id:z.string().min(1),source:z.enum(listDataSources()),filters:z.object({}).catchall(z.any()).default({})},
    outputSchema:{source:z.string(),operation:z.string(),filters:z.object({}).catchall(z.any()),size:z.object({}).catchall(z.any()),shape:z.object({}).catchall(z.any()),quality:z.object({}).catchall(z.any()),lineage:z.object({}).catchall(z.any())},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await traced(args.run_id,'P1','data_inspect',args,()=>inspectDataSource(args.source,{filters:args.filters}));return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};});

  server.registerTool('data_fetch',{
    title:'Fetch a certified CIDEF factual dataset',
    description:'Piso 1 factual access. Returns a certified WORK dataset. AND is applied between filters; arrays are OR values within a filter.',
    inputSchema:{run_id:z.string().min(1),source:z.enum(listDataSources()),filters:z.object({}).catchall(z.any()).default({}),fields:z.array(z.string()).optional()},
    outputSchema:{source:z.string(),operation:z.string(),dataset:z.string(),version:z.string(),filters:z.object({}).catchall(z.any()),grain:z.string(),size:z.object({}).catchall(z.any()),rows:z.array(z.object({}).catchall(z.any())),quality:z.object({}).catchall(z.any()),lineage:z.object({}).catchall(z.any())},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await traced(args.run_id,'P1','data_fetch',args,()=>fetchDataSource(args.source,{filters:args.filters,fields:args.fields}));return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};});

  server.registerTool('data_resolve',{
    title:'Resolve a canonical CIDEF identity',
    description:'Piso 1 identity resolution. Resolves a value against a certified canonical dimension. The model supplies the dimension; the backend performs deterministic identity matching and returns RESOLVED, AMBIGUOUS, or NOT_FOUND.',
    inputSchema:{run_id:z.string().min(1),dimension:z.enum(listIdentityDimensions()),value:z.string().min(1)},
    outputSchema:{dimension:z.string(),input_value:z.string(),identity_contract:z.string(),identity_version:z.string(),status:z.string(),canonical_id:z.string().optional(),canonical_label:z.string().optional(),matches:z.array(z.object({}).catchall(z.any())),lineage:z.object({}).catchall(z.any())},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await traced(args.run_id,'P1','data_resolve',args,()=>resolveIdentity(args));return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};});

  server.registerTool('data_observe',{
    title:'Observe a certified CIDEF factual measure',
    description:'Piso 1 factual observation. Returns the requested P1-certified observation from its certified authority. PRICING returns published commercial-condition windows with COMMERCIAL_CONDITION_WINDOWS; other sources support quantitative observations as described by their contracts. When the P1 evidence contract marks the observation as eligible, the result also includes an automatic P1-certified temporal fingerprint for the same slice, covering the prior 24 months. This context is delivered directly to the LLM and is not part of P2 evidence inputs.',
    inputSchema:{
      run_id:z.string().min(1),
      source:z.enum(listDataSources()),
      measure:z.string().min(1).describe('Exact measure id from data_describe; SALES uses VIN_SALES. CRM uses LEADS_CREATED, LEADS_ASSIGNED, SOLD (venta declarada en CRM), CONVERSION_RATE (SOLD / all cohort leads), MANAGED, UNMANAGED, MANAGEMENT_RATE (MANAGED / all cohort leads). PRICING uses PRICE_EPISODES with evidence_shape=COMMERCIAL_CONDITION_WINDOWS.'),
      evidence_shape:z.enum(['QUANTITATIVE_OBSERVATION','CUMULATIVE_PERIOD_OBSERVATION','PERIOD_CALENDAR','HISTORICAL_PERIOD_SERIES','PERIOD_OBSERVATION_SERIES','DIMENSIONAL_QUANTITATIVE_DATASET','REFERENCE_OBSERVATION','SELLER_CONTRIBUTION_HISTORY','OPERATION_STATE_SNAPSHOT','COMMERCIAL_CONDITION_WINDOWS']).optional().default('QUANTITATIVE_OBSERVATION'),
      period:z.string().optional().describe('Period identity YYYY-MM when the requested evidence shape is period-based.'),
      cutoff:z.string().optional().describe('Optional explicit cutoff YYYY-MM-DD. For FORUM OPERATION_STATES + OPERATION_STATE_SNAPSHOT this is the exact snapshot_date and is required. Otherwise, when omitted for an open period, P1 must resolve the latest certified available SALES cutoff; never inherit a cutoff from a previous question or run. CRM cutoff only bounds cohort/event membership; it never reconstructs historical outcome state.'),
      period_from:z.string().optional().describe('First period YYYY-MM for a certified period observation series.'),
      period_to:z.string().optional().describe('Last period YYYY-MM for a certified period observation series.'),
      dimension:z.string().optional().describe('Dimension for DIMENSIONAL_QUANTITATIVE_DATASET evidence. SALES supports '+Object.keys(SALES_DIMENSIONS).join(', ')+'; use NETWORK with brand_id/model_id filters for network splits by brand/model. NETWORK is not a field or filter. RVM supports REGION, BRAND, MODEL, SEGMENT, BRAND_MODEL, SEGMENT_BRAND, SEGMENT_BRAND_MODEL; these use raw source label identities as described by data_describe(RVM). FORUM supports COMMERCIAL_OUTCOME, NETWORK, STORE, SELLER, EXECUTIVE, DISTRIBUTOR, MODEL, VERSION, STATUS, CERTIFIED_STAGE. CRM supports STORE, BRAND, PRODUCT_INTEREST, SELLER, ORIGIN; STORE/SELLER require filters.commercial_universe=OWN_STORES. CRM BRAND means product of interest. PRICING supports BRAND, MODEL, VERSION, MODEL_VERSION for commercial-condition windows; every window retains model and version identity.'),
      filters:z.object({}).catchall(z.any()).default({})
    },
    outputSchema:{evidence_id:z.string(),evidence_contract:z.string(),evidence_version:z.string(),authority:z.string(),status:z.string(),source:z.string(),operation:z.string(),grain:z.string(),measure:z.object({}).catchall(z.any()),universe:z.object({}).catchall(z.any()),dimensions:z.object({}).catchall(z.any()),temporal:z.object({}).catchall(z.any()),coverage:z.object({}).catchall(z.any()),payload:z.object({}).catchall(z.any()),lineage:z.object({}).catchall(z.any()),temporal_fingerprint:z.object({}).catchall(z.any()).optional()},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{
    const observationInput={measure:args.measure,evidence_shape:args.evidence_shape,period:args.period,cutoff:args.cutoff,period_from:args.period_from,period_to:args.period_to,dimension:args.dimension,filters:args.filters};
    const out=await traced(args.run_id,'P1','data_observe',args,async()=>{
      const focus=await observeDataSource(args.source,observationInput);
      const temporal_fingerprint=await temporalFingerprintDataSource(args.source,observationInput,focus);
      return temporal_fingerprint?{...focus,temporal_fingerprint}:focus;
    });
    return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};
  });

  server.registerTool('crm_observe_many',{
    title:'Observe several compatible CRM measures from one universe load',
    description:'P1 CRM only. Shares one existing buildCrmUniverses load across operations. Supply common period, temporal controls and identity filters in filters; each operation specifies COMPANY or OWN_STORES. STORE/SELLER require OWN_STORES. SOLD is venta declarada en CRM and CONVERSION_RATE divides by all cohort leads. MANAGED, UNMANAGED and MANAGEMENT_RATE describe management coverage; use COHORT explicitly to compare the same created/assigned cohort. Historical cohorts use current state, not certified month-end outcomes. Returns individual data_observe-compatible evidence and execution counts.',
    inputSchema:{
      run_id:z.string().min(1),period:z.string().optional(),
      period_from:z.string().optional(),period_to:z.string().optional(),cutoff:z.string().optional(),
      filters:z.object({}).catchall(z.any()).default({}).describe('Shared date_axis/cohort_axis, mode, cutoff_mode and identity filters. For lead/outcome comparison use mode=COHORT explicitly. Commercial universe belongs to each operation.'),
      operations:z.array(z.object({
        commercial_universe:z.enum(['COMPANY','OWN_STORES']),
        measure:z.enum(['LEADS_CREATED','LEADS_ASSIGNED','SOLD','CONVERSION_RATE','MANAGED','UNMANAGED','MANAGEMENT_RATE']),
        dimension:z.enum(['STORE','BRAND','PRODUCT_INTEREST','SELLER','ORIGIN']).optional(),
        evidence_shape:z.enum(['QUANTITATIVE_OBSERVATION','PERIOD_OBSERVATION_SERIES','DIMENSIONAL_QUANTITATIVE_DATASET']).optional()
      }).strict()).min(1)
    },
    outputSchema:{source:z.literal('CRM'),results:z.array(z.object({}).catchall(z.any())),execution:z.object({}).catchall(z.any())},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{
    const started=Date.now();
    try{
      const out=await observeCrmMany(args);
      await journalP3Tool({run_id:args.run_id,floor:'P1',tool_name:'crm_observe_many',input:args,
        output:{source:out.source,execution:out.execution},duration_ms:Date.now()-started});
      await Promise.all(out.results.map(result=>
        journalP3Tool({run_id:args.run_id,floor:'P1',tool_name:'data_observe',
          input:{run_id:args.run_id,source:'CRM',...result.operation},output:result.evidence,duration_ms:result.duration_ms})
      ));
      return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};
    }catch(error){
      await journalP3Tool({run_id:args.run_id,floor:'P1',tool_name:'crm_observe_many',input:args,status:'FAILED',
        error_code:error?.code||error?.name||'ERROR',output:{error:{code:error?.code||error?.name||'ERROR',message:error?.message??String(error)}},duration_ms:Date.now()-started}).catch(()=>{});
      throw error;
    }
  });

  server.registerTool('sales_observe_many',{
    title:'Observe several compatible SALES measures from one Certified Fact Set',
    description:'Piso 1 SALES only. Executes several compatible VIN_SALES operations at one explicit period/cutoff and commercial universe, reusing one execution-owned Certified Fact Set. Supports TOTAL, STORE, STORE_FINANCIAL_ENTITY, BRAND_NETWORK and MODEL_NETWORK_BY_BRAND. FINANCIAL_ENTITY preserves the recognized sale's source entity; exact FORUM is UFI executed, other resolved entities are Otros créditos, and unresolved entities are reported separately.',
    inputSchema:{
      run_id:z.string().min(1),
      period:z.string().regex(/^\d{4}-\d{2}$/),
      cutoff:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      commercial_universe:z.enum(['COMPANY','OWN_STORES','DEALERS']).optional().default('COMPANY'),
      operations:z.array(z.object({
        kind:z.enum(['TOTAL','STORE','STORE_FINANCIAL_ENTITY','BRAND_NETWORK','MODEL_NETWORK_BY_BRAND']),
        brand_id:z.union([z.string(),z.number()]).optional()
      })).min(1)
    },
    outputSchema:{
      source:z.literal('SALES'),period:z.string(),cutoff:z.string(),commercial_universe:z.string(),
      results:z.array(z.object({operation:z.object({}).catchall(z.any()),evidence:z.object({}).catchall(z.any())})),
      execution:z.object({preparations:z.number(),recognitions:z.number(),enrichments:z.number(),fact_sets:z.number(),selections:z.number(),operations:z.number(),fact_set_fingerprint:z.string()})
    },
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{
    const started=Date.now();
    try{
      const out=await observeSalesMany(args);
      await journalP3Tool({
        run_id:args.run_id,
        floor:'P1',
        tool_name:'sales_observe_many',
        input:args,
        output:{
          execution:out.execution,
          results:out.results.map(item=>({operation:item.operation,evidence_id:item.evidence.evidence_id}))
        },
        duration_ms:Date.now()-started
      });
      for(const item of out.results){
        const op=item.operation,group_by=op.kind==='STORE'?['STORE']:op.kind==='STORE_FINANCIAL_ENTITY'?['STORE','FINANCIAL_ENTITY']:op.kind==='BRAND_NETWORK'?['BRAND','NETWORK']:op.kind==='MODEL_NETWORK_BY_BRAND'?['MODEL','NETWORK']:[];
        const filters={commercial_universe:out.commercial_universe,date_from:commercialDateForDay(args.period,1),date_to:out.cutoff,...(op.kind==='MODEL_NETWORK_BY_BRAND'?{brand_id:op.brand_id}:{})};
        await journalP3Tool({run_id:args.run_id,floor:'P1',tool_name:'data_observe',input:{run_id:args.run_id,source:'SALES',measure:'VIN_SALES',period:args.period,cutoff:args.cutoff,group_by,filters},output:item.evidence,duration_ms:Date.now()-started});
      }
      return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};
    }catch(error){
      await journalP3Tool({run_id:args.run_id,floor:'P1',tool_name:'sales_observe_many',input:args,status:'FAILED',error_code:error?.code||error?.name||'ERROR',output:{error:{code:error?.code||error?.name||'ERROR',message:error?.message??String(error)}},duration_ms:Date.now()-started}).catch(()=>{});
      throw error;
    }
  });


  server.registerTool('sales_observe_windows',{
    title:'Observe certified SALES across PRICING windows',
    description:'P1 SALES observations using a complete same-run PRICING evidence_id. Pass the original brand-wide evidence once: every model/version/window is processed without copying the payload or model loops. No data_fetch is needed. Loads SALES once; existing LAST recognition is reused per distinct observed end, before version/date selection. INTERSECTION is the default for questions bounded to the requested period: VIN and days use the PRICING intersection only. Explicit FULL_EPISODE preserves full closed windows. Explicit cutoff bounds open/future windows. Partial/open episodes have a bounded observation, never an invented episode end. Then execute p2.pricing_window_sales with pricing and sales evidence ids for certified VIN/day and deterministic previous-window acceleration/deceleration. Its scope must match the SALES evidence. Temporal overlap does not attribute sales to a commercial condition.',
    inputSchema:{run_id:z.string().min(1),pricing_evidence_id:z.string().min(1),cutoff:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      metrics_scope:z.enum(['FULL_EPISODE','INTERSECTION']).default('INTERSECTION'),
      commercial_universe:z.enum(['COMPANY','OWN_STORES','DEALERS']).default('COMPANY')},
    outputSchema:{evidence_id:z.string(),evidence_contract:z.string(),evidence_version:z.string(),
      authority:z.literal('P1_CERTIFIED'),source:z.literal('SALES'),status:z.string(),operation:z.string(),
      measure:z.object({}).catchall(z.any()),universe:z.object({}).catchall(z.any()),temporal:z.object({}).catchall(z.any()),
      payload:z.object({}).catchall(z.any()),execution:z.object({}).catchall(z.any()),lineage:z.object({}).catchall(z.any())},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{
    const out=await traced(args.run_id,'P1','sales_observe_windows',args,async()=>{
      const {pricing}=await resolveP1EvidenceRefs(args.run_id,{pricing:args.pricing_evidence_id});
      return observeSalesWindows({...args,pricing});
    });
    // Existing evidence-reference resolver reads individually journaled data_observe events.
    await Promise.all(out.payload.windows.filter(w=>w.evidence).map(w=>journalP3Tool({run_id:args.run_id,floor:'P1',
      tool_name:'data_observe',input:{source:'SALES',measure:'VIN_SALES',filters:w.evidence.lineage.source_filters},output:w.evidence})));
    await journalP3Tool({run_id:args.run_id,floor:'P1',tool_name:'data_observe',input:args,output:out});
    return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};
  });

  server.registerTool('p2_discover',{
    title:'Discover certified CIDEF analytical transformations',
    description:'Piso 2 discovery. Returns the active semantic pool of certified analytical transformations. It does not rank, route, interpret the user question, or recommend a next action.',
    inputSchema:{run_id:z.string().min(1)},
    outputSchema:{protocol:z.string(),units:z.array(z.object({}).catchall(z.any()))},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await traced(args.run_id,'P2','p2_discover',args,()=>discoverP2Units());return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};});

  server.registerTool('p2_describe',{
    title:'Describe one certified CIDEF analytical transformation',
    description:'Returns the public semantic and deterministic contract for a P2 unit. It does not evaluate relevance to the current question.',
    inputSchema:{run_id:z.string().min(1),unit_id:z.string().min(1),contract_version:z.string().optional()},
    outputSchema:{unit_id:z.string(),contract_version:z.string(),status:z.string(),semantic_contract:z.object({}).catchall(z.any()),deterministic_contract:z.object({}).catchall(z.any()),executor:z.object({}).catchall(z.any())},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await traced(args.run_id,'P2','p2_describe',args,()=>describeP2Unit(args.unit_id,args.contract_version??null));return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};});

  server.registerTool('p2_execute',{
    title:'Execute one certified CIDEF analytical transformation',
    description:'Executes a P2 unit selected by the model against P1-certified evidence references produced by P1 within the same run. Pass each evidence slot as its evidence_id; the backend resolves the original certified P1 object, validates it, and never requires the model to copy evidence payloads.',
    inputSchema:{run_id:z.string().min(1),unit_id:z.string().min(1),contract_version:z.string().optional(),evidence:z.object({}).catchall(z.string().min(1).describe('P1 evidence_id produced by data_observe in this same run')),parameters:z.object({}).catchall(z.any()).default({})},
    outputSchema:{status:z.string(),result:z.object({}).catchall(z.any()).optional(),limitations:z.array(z.string()).optional(),lineage:z.object({}).catchall(z.any()).optional(),error:z.object({}).catchall(z.any()).optional()},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await traced(args.run_id,'P2','p2_execute',args,async()=>{const resolvedEvidence=await resolveP1EvidenceRefs(args.run_id,args.evidence);return executeP2({...args,evidence:resolvedEvidence});});return {structuredContent:out,content:[{type:'text',text:JSON.stringify(out)}]};});


  server.registerTool('run_trace',{
    title:'Read one P1/P2/P3 run trace',
    description:'Returns one run and its ordered P1/P2 tool events. Historical child runs remain readable for backward-compatible auditing.',
    inputSchema:{run_id:z.string().min(1)},
    outputSchema:{run:z.object({}).catchall(z.any()).nullable(),children:z.array(z.object({}).catchall(z.any())).optional(),events:z.array(z.object({}).catchall(z.any())).optional()},
    annotations:{readOnlyHint:true,openWorldHint:false,destructiveHint:false}
  },async(args)=>{const out=await getP3Run(args.run_id);const result=out??{run:null,events:[]};return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};});

  return server;
}
