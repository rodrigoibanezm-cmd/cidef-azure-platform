import { assertP1, finite, invalid } from '../validation.js';

function assertContract(e,slot,expected){assertP1(e,slot);if(e.evidence_contract!==expected)throw invalid('INVALID_EVIDENCE',slot+' must use '+expected);}
function dayOfPeriod(cutoff){const m=/^\d{4}-\d{2}-(\d{2})$/.exec(String(cutoff||''));if(!m)throw invalid('INVALID_PARAMETERS','cutoff must use YYYY-MM-DD');return Number(m[1]);}
function quantile(values,p){const xs=[...values].sort((a,b)=>a-b);if(!xs.length)return null;const pos=(xs.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos);return lo===hi?xs[lo]:xs[lo]*(hi-pos)+xs[hi]*(pos-lo);}

export function executeTargetAttainmentProbability({evidence={},parameters={}}={}){
 const observed=evidence.observed_to_cutoff,target=evidence.target,history=evidence.model_history;
 assertContract(observed,'observed_to_cutoff','p1.cumulative_period_observation');
 assertContract(target,'target','p1.reference_observation');
 assertContract(history,'model_history','p1.historical_period_series');
 if(observed.measure?.id!=='VIN_SALES'||observed.measure?.unit!=='VIN'||target.measure?.id!=='VIN_TARGET'||target.measure?.unit!=='VIN'||history.measure?.id!=='VIN_SALES')throw invalid('INCOMPATIBLE_EVIDENCE','VIN sales observation, VIN target and VIN sales history are required');
 if(observed.universe?.commercial_universe!=='OWN_STORES'||target.universe?.commercial_universe!=='OWN_STORES'||history.universe?.commercial_universe!=='OWN_STORES')throw invalid('UNSUPPORTED_GRAIN','OWN_STORES evidence is required');
 const period=observed.temporal?.period_identity,cutoff=String(parameters.cutoff??observed.temporal?.cutoff??'');
 if(!period||target.temporal?.period_identity!==period||history.temporal?.target_period!==period)throw invalid('INCOMPATIBLE_EVIDENCE','Observed, target and history must refer to the same target period');
 const store=String(observed.dimensions?.store_id??'');if(!store||String(target.dimensions?.store_id??'')!==store||String(history.dimensions?.store_id??'')!==store)throw invalid('INCOMPATIBLE_EVIDENCE','Observed, target and history must refer to the same store');
 if(history.temporal?.closure!=='CLOSED_PERIODS_ONLY')throw invalid('INVARIANT_VIOLATION','Closed historical periods are required');
 const observedValue=observed.payload?.observed_value,targetValue=target.payload?.value;finite(observedValue,'observed value');finite(targetValue,'target value');
 if(targetValue<0||observedValue<0)throw invalid('INVARIANT_VIOLATION','Values must be non-negative');
 const day=dayOfPeriod(cutoff),rows=(history.payload?.periods??[]).filter(r=>Number(r.day_of_period)===day&&Number(r.actual_close)>0);
 const scenarios=[];
 for(const row of rows){finite(row.observed_to_cutoff,'historical observed_to_cutoff');finite(row.actual_close,'historical actual_close');const completion=row.observed_to_cutoff/row.actual_close;if(completion>0&&Number.isFinite(completion))scenarios.push({period_identity:row.period_identity,completion,implied_close:observedValue/completion});}
 if(!scenarios.length)throw invalid('INVARIANT_VIOLATION','No evaluable historical completion scenarios at cutoff day');
 const closes=scenarios.map(x=>x.implied_close),hits=closes.filter(x=>x>=targetValue).length;
 return {store_id:store,cutoff,observed_value:observedValue,target_value:targetValue,attainment_probability:hits/scenarios.length,attainment_probability_percent:100*hits/scenarios.length,scenario_count:scenarios.length,implied_close_distribution:{p10:quantile(closes,.1),p50:quantile(closes,.5),p90:quantile(closes,.9),min:Math.min(...closes),max:Math.max(...closes)},method:{id:'EMPIRICAL_HISTORICAL_COMPLETION_SCENARIOS',day_of_period:day,definition:'Each closed historical completion ratio at the same day implies one target-month close scenario; probability is the empirical share of scenarios meeting or exceeding the official target.'},coverage:{first_period:scenarios.map(x=>x.period_identity).sort()[0]??null,last_period:scenarios.map(x=>x.period_identity).sort().at(-1)??null}};
}
