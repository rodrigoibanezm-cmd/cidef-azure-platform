import { assertP1, finite, invalid } from '../validation.js';
function value(e){const v=e?.payload?.value;finite(v,'payload.value');return v;}
function compatible(a,b){
  assertP1(a,'baseline');assertP1(b,'comparison');
  for(const [x,label] of [['measure','measure'],['grain','grain'],['universe','universe']]) if(JSON.stringify(a?.[x]??null)!==JSON.stringify(b?.[x]??null)) throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible '+label);
  if(JSON.stringify(a?.dimensions??{})!==JSON.stringify(b?.dimensions??{})) throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible dimensions');
}
export function executeObservedPairDelta({evidence={}}={}){
  const a=evidence.baseline,b=evidence.comparison;compatible(a,b);
  const av=value(a),bv=value(b),d=bv-av;
  return {baseline_value:av,comparison_value:bv,absolute_delta:d,relative_delta:av===0?null:d/av,relative_delta_status:av===0?'ZERO_BASELINE':'CALCULATED',direction:d>0?'INCREASE':d<0?'DECREASE':'UNCHANGED'};
}
