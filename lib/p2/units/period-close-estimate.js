import { assertP1, finite, invalid } from '../validation.js';

const HISTORY_POLICY=Object.freeze({id:'E06_V0_1_HISTORY',start_month:'2021-01'});

function assertContract(e,slot,expected){assertP1(e,slot);if(e.evidence_contract!==expected)throw invalid('INVALID_EVIDENCE',slot+' must use '+expected);}
function median(values){const xs=[...values].sort((a,b)=>a-b);if(!xs.length)return null;const p=(xs.length-1)*0.5,lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?xs[lo]:xs[lo]*(hi-p)+xs[hi]*(p-lo);}
function dayOfPeriod(cutoff){const m=/^\d{4}-\d{2}-(\d{2})$/.exec(String(cutoff||''));if(!m)throw invalid('INVALID_PARAMETERS','cutoff must use YYYY-MM-DD');return Number(m[1]);}
export function executePeriodCloseEstimate({evidence={},parameters={}}={}){
 const observed=evidence.observed_to_cutoff,calendar=evidence.period_calendar,history=evidence.model_history;
 assertContract(observed,'observed_to_cutoff','p1.cumulative_period_observation');assertContract(calendar,'period_calendar','p1.period_calendar');assertContract(history,'model_history','p1.historical_period_series');
 const cutoff=String(parameters.cutoff??observed.temporal?.cutoff??'');
 if(parameters.cutoff&&parameters.cutoff!==observed.temporal?.cutoff)throw invalid('INCOMPATIBLE_EVIDENCE','parameter cutoff differs from observed cutoff');
 const period=observed.temporal?.period_identity;
 if(!period||calendar.temporal?.period_identity!==period)throw invalid('INCOMPATIBLE_EVIDENCE','Observed and calendar period identities differ');
 if(history.temporal?.target_period!==period)throw invalid('INCOMPATIBLE_EVIDENCE','History target period differs from observed period');
 if(history.temporal?.closure!=='CLOSED_PERIODS_ONLY')throw invalid('INVARIANT_VIOLATION','E06 v0.1 requires closed historical periods only');
 if(history.temporal?.history_policy!==HISTORY_POLICY.id||history.temporal?.history_start_month!==HISTORY_POLICY.start_month)throw invalid('INCOMPATIBLE_EVIDENCE','History does not satisfy E06 v0.1 model policy',{required_history_policy:HISTORY_POLICY.id,required_start_month:HISTORY_POLICY.start_month});
 if(!Array.isArray(calendar.payload?.eligible_observation_days)||!calendar.payload.eligible_observation_days.includes(cutoff))throw invalid('INVARIANT_VIOLATION','cutoff does not belong to certified period calendar');
 const universe=observed.universe?.commercial_universe;
 if(universe!=='OWN_STORES')throw invalid('UNSUPPORTED_GRAIN','E06 v0.1 supports OWN_STORES only');
 if(history.universe?.commercial_universe!==universe)throw invalid('INCOMPATIBLE_EVIDENCE','Observed and history universes differ');
 if(observed.measure?.id!=='VIN_SALES'||history.measure?.id!=='VIN_SALES'||observed.measure?.unit!=='VIN'||history.measure?.unit!=='VIN')throw invalid('INCOMPATIBLE_EVIDENCE','E06 v0.1 requires VIN_SALES in VIN');
 const observedValue=observed.payload?.observed_value;finite(observedValue,'observed_to_cutoff.payload.observed_value');const day=dayOfPeriod(cutoff);
 const rows=(history.payload?.periods??[]).filter(r=>Number(r.day_of_period)===day),completions=[],months=[];
 for(const row of rows){finite(row.observed_to_cutoff,'model_history observed_to_cutoff');finite(row.actual_close,'model_history actual_close');if(row.actual_close<=0)continue;const v=row.observed_to_cutoff/row.actual_close;if(Number.isFinite(v)){completions.push(v);months.push(row.period_identity);}}
 const learned=median(completions);if(!(learned>0))throw invalid('INVARIANT_VIOLATION','Historical completion is not evaluable at cutoff day',{day_of_period:day,training_observations:completions.length});
 const estimated=observedValue/learned;if(!Number.isFinite(estimated))throw invalid('INVARIANT_VIOLATION','Estimated close is not finite');const unique=[...new Set(months)].sort();
 return {observed_value:observedValue,cutoff,estimated_close:estimated,model_components:{model:'MEDIAN_HISTORICAL_COMPLETION',day_of_period:day,learned_completion:learned,training_observations:completions.length,training_months:unique.length,training_first_month:unique[0]??null,training_last_month:unique.at(-1)??null},model_assumptions:['Historical completion at the same day of period is informative for the target period.','E06 v0.1 is certified only for OWN_STORES VIN_SALES.','E06 v0.1 history policy uses closed periods from 2021-01 through the month before the target period.'],coverage:{history_start_month:history.temporal?.history_start_month??null,history_end_month:history.temporal?.history_end_month??null,closed_periods_only:history.temporal?.closure==='CLOSED_PERIODS_ONLY'}};
}
