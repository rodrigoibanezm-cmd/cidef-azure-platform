import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
function adapter(path,name,bindings={}) {
  const full=source(path);
  const at=full.indexOf('export async function '+name+'(');
  assert.ok(at>=0,name+' must exist');
  const code=full.slice(at).replace('export async function '+name,'async function '+name);
  return new Function(...Object.keys(bindings),code+'\nreturn '+name+';')(...Object.values(bindings));
}
const validMonth = x => /^\d{4}-(0[1-9]|1[0-2])$/.test(x);

test('SELL_OUT routes declarative filter and rejects unknown group',async()=>{
  const fn=adapter('lib/data-floor/selloutCertifier.js','resolveSelloutObservation',{
    isoMonth:validMonth,observeSellout:async v=>v
  });
  assert.deepEqual(await fn({measure:'VIN_SELL_OUT',time:{period:'2026-08'},filters:{brand:'FOTON'},group_by:['DEALER_GROUP']}),
    {measure:'VIN_SELL_OUT',period:'2026-08',filters:{brand:'FOTON'},dimension:'DEALER_GROUP',evidence_shape:'DIMENSIONAL_QUANTITATIVE_DATASET'});
  await assert.rejects(fn({measure:'VIN_SELL_OUT',time:{period:'2026-08'},group_by:['WRONG']}),/UNSUPPORTED_SELL_OUT_DECLARATIVE_GROUP_BY/);
});
test('TARGETS routes store-specific reference and rejects invalid month',async()=>{
  const fn=adapter('lib/data-floor/targetsCertifier.js','resolveTargetsObservation',{
    observeTargetsEvidence:async v=>v
  });
  assert.deepEqual(await fn({measure:'VIN_TARGET',time:{period:'2026-08'},filters:{store_id:4}}),
    {measure:'VIN_TARGET',evidence_shape:'REFERENCE_OBSERVATION',period:'2026-08',filters:{store_id:4}});
  await assert.rejects(fn({measure:'VIN_TARGET',time:{period:'2026-13'},filters:{store_id:4}}),/INVALID_TARGET_MONTH/);
});
test('PRICING preserves full commercial-condition window contract',async()=>{
  const fn=adapter('lib/data-floor/pricingCertifier.js','resolvePricingObservation',{
    SHAPE:'COMMERCIAL_CONDITION_WINDOWS',
    DIMENSIONS:['BRAND','MODEL','VERSION','MODEL_VERSION'],
    observePricingEvidence:async v=>v
  });
  assert.deepEqual(await fn({measure:'PRICE_EPISODES',time:{period:'2026-08'},filters:{brand_id:89},group_by:['MODEL_VERSION']}),
    {measure:'PRICE_EPISODES',evidence_shape:'COMMERCIAL_CONDITION_WINDOWS',filters:{brand_id:89},period:'2026-08',dimension:'MODEL_VERSION'});
  await assert.rejects(fn({measure:'PRICE_EPISODES',time:{period:'2026-08',cutoff:'2026-08-31'}}),/UNSUPPORTED_PRICING_DECLARATIVE_TIME/);
});
test('INVENTORY SQL pushdown retains source coverage and bind parameters',async()=>{
  const full=source('lib/data-floor/inventoryCertifier.js');
  const snippet=full.slice(full.indexOf('const FILTER_COLUMNS ='),full.indexOf('\nexport function describeInventory()'));
  const calls=[],queryDb=async (sql,params=[])=>{
    calls.push({sql,params});
    return sql.includes('count(*)::bigint')?[{n:'100',missing:'7'}]:
      [{vin:'VIN-1',marca_raw:'FOTON',esta_reservado:false}];
  };
  const values=x=>Array.isArray(x)?x:[x];
  const bool=x=>x===true||String(x??'').trim().toLowerCase()==='true';
  const norm=x=>x==null?null:String(x).trim().toUpperCase();
  const match=(r,key,v)=>values(v).some(x=>key==='reserved'
    ? bool(x)===bool(r.esta_reservado):norm(x)===norm(r.marca_raw));
  const {dataset,quality}=new Function('normalize','values','bool','norm','queryDb','match',
    snippet+'\nreturn {dataset,quality};')(
    ({filters})=>({filters}),values,bool,norm,queryDb,match
  );
  const result=await dataset({filters:{brand:'FOTON',reserved:false}});
  assert.equal(result.filtered.length,1);
  assert.equal(result.base.length,100);
  assert.equal(quality(result.base).coverage.stock_entry_date.missing_n,7);
  assert.deepEqual(calls[1].params,[['FOTON'],[false]]);
  assert.match(calls[1].sql,/WHERE vigente = true AND/);
  assert.doesNotMatch(calls[1].sql,/FOTON/);
});

test('INVENTORY declarative observation counts distinct current VIN and refuses history',async()=>{
  const sourceText=source('lib/data-floor/inventoryCertifier.js');
  assert.match(sourceText,/resolveInventoryObservation/);
  const fn=adapter('lib/data-floor/inventoryCertifier.js','resolveInventoryObservation',{
    dataset:async()=>({q:{filters:{brand:'FOTON'}},base:{length:100,missingStockEntry:2},
      filtered:[{vin:'A'},{vin:'A'},{vin:'B'}]}),
    field:(row,key)=>row[key],
    quality:base=>({source_n:base.length}),
    createHash:()=>({update(){return this;},digest(){return '123456789abcdef01234567890';}}),
    CERTIFIER_VERSION:'0.2',DATA_SOURCE:'INVENTORY'
  });
  const out=await fn({measure:'VIN_STOCK',filters:{brand:'FOTON'}});
  assert.equal(out.payload.value,2);
  assert.equal(out.coverage.source_n,100);
  assert.equal(out.status,'CERTIFIED');
  await assert.rejects(fn({measure:'VIN_STOCK',time:{period:'2026-08'}}),
    /INVENTORY_HISTORICAL_SNAPSHOT_NOT_AVAILABLE/);
});
