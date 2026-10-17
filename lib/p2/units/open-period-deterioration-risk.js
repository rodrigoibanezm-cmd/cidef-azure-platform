import { assertP1, finite, invalid } from '../validation.js';

const RULE=Object.freeze({baseline:'moving_average_12',deviation:'historical_percentile',persistence:'deepening_2'});
function assertContract(e,slot,expected){assertP1(e,slot);if(e.evidence_contract!==expected)throw invalid('INVALID_EVIDENCE',slot+' must use '+expected);}
function median(xs){const a=[...xs].sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function percentileRank(values,value){if(!values.length)return null;let below=0,equal=0;for(const x of values){if(x<value)below++;else if(x===value)equal++;}return (below+0.5*equal)/values.length;}
function day(cutoff){const m=/^\d{4}-\d{2}-(\d{2})$/.exec(String(cutoff||''));if(!m)throw invalid('INVALID_EVIDENCE','invalid cutoff');return Number(m[1]);}
function monthShift(period,delta){const m=/^(\d{4})-(\d{2})$/.exec(String(period||''));if(!m)return null;const d=new Date(Date.UTC(+m[1],+m[2]-1+delta,1));return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
function closes(history){
 const by=new Map();
 for(const r of history.payload?.periods??[]){if(!r?.period_identity||!Number.isFinite(Number(r.actual_close)))continue;const prior=by.get(r.period_identity);if(!prior||Number(r.day_of_period)>Number(prior.day_of_period))by.set(r.period_identity,r);}
 return [...by.values()].sort((a,b)=>a.period_identity.localeCompare(b.period_identity));
}
function formalRows(monthly){
 const out=[],errors=[];
 for(let i=0;i<monthly.length;i++){
  if(i<12)continue;
  const window=monthly.slice(i-12,i);
  if(window.length!==12)continue;
  const contiguous=window.every((r,j)=>j===0||monthShift(window[j-1].period_identity,1)===r.period_identity)&&monthShift(window.at(-1).period_identity,1)===monthly[i].period_identity;
  if(!contiguous)continue;
  const baseline=window.reduce((s,r)=>s+Number(r.actual_close),0)/12;
  const error=Number(monthly[i].actual_close)-baseline;
  const pct=errors.length>=3?percentileRank(errors,error):null;
  out.push({month:monthly[i].period_identity,sales:Number(monthly[i].actual_close),baseline,error,historical_percentile:pct,adverse:pct==null?null:pct<0.5});
  errors.push(error);
 }
 return out;
}
function activeEpisode(rows){
 let active=false,prev=null;
 for(const r of rows){
  if(prev&&monthShift(prev.month,1)!==r.month)active=false;
  if(r.adverse===true){
   if(!active&&prev?.adverse===true&&r.error<prev.error)active=true;
  }else active=false;
  prev=r;
 }
 return active;
}
function quantile(values,p){const a=[...values].sort((x,y)=>x-y);if(!a.length)return null;const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos);return lo===hi?a[lo]:a[lo]*(hi-pos)+a[hi]*(pos-lo);}
function currentForClose(monthly,period,close){const rows=formalRows([...monthly,{period_identity:period,actual_close:close}]);return rows.find(x=>x.month===period)??null;}
function firstNonAdverseIntegerClose(monthly,period,observedValue){
 const baseline=monthly.slice(-12).reduce((s,r)=>s+Number(r.actual_close),0)/12;
 const historicalErrors=formalRows(monthly).map(r=>r.error);
 if(historicalErrors.length<3)return null;
 let close=Math.ceil(observedValue);
 const max=Math.ceil(Math.max(observedValue,baseline+Math.max(...historicalErrors)+2));
 while(close<=max){const row=currentForClose(monthly,period,close);if(row?.adverse===false)return close;close++;}
 return null;
}
export function executeOpenPeriodDeteriorationRisk({evidence={},parameters={}}={}){
 const observed=evidence.observed_to_cutoff,history=evidence.model_history;
 assertContract(observed,'observed_to_cutoff','p1.cumulative_period_observation');assertContract(history,'model_history','p1.historical_period_series');
 if(observed.measure?.id!=='VIN_SALES'||history.measure?.id!=='VIN_SALES')throw invalid('INCOMPATIBLE_EVIDENCE','VIN_SALES required');
 if(observed.universe?.commercial_universe!=='OWN_STORES'||history.universe?.commercial_universe!=='OWN_STORES')throw invalid('UNSUPPORTED_GRAIN','OWN_STORES required');
 const store=String(observed.dimensions?.store_id??'');if(!store||String(history.dimensions?.store_id??'')!==store)throw invalid('INCOMPATIBLE_EVIDENCE','same store required');
 const period=observed.temporal?.period_identity;if(!period||history.temporal?.target_period!==period)throw invalid('INCOMPATIBLE_EVIDENCE','same target period required');
 if(history.temporal?.closure!=='CLOSED_PERIODS_ONLY')throw invalid('INVARIANT_VIOLATION','closed historical periods required');
 const cutoff=String(parameters.cutoff??observed.temporal?.cutoff??'');if(parameters.cutoff&&parameters.cutoff!==observed.temporal?.cutoff)throw invalid('INCOMPATIBLE_EVIDENCE','cutoff differs from observed evidence');
 const observedValue=Number(observed.payload?.observed_value);finite(observedValue,'observed value');const cutoffDay=day(cutoff);
 const monthly=closes(history);if(monthly.length<16)throw invalid('INSUFFICIENT_EVIDENCE','at least 16 closed monthly observations required');
 const formalHistory=formalRows(monthly);const prior=formalHistory.at(-1)??null;
 const completionRows=(history.payload?.periods??[]).filter(r=>Number(r.day_of_period)===cutoffDay&&Number(r.actual_close)>0&&Number.isFinite(Number(r.observed_to_cutoff)));
 const scenarios=completionRows.map(r=>({period_identity:r.period_identity,completion:Number(r.observed_to_cutoff)/Number(r.actual_close)})).filter(r=>r.completion>0).map(r=>{
   const close=observedValue/r.completion;const scenarioMonthly=[...monthly,{period_identity:period,actual_close:close}];const rows=formalRows(scenarioMonthly);const current=rows.find(x=>x.month===period)??null;
   return {...r,implied_close:close,current,ends_deteriorating:current?activeEpisode(rows):null};
 }).filter(r=>r.current&&r.current.historical_percentile!=null);
 if(!scenarios.length)throw invalid('INSUFFICIENT_EVIDENCE','no evaluable historical completion scenarios');
 const risk=scenarios.filter(x=>x.ends_deteriorating===true).length/scenarios.length;
 const adverseScenarios=scenarios.filter(x=>x.current.adverse===true);
 const adverseRisk=adverseScenarios.length/scenarios.length;
 const closesOut=scenarios.map(x=>x.implied_close);
 const triggering=scenarios.filter(x=>x.ends_deteriorating===true).map(x=>x.implied_close);
 const adverseCloses=adverseScenarios.map(x=>x.implied_close);
 const nonAdverseThreshold=firstNonAdverseIntegerClose(monthly,period,observedValue);
 const observedAsClose=currentForClose(monthly,period,observedValue);
 return {
  status:'EVALUABLE',cutoff,observed_value:observedValue,rule:RULE,
  prior_closed_state:{period:prior?.month??null,adverse:prior?.adverse??null,active_episode:activeEpisode(formalHistory),error:prior?.error??null,historical_percentile:prior?.historical_percentile??null},
  open_period_adverse_signal:{
   observed_as_close:{close:observedValue,baseline:observedAsClose?.baseline??null,error:observedAsClose?.error??null,historical_percentile:observedAsClose?.historical_percentile??null,adverse:observedAsClose?.adverse??null},
   adverse_risk_probability:adverseRisk,adverse_risk_percent:adverseRisk*100,adverse_scenarios:adverseScenarios.length,
   adverse_close_range:adverseCloses.length?{min:Math.min(...adverseCloses),max:Math.max(...adverseCloses)}:null,
   first_integer_close_not_adverse:nonAdverseThreshold,
   additional_vin_required_from_observed_to_not_adverse:nonAdverseThreshold==null?null:Math.max(0,nonAdverseThreshold-observedValue)
  },
  deterioration_risk_probability:risk,deterioration_risk_percent:risk*100,scenario_count:scenarios.length,deteriorating_scenarios:triggering.length,
  implied_close_distribution:{min:Math.min(...closesOut),p10:quantile(closesOut,.1),p50:median(closesOut),p90:quantile(closesOut,.9),max:Math.max(...closesOut)},
  deterioration_close_range:triggering.length?{min:Math.min(...triggering),max:Math.max(...triggering)}:null,
  method:'EMPIRICAL_SAME_DAY_COMPLETION_SCENARIOS_EVALUATED_UNDER_CERTIFIED_DETERIORATION_RULE',
  coverage:{closed_months:monthly.length,formal_history_rows:formalHistory.length,completion_scenarios:scenarios.length,history_start_month:history.temporal?.history_start_month??null,history_end_month:history.temporal?.history_end_month??null},
  limitations:['The adverse signal describes whether the open period would close ADVERSE under the certified deviation rule; it is not itself DETERIORATING.','This is risk of ending the open period in DETERIORATING status, not a current-month closed status.','Historical same-day completion scenarios are empirical, not a parametric probability model.']
 };
}
