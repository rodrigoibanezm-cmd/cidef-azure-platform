import { assertP1, invalid } from '../validation.js';

function members(e,slot){
  assertP1(e,slot);
  if(e?.evidence_contract!=='P1_DIMENSIONAL_QUANTITATIVE_DATASET') throw invalid('INVALID_EVIDENCE',slot+' must be dimensional P1 evidence');
  return new Map((e?.payload?.members||[]).map(x=>[x.member_id,{label:x.member_label,value:Number(x.value||0)}]));
}
function same(a,b){return JSON.stringify(a??null)===JSON.stringify(b??null);}
export function executeForumFunnelPerformance({evidence={}}={}){
  const slots=['converted','approved','expired','rejected'];
  for(const s of slots) assertP1(evidence[s],s);
  const base=evidence.converted;
  for(const s of slots.slice(1)){
    const e=evidence[s];
    if(!same(base.dimensions,e.dimensions)||!same(base.temporal,e.temporal)||!same(base.universe,e.universe)||e.grain!==base.grain) throw invalid('INCOMPATIBLE_EVIDENCE','Forum cohort evidence must share dimension, temporal cohort, universe and grain');
  }
  const maps=Object.fromEntries(slots.map(s=>[s,members(evidence[s],s)]));
  const ids=[...new Set(slots.flatMap(s=>[...maps[s].keys()]))].sort();
  const rows=ids.map(id=>{
    const converted=maps.converted.get(id)?.value||0,approved=maps.approved.get(id)?.value||0,expired=maps.expired.get(id)?.value||0,rejected=maps.rejected.get(id)?.value||0;
    const evaluated=converted+approved+expired+rejected,notConverted=approved+expired+rejected;
    return {member_id:id,member_label:maps.converted.get(id)?.label||maps.approved.get(id)?.label||maps.expired.get(id)?.label||maps.rejected.get(id)?.label||id,converted,approved,expired,rejected,evaluated,not_converted:notConverted,conversion_rate:evaluated?converted/evaluated:null,conversion_percent:evaluated?100*converted/evaluated:null,non_conversion_mix:evaluated?{approved:approved/evaluated,expired:expired/evaluated,rejected:rejected/evaluated}:null};
  }).sort((a,b)=>b.evaluated-a.evaluated||String(a.member_label).localeCompare(String(b.member_label)));
  const t=rows.reduce((a,r)=>({converted:a.converted+r.converted,approved:a.approved+r.approved,expired:a.expired+r.expired,rejected:a.rejected+r.rejected}),{converted:0,approved:0,expired:0,rejected:0});
  const evaluated=t.converted+t.approved+t.expired+t.rejected;
  return {dimension:base.dimensions.group_by,cohort:base.temporal,totals:{...t,evaluated,not_converted:t.approved+t.expired+t.rejected,conversion_rate:evaluated?t.converted/evaluated:null,conversion_percent:evaluated?100*t.converted/evaluated:null},members:rows,method:'CURSADA / (CURSADA + APROBADA_NOT_CURSED + SOLICITUD_CADUCADA_NOT_CURSED + RECHAZADA_NOT_CURSED)',coverage:{members:rows.length,excluded_statuses:'All current statuses outside the four declared outcome buckets are excluded from denominator.'}};
}
