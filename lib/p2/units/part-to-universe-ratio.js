import { assertP1, finite, invalid } from '../validation.js';

function value(e,label){
  const v=e?.payload?.value;
  finite(v,label+'.payload.value');
  return v;
}
function eq(a,b){return JSON.stringify(a??null)===JSON.stringify(b??null);}
function dimensionsAreSubset(part,universe){
  const p=part?.dimensions??{},u=universe?.dimensions??{};
  return Object.entries(u).every(([k,v])=>eq(p[k],v));
}
function compatible(part,universe){
  assertP1(part,'part');assertP1(universe,'universe');
  if(!eq(part.measure,universe.measure)) throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible measure');
  if(!eq(part.grain,universe.grain)) throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible grain');
  if(!eq(part.temporal,universe.temporal)) throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible temporal scope');
  if(!eq(part.universe,universe.universe)) throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible universe');
  if(!dimensionsAreSubset(part,universe)) throw invalid('INCOMPATIBLE_EVIDENCE','Universe dimensions must be a subset of part dimensions');
}
export function executePartToUniverseRatio({evidence={}}={}){
  const part=evidence.part,universe=evidence.universe;
  compatible(part,universe);
  const partValue=value(part,'part'),universeValue=value(universe,'universe');
  if(partValue<0||universeValue<0) throw invalid('INVARIANT_VIOLATION','Values must be non-negative');
  if(universeValue===0) return {part_value:partValue,universe_value:universeValue,ratio:null,percentage:null,ratio_status:'ZERO_UNIVERSE'};
  if(partValue>universeValue) throw invalid('INVARIANT_VIOLATION','Part value cannot exceed universe value');
  const ratio=partValue/universeValue;
  return {part_value:partValue,universe_value:universeValue,ratio,percentage:ratio*100,ratio_status:'CALCULATED'};
}
