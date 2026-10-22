// Presentation projection of P1 FETCH rows. No recognition, alias resolution,
// credit-note handling or commercial-universe rules are implemented here.
import { DEALER_IDENTITY_JOINS, DEALER_GROUP_SQL } from '../data-floor/forum/query.js';
export const CONTRACT = 'forum.ventas.snapshot.v1';
export const NETWORKS = ['OWN_STORES', 'DEALERS'];
export function monthEnd(period) { return new Date(Date.UTC(+period.slice(0,4),+period.slice(5,7),0)).toISOString().slice(0,10); }
const norm = x => String(x ?? '').trim().toUpperCase();
const blank = () => ({ foton:0,dongfeng:0,otros:0,total:0,foton_ufis:0,dongfeng_ufis:0,otros_ufis:0,total_ufis:0,penetration:null,foton_penetration:null,dongfeng_penetration:null,otros_penetration:null });
export function projectSales(facts, network, catalogs) {
  const rows = new Map(), entities = new Map(), totals = blank();
  const unresolved = [];
  for (const fact of facts) {
    const id = network === 'OWN_STORES' ? fact.store_id : fact.dealer_group_id;
    const label = network === 'OWN_STORES' ? fact.store_label : catalogs.groups[String(id)];
    const key = id == null ? 'UNRESOLVED' : String(id);
    if (id == null || !label || (network === 'DEALERS' && fact.dealer_id == null)) unresolved.push(fact.vin);
    if (!rows.has(key)) rows.set(key,{ sucursal_id:key,sucursal:label || (id == null ? 'SIN RESOLVER' : 'ID '+id+' · SIN ETIQUETA'),...blank() });
    const row = rows.get(key);
    const brand = norm(catalogs.brands[String(fact.brand_id)]);
    // Labels are canonical master labels, never raw aliases.
    const column = brand === 'FOTON' ? 'foton' : brand === 'DONGFENG' ? 'dongfeng' : 'otros';
    const entity = norm(fact.financial_entity) || 'UNRESOLVED';
    entities.set(entity,(entities.get(entity)||0)+1);
    for (const target of [row,totals]) {
      target[column]++; target.total++;
      if (entity === 'FORUM') { target[column+'_ufis']++; target.total_ufis++; }
    }
  }
  const missing = entities.get('UNRESOLVED') || 0;
  return { rows:[...rows.values()].sort((a,b)=>b.total-a.total||a.sucursal.localeCompare(b.sucursal)),totals,
    financing:{ with_financing:facts.length-missing,without_financing:null,unresolved:missing,
      with_financing_share:null,without_financing_share:null,
      entities:[...entities].map(([entity,vins])=>({entity:entity==='UNRESOLVED'?'SIN INFORMACIÓN':entity,vins,share:null})) },
    unresolved_vins:unresolved,
    limitations:['PENETRATION_NOT_CERTIFIED: no compatible P1 quantitative financial subset for existing P2 contract','Blank financial entity is UNRESOLVED, not evidence of cash payment','UFIs in SALES table mean exact FORUM entity on recognized SALES VIN; FORUM event UFIS are separate'],
  };
}
export function assertFacts(result) {
  if(result.source!=='SALES'||result.dataset!=='SALES_WORK'||result.grain!=='RECOGNIZED_SALE'||!Array.isArray(result.rows)||result.rows.length!==result.size?.filtered_n) throw new Error('INVALID_SALES_P1_FETCH');
  const vins=result.rows.map(x=>x.vin).filter(Boolean);
  if(new Set(vins).size!==vins.length) throw new Error('DUPLICATE_P1_VIN');
}
export function assertParity(facts, observation) {
  if(observation.authority!=='P1_CERTIFIED'||observation.payload?.value!==facts.length) throw new Error('P1_TOTAL_PARITY_FAILED');
}
export function selectionsForEnd(year,endMonth) {
  const out=[];
  for(let mask=1<<(endMonth-1);mask<(1<<endMonth);mask++) {
    out.push(Array.from({length:endMonth},(_,i)=>i+1).filter(i=>mask&(1<<(i-1))).map(i=>year+'-'+String(i).padStart(2,'0')));
  }
  return out;
}

// Reuse the very same identity joins as FORUM P1 DISTRIBUTOR. No aliases or
// channel rules are inferred here; unmapped labels remain explicit.
export async function loadDealerIdentities(client) {
  const { rows } = await client.query(`SELECT distribuidor AS raw,
    coalesce(forum_dealer_group.dealer_group_id,forum_dealer_direct.dealer_group_id)::text AS dealer_group_id,
    ${DEALER_GROUP_SQL} AS dealer_label
    FROM (SELECT DISTINCT distribuidor FROM forum_funnel_universe_v01) labels ${DEALER_IDENTITY_JOINS}`);
  return new Map(rows.map(r=>[r.raw,r]));
}

export function projectDealerUfis(work,period,cutoff,identities) {
  if(work?.source!=='FORUM'||work.dataset!=='FORUM_FUNNEL_WORK'||work.grain!=='FORUM_OPERATION'||!Array.isArray(work.rows)||work.rows.length!==work.size?.filtered_n)throw new Error('INVALID_FORUM_P1_FETCH');
  const operations=new Set(),cells=new Map();
  for(const fact of work.rows){
    if(fact.operation_number==null||operations.has(String(fact.operation_number)))throw new Error('DUPLICATE_OR_MISSING_FORUM_OPERATION');
    operations.add(String(fact.operation_number));
    if(fact.network!=='DEALERS')throw new Error('FORUM_NETWORK_MISMATCH');
    if(fact.has_curse_evidence!==true)throw new Error('FORUM_CURSE_EVIDENCE_REQUIRED');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(fact.curse_date||''))throw new Error('INVALID_FORUM_CURSE_DATE');
    if(typeof fact.ufi_curse!=='number'||!Number.isSafeInteger(fact.ufi_curse)||fact.ufi_curse<0)throw new Error('INVALID_FORUM_UFI_UNITS');
    if(!fact.curse_date.startsWith(period+'-')||fact.curse_date>cutoff||fact.ufi_curse===0)continue;
    const identity=identities.get(fact.distributor);
    if(!identity)throw new Error('FORUM_IDENTITY_CATALOG_INCOMPLETE');
    const dealer_key=identity.dealer_group_id??'UNRESOLVED:'+String(fact.distributor);
    const brand_id=fact.brand_id==null?'UNRESOLVED':String(fact.brand_id);
    const key=JSON.stringify([dealer_key,brand_id]);
    if(!cells.has(key))cells.set(key,{dealer_key,dealer_group_id:identity.dealer_group_id,dealer_label:identity.dealer_label,brand_id,brand_label:fact.brand||'UNRESOLVED',ufis:0});
    cells.get(key).ufis+=fact.ufi_curse;
  }
  const members=[...cells.values()].sort((a,b)=>a.dealer_key.localeCompare(b.dealer_key)||a.brand_id.localeCompare(b.brand_id));
  return {period,cutoff,source:'FORUM',source_dataset:work.dataset,source_version:work.version,measure:'FORUM_P1_UFIS',unit:'VEHICLE_UNIT',rule:'CURSE_VEHICLE_UNITS_BY_FECHA_CURSE',identity_contract:'dealer_group_v01',members,total:members.reduce((sum,m)=>sum+m.ufis,0)};
}

export function assertDealerUfiParity(breakdown,observation) {
  if(breakdown.total!==observation?.value)throw new Error('FORUM_FETCH_TOTAL_PARITY_FAILED');
  for(const [dimension,key] of [['BRAND','brand_label'],['DISTRIBUTOR','dealer_label']]){
    const actual=new Map();
    for(const m of breakdown.members)actual.set(m[key],(actual.get(m[key])||0)+m.ufis);
    const evidence=observation.dimensions?.[dimension];
    if(evidence?.authority!=='P1_CERTIFIED'||!evidence.coverage?.complete)throw new Error('FORUM_DIMENSION_NOT_CERTIFIED');
    const expected=new Map(evidence.payload.members.map(m=>[m.member_label,m.value]));
    if(actual.size!==expected.size||[...expected].some(([label,value])=>actual.get(label)!==value))throw new Error('FORUM_FETCH_'+dimension+'_PARITY_FAILED');
  }
}
