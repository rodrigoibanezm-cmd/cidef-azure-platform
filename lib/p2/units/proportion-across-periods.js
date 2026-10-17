import { assertP1, finite, invalid } from '../validation.js';

function eq(a,b){return JSON.stringify(a??null)===JSON.stringify(b??null);}
function dimensionsAreSubset(part,universe){
  const p=part?.dimensions??{},u=universe?.dimensions??{};
  return Object.entries(u).every(([k,v])=>eq(p[k],v));
}
function periodIndex(period){
  const m=/^(\d{4})-(\d{2})$/.exec(String(period||''));
  if(!m)throw invalid('INVALID_EVIDENCE','period_identity must use YYYY-MM');
  const month=Number(m[2]);if(month<1||month>12)throw invalid('INVALID_EVIDENCE','period_identity has invalid month');
  return Number(m[1])*12+month-1;
}
function seriesMap(e,label){
  assertP1(e,label);
  if(e.evidence_contract!=='p1.period_observation_series')throw invalid('INVALID_EVIDENCE',label+' must use p1.period_observation_series');
  const rows=e.payload?.observations;
  if(!Array.isArray(rows)||rows.length<1)throw invalid('INVARIANT_VIOLATION',label+' requires at least one observation');
  const map=new Map();
  for(const row of rows){
    const period=String(row?.period_identity??'');periodIndex(period);finite(row?.value,label+' observation value');
    if(map.has(period))throw invalid('INVARIANT_VIOLATION','Duplicate period in '+label,{period_identity:period});
    map.set(period,row.value);
  }
  return map;
}
export function executeProportionAcrossPeriods({evidence={}}={}){
  const part=evidence.part_series,universe=evidence.universe_series;
  assertP1(part,'part_series');assertP1(universe,'universe_series');
  if(!eq(part.measure,universe.measure))throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible measure');
  if(!eq(part.grain,universe.grain))throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible grain');
  if(!eq(part.universe,universe.universe))throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible universe');
  if(!eq(part.temporal,universe.temporal))throw invalid('INCOMPATIBLE_EVIDENCE','Incompatible temporal scope');
  if(!dimensionsAreSubset(part,universe))throw invalid('INCOMPATIBLE_EVIDENCE','Universe dimensions must be a subset of part dimensions');

  const p=seriesMap(part,'part_series'),u=seriesMap(universe,'universe_series');
  const pp=[...p.keys()].sort((a,b)=>periodIndex(a)-periodIndex(b));
  const up=[...u.keys()].sort((a,b)=>periodIndex(a)-periodIndex(b));
  if(!eq(pp,up))throw invalid('INCOMPATIBLE_EVIDENCE','Part and universe series must contain the same periods');

  const observations=[],gaps=[];
  for(let i=0;i<pp.length;i++){
    const period=pp[i],partValue=p.get(period),universeValue=u.get(period);
    if(partValue<0||universeValue<0)throw invalid('INVARIANT_VIOLATION','Values must be non-negative',{period_identity:period});
    if(partValue>universeValue)throw invalid('INVARIANT_VIOLATION','Part value cannot exceed universe value',{period_identity:period});
    if(i>0){
      const distance=periodIndex(period)-periodIndex(pp[i-1]);
      if(distance>1)gaps.push({after_period:pp[i-1],before_period:period,missing_periods:distance-1});
    }
    const zero=universeValue===0,ratio=zero?null:partValue/universeValue;
    observations.push({period_identity:period,part_value:partValue,universe_value:universeValue,ratio,percentage:ratio==null?null:ratio*100,ratio_status:zero?'ZERO_UNIVERSE':'CALCULATED'});
  }
  return {observations,coverage:{observation_count:observations.length,first_period:pp[0],last_period:pp.at(-1),gap_count:gaps.length,gaps}};
}
