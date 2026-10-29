import { randomUUID } from 'node:crypto';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';
import { observeDataSource, fetchDataSource } from '../lib/data-floor/registry.js';
import { executeP2 } from '../lib/p2/execute.js';
import { journalP3Tool } from '../lib/p3/executionJournal.js';

const OPENINGS = [{ id: 'COMPANY', brand_id: null }, { id: 'FOTON', brand_id: '89' }, { id: 'DONGFENG', brand_id: '71' }];
const DIMENSIONS = ['STORE', 'SELLER', 'DEALER_GROUP', 'MODEL'];
const UNIVERSE = { STORE: 'OWN_STORES', SELLER: 'OWN_STORES', DEALER_GROUP: 'DEALERS', MODEL: 'COMPANY' };
const endOf = m => { const [y, n] = m.split('-').map(Number); return new Date(Date.UTC(y, n, 0)).toISOString().slice(0, 10); };
const shift = (m, n) => { const [y, k] = m.split('-').map(Number); return new Date(Date.UTC(y, k - 1 + n, 1)).toISOString().slice(0, 7); };
const months = (a, b) => { const out = []; for (let m = a; m <= b; m = shift(m, 1)) out.push(m); return out; };
const slot = m => 'history_' + m.replace('-', '_');
const numeric = id => /^\d+$/.test(String(id));
const inputFilter = (opening, universe) => ({
  commercial_universe: universe, ...(opening.brand_id == null ? {} : { brand_id: opening.brand_id }),
});
function checkPeriod(period, now = new Date()) {
  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)
    || period < '2021-01' || period >= now.toISOString().slice(0, 7)) throw new Error('CLOSED_PERIOD_REQUIRED');
}
function unitFor(opening, dimension) {
  return opening.brand_id != null ? 'p2.closed_period_brand_performance'
    : dimension === 'STORE' ? 'p2.closed_period_store_performance' : 'p2.closed_period_sales_performance';
}
export async function buildMonthlyCloseSales(period, {
  observe = (input) => observeDataSource('SALES', input),
  fetch = (input) => fetchDataSource('SALES', input),
  execute = executeP2,
  journal = journalP3Tool,
  run_id = 'monthly-close-sales-' + randomUUID(),
} = {}) {
  checkPeriod(period);
  const result = { domain:'SALES', period, cutoff:endOf(period), run_id,
    generated_at:new Date().toISOString(), openings:[] };
  async function observed(input) {
    const started = Date.now();
    let evidence;
    try {
      evidence = await observe(input);
      if (evidence?.status !== 'CERTIFIED' || evidence?.authority !== 'P1_CERTIFIED' || !evidence.evidence_id)
        throw new Error('P1_EVIDENCE_NOT_CERTIFIED');
      await journal({run_id,floor:'P1',tool_name:'data_observe',
        input:{run_id,source:'SALES',...input},output:evidence,duration_ms:Date.now()-started});
      return evidence;
    } catch (error) {
      await journal({run_id,floor:'P1',tool_name:'data_observe',
        input:{run_id,source:'SALES',...input},output:{error:error.message},
        status:'FAILED',error_code:error.code??'ERROR',duration_ms:Date.now()-started}).catch(()=>{});
      throw error;
    }
  }
  async function classified(unit_id, evidence, parameters) {
    const started = Date.now();
    const refs = Object.fromEntries(Object.entries(evidence).map(([key, e])=>[key,e.evidence_id]));
    const output = await execute({run_id,unit_id,contract_version:'0.1.0',evidence,parameters});
    await journal({run_id,floor:'P2',tool_name:'p2_execute',
      input:{run_id,unit_id,contract_version:'0.1.0',evidence:refs,parameters},
      output,duration_ms:Date.now()-started});
    if (output.status !== 'EXECUTED' || !['IMPROVING','STABLE','DETERIORATING','UNKNOWN'].includes(output.result?.state))
      throw new Error('P2_NOT_EXECUTED: '+unit_id+' '+JSON.stringify(output.error??{}));
    return { ...output.result, p2:{unit_id,contract_version:'0.1.0',lineage:output.lineage} };
  }
  for (const opening of OPENINGS) {
    const dimensions = {};
    for (const dimension of DIMENSIONS) {
      const filters = inputFilter(opening, UNIVERSE[dimension]);
      const evidence = {}, ids = new Set();
      if (dimension === 'DEALER_GROUP') {
        // SALES P1 has no DEALER_GROUP dimensional dataset: its certified FETCH
        // supplies canonical IDs, never labels or inferred memberships.
        const identified = await fetch({fields:['dealer_group_id'],filters:{
          ...filters,date_from:'2021-01-01',date_to:endOf(period)}});
        if (identified?.source !== 'SALES' || identified?.operation !== 'FETCH'
          || identified?.version !== '0.13' || !Array.isArray(identified.rows))
          throw new Error('P1_DEALER_IDS_NOT_CERTIFIED');
        for (const row of identified.rows) if (numeric(row.dealer_group_id)) ids.add(String(row.dealer_group_id));
        await journal({run_id,floor:'P1',tool_name:'data_fetch',
          input:{run_id,source:'SALES',fields:['dealer_group_id'],filters:{...filters,date_from:'2021-01-01',date_to:endOf(period)}},
          output:{source:'SALES',version:identified.version,operation:'FETCH',
            canonical_ids:[...ids].sort((a,b)=>Number(a)-Number(b)),size:identified.size}});
      } else {
        for (const m of months('2021-01',period)) {
          const e = await observed({measure:'VIN_SALES',evidence_shape:'DIMENSIONAL_QUANTITATIVE_DATASET',
            period:m,cutoff:endOf(m),dimension,filters});
          evidence[slot(m)] = e;
          for (const member of e.payload?.members??[]) if (numeric(member.member_id)) ids.add(String(member.member_id));
        }
      }
      const members = [];
      for (const member_id of [...ids].sort((a,b)=>Number(a)-Number(b))) {
        let original = evidence;
        if (dimension === 'DEALER_GROUP') {
          const from = shift(period,-12), to = period;
          const series = await observed({measure:'VIN_SALES',evidence_shape:'PERIOD_OBSERVATION_SERIES',
            period_from:from,period_to:to,filters:{...filters,dealer_group_id:member_id}});
          original = {'series_'+from.replace('-','_')+'_'+to.replace('-','_'):series};
        }
        const unit_id = unitFor(opening,dimension);
        const parameters = dimension === 'STORE' && opening.brand_id == null
          ? {cutoff_month:period,store_id:member_id}
          : {...(opening.brand_id == null ? {} : {brand_id:opening.brand_id}),cutoff_month:period,
            dimension,member_id};
        members.push(await classified(unit_id,original,parameters));
      }
      dimensions[dimension] = {member_count:members.length,members,
        identity_source:dimension==='DEALER_GROUP'?'SALES_P1_FETCH':'SALES_P1_DIMENSIONAL_HISTORY'};
    }
    result.openings.push({id:opening.id,brand_id:opening.brand_id,dimensions});
  }
  return result;
}
export async function publishMonthlyCloseSales(period, {
  pool = getAzurePool(), build = buildMonthlyCloseSales,
} = {}) {
  checkPeriod(period);
  const existing = await pool.query('SELECT period, run_id FROM public.monthly_close_sales_snapshots WHERE period=$1',[period]);
  if (existing.rows.length) return {status:'ALREADY_PUBLISHED',period,run_id:existing.rows[0].run_id};
  const payload = await build(period);
  if (payload?.period !== period || !payload.run_id || payload.openings?.length !== 3)
    throw new Error('INCOMPLETE_SALES_PAYLOAD');
  const written = await pool.query(
    'INSERT INTO public.monthly_close_sales_snapshots(period,payload,run_id,generated_at) VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(period) DO NOTHING RETURNING period,run_id',
    [period,JSON.stringify(payload),payload.run_id,payload.generated_at]);
  if (!written.rows.length) return {status:'ALREADY_PUBLISHED',period};
  return {status:'PUBLISHED',period,run_id:payload.run_id};
}
