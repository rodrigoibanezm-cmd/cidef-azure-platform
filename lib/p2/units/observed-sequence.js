import { assertP1, finite, invalid } from '../validation.js';

function periodIndex(period){
  const m=/^(\d{4})-(\d{2})$/.exec(String(period||''));
  if(!m)throw invalid('INVALID_EVIDENCE','period_identity must use YYYY-MM');
  const month=Number(m[2]);if(month<1||month>12)throw invalid('INVALID_EVIDENCE','period_identity has invalid month');
  return Number(m[1])*12+month-1;
}
export function executeObservedSequence({evidence={}}={}){
  const series=evidence.sequence;
  assertP1(series,'sequence');
  if(series.evidence_contract!=='p1.period_observation_series')throw invalid('INVALID_EVIDENCE','sequence must use p1.period_observation_series');
  const input=series.payload?.observations;
  if(!Array.isArray(input)||input.length<2)throw invalid('INVARIANT_VIOLATION','E02 requires at least two observations');
  const seen=new Set();
  const observations=input.map(row=>{
    const period=String(row?.period_identity??'');const index=periodIndex(period);finite(row?.value,'sequence observation value');
    if(seen.has(period))throw invalid('INVARIANT_VIOLATION','Duplicate period in sequence',{period_identity:period});
    seen.add(period);return {period_identity:period,value:row.value,index};
  }).sort((a,b)=>a.index-b.index);
  const movements=[],gaps=[];
  for(let i=1;i<observations.length;i++){
    const previous=observations[i-1],current=observations[i],distance=current.index-previous.index;
    if(distance<=0)throw invalid('INVARIANT_VIOLATION','Sequence periods are not uniquely orderable');
    if(distance>1)gaps.push({after_period:previous.period_identity,before_period:current.period_identity,missing_periods:distance-1});
    const absolute=current.value-previous.value;
    movements.push({from_period:previous.period_identity,to_period:current.period_identity,from_value:previous.value,to_value:current.value,absolute_delta:absolute,relative_delta:previous.value===0?null:absolute/previous.value,relative_delta_status:previous.value===0?'ZERO_BASELINE':'CALCULATED',direction:absolute>0?'UP':absolute<0?'DOWN':'FLAT'});
  }
  return {
    observations:observations.map(({index,...row})=>row),
    movements,
    coverage:{observation_count:observations.length,first_period:observations[0].period_identity,last_period:observations.at(-1).period_identity,gap_count:gaps.length,gaps},
  };
}
