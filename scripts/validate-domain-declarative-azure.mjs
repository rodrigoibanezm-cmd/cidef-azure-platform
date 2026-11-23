// Read-only Azure validation of newly added declarative domain adapters.
import assert from 'node:assert/strict';
import {queryDb} from '../lib/neon.js';
import {observeDataSource,fetchDataSource,resolveDataObservation} from '../lib/data-floor/registry.js';

const direct = (source,input) => observeDataSource(source,input);
const declared = (source,request) => resolveDataObservation(
  'validate-domains-'+source+'-20261123',source,{request},
  {measureExecution:operation=>operation(),onReuse:()=>{}},
);
const report = [];
async function sample(sql) {
  const rows=await queryDb(sql);
  assert.ok(rows.length,'NO_VALIDATION_SAMPLE: '+sql);
  return rows[0];
}
function record(domain,expectation,actual){
  assert.deepEqual(actual,expectation,domain+' EQUIVALENCE_MISMATCH');
  report.push({domain,status:'PASS',value:actual});
}

// SELL_OUT: same SQL-backed precomputed snapshot, with brand filtering.
const sellout=await sample(`SELECT period,brand FROM public.dealer_monthly_sellout_snapshots
  ORDER BY period DESC LIMIT 1`);
const period=String(sellout.period).slice(0,7),brand=String(sellout.brand);
const a=await direct('SELL_OUT',{measure:'VIN_SELL_OUT',period,filters:{brand}});
const b=await declared('SELL_OUT',{measure:'VIN_SELL_OUT',time:{period},filters:{brand}});
record('SELL_OUT',a.payload.value,b.payload.value);
assert.equal(b.authority,'P1_CERTIFIED');

// TARGETS: choose a target that is published, compare official reference.
const target=await sample(`SELECT to_char(mes,'YYYY-MM') AS period,sucursal_id
  FROM ventas_metas_mensuales ORDER BY mes DESC LIMIT 1`);
const month=String(target.period),store_id=String(target.sucursal_id);
const c=await direct('TARGETS',{measure:'VIN_TARGET',evidence_shape:'REFERENCE_OBSERVATION',period:month,filters:{store_id}});
const d=await declared('TARGETS',{measure:'VIN_TARGET',time:{period:month},filters:{store_id}});
record('TARGETS',c.payload.value,d.payload.value);
assert.equal(d.authority,'P1_CERTIFIED');

// PRICING: verify episode IDs and complete canonical commercial windows.
const episode=await sample(`SELECT to_char(vigencia_desde,'YYYY-MM') AS period,price_episode_id
  FROM price_episode_canonico_v01 ORDER BY vigencia_desde DESC LIMIT 1`);
const epMonth=String(episode.period),price_episode_id=String(episode.price_episode_id);
const e=await direct('PRICING',{measure:'PRICE_EPISODES',evidence_shape:'COMMERCIAL_CONDITION_WINDOWS',period:epMonth,filters:{price_episode_id}});
const f=await declared('PRICING',{measure:'PRICE_EPISODES',time:{period:epMonth},filters:{price_episode_id}});
record('PRICING',e.payload.windows.map(x=>x.price_episode_id),f.payload.windows.map(x=>x.price_episode_id));
assert.equal(f.authority,'P1_CERTIFIED');

// INVENTORY: current-only VIN count; compare against the existing FETCH rows.
const stock=await sample(`SELECT vin FROM vehiculo_canonico
  WHERE vigente=true AND vin IS NOT NULL ORDER BY vin LIMIT 1`);
const vin=String(stock.vin), g=await fetchDataSource('INVENTORY',{filters:{vin},fields:['vin']});
const h=await declared('INVENTORY',{measure:'VIN_STOCK',filters:{vin}});
record('INVENTORY',new Set(g.rows.map(x=>String(x.vin).trim().toUpperCase())).size,h.payload.value);
assert.equal(h.authority,'P1_CERTIFIED');
await assert.rejects(declared('INVENTORY',{measure:'VIN_STOCK',time:{period:'2026-08'},filters:{vin}}),
  /INVENTORY_HISTORICAL_SNAPSHOT_NOT_AVAILABLE/);
console.log(JSON.stringify({status:'PASS',results:report}));
