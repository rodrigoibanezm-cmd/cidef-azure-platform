import { assertP1, invalid } from '../validation.js';

function snapshot(e,slot){
  assertP1(e,slot);
  if(e.evidence_contract!=='P1_OPERATION_STATE_SNAPSHOT') throw invalid('INVALID_EVIDENCE',slot+' must be P1_OPERATION_STATE_SNAPSHOT');
  if(e.source!=='FORUM'||e.measure?.id!=='OPERATION_STATES') throw invalid('INVALID_EVIDENCE',slot+' must contain FORUM OPERATION_STATES');
  const rows=e.payload?.operations;
  if(!Array.isArray(rows)) throw invalid('INVALID_EVIDENCE',slot+' operations missing');
  const map=new Map();
  for(const r of rows){
    const id=String(r?.operation_number||'');
    if(!id||!r?.state) throw invalid('INVALID_EVIDENCE',slot+' contains operation without identity/state');
    if(map.has(id)) throw invalid('INVALID_EVIDENCE',slot+' contains duplicate operation '+id);
    map.set(id,r);
  }
  return map;
}
function same(a,b){return JSON.stringify(a??null)===JSON.stringify(b??null);}
export function executeForumSnapshotTransitions({evidence={}}={}){
  const baseline=evidence.baseline,comparison=evidence.comparison;
  const a=snapshot(baseline,'baseline'),b=snapshot(comparison,'comparison');
  const from=baseline.temporal?.snapshot_date,to=comparison.temporal?.snapshot_date;
  if(!from||!to||to<=from) throw invalid('INCOMPATIBLE_EVIDENCE','comparison snapshot must be later than baseline snapshot');
  if(!same(baseline.universe,comparison.universe)) throw invalid('INCOMPATIBLE_EVIDENCE','Forum snapshots must share the same certified universe filters');
  const counts=new Map(),matched=[],breakdowns={network:new Map(),brand:new Map()};
  let unchanged=0,changed=0;
  const bump=(map,member,fromState,toState)=>{const m=member??'UNRESOLVED',key=m+'\u0000'+fromState+'\u0000'+toState;map.set(key,(map.get(key)||0)+1);};
  for(const [id,left] of a){
    const right=b.get(id); if(!right)continue;
    const key=left.state+'\u0000'+right.state;
    counts.set(key,(counts.get(key)||0)+1);
    if(left.state===right.state)unchanged++;else changed++;
    bump(breakdowns.network,left.network,left.state,right.state);
    bump(breakdowns.brand,left.brand,left.state,right.state);
    matched.push(id);
  }
  const transitions=[...counts.entries()].map(([key,count])=>{const [from_state,to_state]=key.split('\u0000');return {from_state,to_state,count,changed:from_state!==to_state};}).sort((x,y)=>y.count-x.count||x.from_state.localeCompare(y.from_state)||x.to_state.localeCompare(y.to_state));
  const breakdown=(map)=>[...map.entries()].map(([key,count])=>{const [member,from_state,to_state]=key.split('\u0000');return {member,from_state,to_state,count,changed:from_state!==to_state};}).sort((x,y)=>x.member.localeCompare(y.member)||y.count-x.count||x.from_state.localeCompare(y.from_state)||x.to_state.localeCompare(y.to_state));
  const entrants=[...b.keys()].filter(id=>!a.has(id));
  const missing=[...a.keys()].filter(id=>!b.has(id));
  const elapsed_days=Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);
  return {baseline_snapshot:from,comparison_snapshot:to,elapsed_days,totals:{baseline_operations:a.size,comparison_operations:b.size,matched_operations:matched.length,changed_operations:changed,unchanged_operations:unchanged,new_operations:entrants.length,missing_operations:missing.length},transitions,breakdowns:{network:breakdown(breakdowns.network),brand:breakdown(breakdowns.brand)},coverage:{matched_ratio_of_baseline:a.size?matched.length/a.size:null,matched_ratio_of_comparison:b.size?matched.length/b.size:null,new_operation_ids:entrants,missing_operation_ids:missing},method:'Exact numero_operacion join between two certified DAILY COTIZACION snapshots; only operations observed in both snapshots produce state transitions.'};
}
