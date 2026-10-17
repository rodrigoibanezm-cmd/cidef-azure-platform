import { assertP1, finite, invalid } from '../validation.js';

function assertContract(e,slot,expected){assertP1(e,slot);if(e.evidence_contract!==expected)throw invalid('INVALID_EVIDENCE',slot+' must use '+expected);}
function median(values){const xs=[...values].sort((a,b)=>a-b);if(!xs.length)return null;const p=(xs.length-1)/2,lo=Math.floor(p),hi=Math.ceil(p);return lo===hi?xs[lo]:(xs[lo]+xs[hi])/2;}
function dayOfPeriod(cutoff){const m=/^\d{4}-\d{2}-(\d{2})$/.exec(String(cutoff||''));if(!m)throw invalid('INVALID_PARAMETERS','cutoff must use YYYY-MM-DD');return Number(m[1]);}

export function executeReconciledSellerTargetContribution({evidence={}}={}){
 const observed=evidence.seller_observed_to_cutoff,history=evidence.seller_history,target=evidence.store_target,completionHistory=evidence.store_completion_history;
 assertContract(observed,'seller_observed_to_cutoff','p1.dimensional_quantitative_dataset');
 assertContract(history,'seller_history','p1.seller_contribution_history');
 assertContract(target,'store_target','p1.reference_observation');
 assertContract(completionHistory,'store_completion_history','p1.historical_period_series');
 const period=observed.temporal?.period_identity,cutoff=observed.temporal?.cutoff;
 const store=String(observed.dimensions?.store_id??'');
 if(!period||!cutoff||!store)throw invalid('INVALID_EVIDENCE','Observed seller dataset requires period, cutoff and store_id');
 if(String(history.dimensions?.store_id??'')!==store||String(target.dimensions?.store_id??'')!==store||String(completionHistory.dimensions?.store_id??'')!==store)throw invalid('INCOMPATIBLE_EVIDENCE','All evidence must refer to the same store');
 if(history.temporal?.target_period!==period||target.temporal?.period_identity!==period||completionHistory.temporal?.target_period!==period)throw invalid('INCOMPATIBLE_EVIDENCE','All evidence must refer to the same target period');
 if(observed.payload?.dimension?.id!=='SELLER')throw invalid('INVALID_EVIDENCE','Observed dataset must use SELLER dimension');
 const targetValue=target.payload?.value;finite(targetValue,'store target');
 const histRows=history.payload?.sellers??[];if(!histRows.length)throw invalid('INVARIANT_VIOLATION','No evaluable active sellers with five-month history');
 const rawWeights=histRows.map(row=>{const shares=row.months.map(m=>m.store_sales>0?m.seller_sales/m.store_sales:null).filter(Number.isFinite);if(shares.length!==5)throw invalid('INVARIANT_VIOLATION','Each seller requires exactly five closed comparable months',{seller_id:row.seller_id,months:shares.length});return {...row,raw_weight:shares.reduce((a,b)=>a+b,0)/shares.length};});
 const weightSum=rawWeights.reduce((s,x)=>s+x.raw_weight,0);if(!(weightSum>0))throw invalid('INVARIANT_VIOLATION','Seller historical weights do not sum to a positive value');
 const observedMap=new Map((observed.payload?.members??[]).map(x=>[String(x.member_id),Number(x.value)]));
 const day=dayOfPeriod(cutoff),completionRows=(completionHistory.payload?.periods??[]).filter(r=>Number(r.day_of_period)===day&&Number(r.actual_close)>0);
 const completions=completionRows.map(r=>Number(r.observed_to_cutoff)/Number(r.actual_close)).filter(x=>Number.isFinite(x)&&x>0);const learnedCompletion=median(completions);
 if(!(learnedCompletion>0))throw invalid('INVARIANT_VIOLATION','Store completion is not evaluable at cutoff day');
 const sellers=rawWeights.map(row=>{const weight=row.raw_weight/weightSum,objective=targetValue*weight,expected=objective*learnedCompletion,actual=observedMap.get(String(row.seller_id))??0;return {seller_id:String(row.seller_id),seller_label:row.seller_label??null,weight,weight_percent:100*weight,target_contribution:objective,expected_to_cutoff:expected,observed_to_cutoff:actual,attainment_ratio:expected>0?actual/expected:null,attainment_percent:expected>0?100*actual/expected:null,gap_to_expected:actual-expected,history_months:row.months.map(x=>x.period_identity)};}).sort((a,b)=>a.gap_to_expected-b.gap_to_expected);
 const expectedTotal=sellers.reduce((s,x)=>s+x.expected_to_cutoff,0),objectiveTotal=sellers.reduce((s,x)=>s+x.target_contribution,0);
 return {store_id:store,period_identity:period,cutoff,store_target:targetValue,learned_completion:learnedCompletion,expected_store_progress_to_cutoff:targetValue*learnedCompletion,sellers,reconciliation:{weight_sum:sellers.reduce((s,x)=>s+x.weight,0),target_contribution_sum:objectiveTotal,expected_to_cutoff_sum:expectedTotal,target_reconciled:Math.abs(objectiveTotal-targetValue)<1e-9,cutoff_expectation_reconciled:Math.abs(expectedTotal-targetValue*learnedCompletion)<1e-9},method:{seller_weight:'MEAN_SHARE_OF_STORE_LAST_5_CLOSED_MONTHS_NORMALIZED_ACROSS_ACTIVE_EVALUABLE_SELLERS',cutoff_progress:'MEDIAN_HISTORICAL_STORE_COMPLETION_SAME_DAY'}};
}
