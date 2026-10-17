import { assertP1, finite, invalid } from '../validation.js';
function prep(e,slot){
  assertP1(e,slot);
  if(!e.coverage) throw invalid('INVALID_EVIDENCE',slot+' requires coverage');
  const dim=e?.payload?.dimension;if(!dim?.id||!dim.identity_contract||!dim.identity_version)throw invalid('INVALID_EVIDENCE',slot+' requires canonical dimension identity');
  const rows=e?.payload?.members;if(!Array.isArray(rows))throw invalid('INVALID_EVIDENCE',slot+' members must be an array');
  const m=new Map();for(const r of rows){if(r?.member_id==null)throw invalid('INVALID_EVIDENCE','member_id is required');finite(r.value,'member value');const k=String(r.member_id);if(m.has(k))throw invalid('INVARIANT_VIOLATION','Duplicate member_id: '+k);m.set(k,{id:r.member_id,label:r.member_label??null,value:r.value});}
  return {dim,m};
}
export function executeReconciledDimensionDelta({evidence={},parameters={}}={}){
  const policy=parameters.missing_member_policy??'ZERO_FILL';if(policy!=='ZERO_FILL')throw invalid('INVALID_PARAMETERS','Only ZERO_FILL is supported');
  const a=prep(evidence.baseline_by_member,'baseline_by_member'),b=prep(evidence.comparison_by_member,'comparison_by_member');
  for(const [x,label] of [['measure','measure'],['grain','grain'],['universe','universe']]) if(JSON.stringify(evidence.baseline_by_member?.[x]??null)!==JSON.stringify(evidence.comparison_by_member?.[x]??null))throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible '+label);
  if(a.dim.id!==b.dim.id||a.dim.identity_contract!==b.dim.identity_contract||a.dim.identity_version!==b.dim.identity_version)throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible dimension identity');
  if((a.dim.unresolved_member_policy??null)!==(b.dim.unresolved_member_policy??null))throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible unresolved member policy');
  const ids=[...new Set([...a.m.keys(),...b.m.keys()])].sort();let at=0,bt=0;
  const members=ids.map(k=>{const av=a.m.get(k)?.value??0,bv=b.m.get(k)?.value??0;at+=av;bt+=bv;const am=a.m.get(k),bm=b.m.get(k);return {member_id:am?.id??bm.id,member_label:am?.label??bm?.label??null,baseline_value:av,comparison_value:bv,delta:bv-av};});
  const td=bt-at,cs=members.reduce((s,r)=>s+r.delta,0),diff=cs-td;
  if(diff!==0)throw invalid('INVARIANT_VIOLATION','Dimension delta does not reconcile',{component_delta_sum:cs,total_delta:td,difference:diff});
  for(const r of members)r.contribution_to_total_delta=td===0?null:r.delta/td;
  return {baseline_total:at,comparison_total:bt,total_delta:td,members,reconciliation:{component_delta_sum:cs,total_delta:td,difference:diff,status:'RECONCILED'},coverage:{baseline:evidence.baseline_by_member.coverage,comparison:evidence.comparison_by_member.coverage}};
}
