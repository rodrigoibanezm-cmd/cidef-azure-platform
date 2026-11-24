// Read-only parity gate: sample real P1-certified VIN scopes and compare every
// recognized fact against SQL-first. No writes, deployment, or cross-run cache.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getSalesRunFactSet } from '../lib/data-floor/sales/preparation.js';
import { field } from '../lib/data-floor/sales/dataset.js';
import { FIELDS } from '../lib/data-floor/sales/contract.js';
import { planSalesCandidates } from './semantic-sales-prototype.mjs';

process.env.SALES_SQL_FIRST_ENABLED = 'false';
const today = new Date();
const monthOf = offset => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
};
const months = [monthOf(-1), monthOf(-3)];
const dateTo = period => new Date(Date.UTC(Number(period.slice(0,4)),
  Number(period.slice(5,7)),0)).toISOString().slice(0,10);
const safeId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : null;
const projection = row => Object.fromEntries(['source_id',...FIELDS]
  .map(key => [key,key === 'source_id' ? row.source_id : field(row,key)]));
const sortedRows = rows => rows.map(projection).sort((a,b) =>
  JSON.stringify(a).localeCompare(JSON.stringify(b)));
const run = 'sales-parity-' + randomUUID();
const results=[];
let failures=0;
for(const period of months) for(const universe of ['OWN_STORES','DEALERS']){
  const cutoff=dateTo(period);
  const baseFilters={commercial_universe:universe,date_from:period+'-01',date_to:cutoff};
  const {factSet:full}=await getSalesRunFactSet(run,{commercial_universe:universe,cutoff_date:cutoff});
  const records=full.select(baseFilters).facts;
  const grouped=new Map();
  for(const row of records){
    const brand_id=safeId(field(row,'brand_id')),model_id=safeId(field(row,'model_id'));
    if(!brand_id||!model_id)continue;
    const key=brand_id+':'+model_id;
    if(!grouped.has(key))grouped.set(key,{brand_id,model_id,rows:[]});
    grouped.get(key).rows.push(row);
  }
  // Select both common and rare model identities from the certified universe.
  const groups=[...grouped.values()].sort((a,b)=>b.rows.length-a.rows.length);
  const sampled=[...groups.slice(0,3),...groups.slice(-2)]
    .filter((group,index,array)=>array.findIndex(other=>
      other.brand_id===group.brand_id&&other.model_id===group.model_id)===index);
  const cases=[];
  for(const group of sampled){
    const base={...baseFilters,brand_id:group.brand_id,model_id:group.model_id};
    cases.push(base);
    const row=group.rows.find(item=>safeId(field(item,
      universe==='OWN_STORES'?'store_id':'dealer_id')));
    if(row){
      const key=universe==='OWN_STORES'?'store_id':'dealer_id';
      cases.push({...base,[key]:safeId(field(row,key))});
    }
    const seller=group.rows.find(item=>safeId(field(item,'seller_id')));
    if(seller)cases.push({...base,seller_id:safeId(field(seller,'seller_id'))});
  }
  for(const filters of cases){
    if(!planSalesCandidates(filters,cutoff))throw new Error('UNPLANNED_TEST_SCOPE');
    const expected=sortedRows(full.select(filters).facts);
    const started=performance.now();
    const {factSet:partial}=await getSalesRunFactSet(run,{
      commercial_universe:universe,cutoff_date:cutoff,
      candidate_filters:filters,diagnostic_sql_first:true,
    });
    const actual=sortedRows(partial.select(filters).facts);
    const equal=JSON.stringify(expected)===JSON.stringify(actual);
    const check={period,universe,filters,count_full:expected.length,
      count_sql_first:actual.length,records_equal:equal,
      source_scope:partial.ref.source_scope,elapsed_ms:Math.round(performance.now()-started)};
    results.push(check);
    if(!equal||partial.ref.source_scope!=='PARTIAL_SOURCE'){
      failures++;
      console.error(JSON.stringify({status:'MISMATCH',...check,
        missing:expected.filter(row=>!actual.some(x=>JSON.stringify(x)===JSON.stringify(row))).slice(0,5),
        extra:actual.filter(row=>!expected.some(x=>JSON.stringify(x)===JSON.stringify(row))).slice(0,5)}));
    }
  }
}
assert.ok(results.length>0,'No SQL-first compatible scopes were sampled');
const report={status:failures===0?'PASS':'FAIL',checked:results.length,
  failed:failures,monthly_universes:months.length*2,
  cases:results.map(({period,universe,filters,count_full,count_sql_first,records_equal})=>
    ({period,universe,filter_fields:Object.keys(filters),count_full,count_sql_first,records_equal})),
  note:'Read-only sampled parity; passing does not prove universal completeness.'};
console.log(JSON.stringify(report));
if(failures)process.exitCode=1;
