import assert from 'node:assert/strict';
import test from 'node:test';
import { executeOpenPeriodDeteriorationRisk } from '../lib/p2/units/open-period-deterioration-risk.js';

const env=(contract,extra)=>({evidence_id:'e.'+Math.random(),evidence_contract:contract,evidence_version:'0.1.0',authority:'P1_CERTIFIED',lineage:{test:true},...extra});
function history(){
 const periods=[];
 for(let y=2024,m=1,i=0;i<32;i++){const period=y+'-'+String(m).padStart(2,'0');const close=i<12?20:(i<20?18:12);for(const d of [10,20,29])periods.push({period_identity:period,day_of_period:d,observed_to_cutoff:close*(d===10?.3:d===20?.65:.95),actual_close:close});m++;if(m===13){m=1;y++;}}
 return env('p1.historical_period_series',{measure:{id:'VIN_SALES'},universe:{commercial_universe:'OWN_STORES'},dimensions:{store_id:'8'},temporal:{target_period:'2026-09',closure:'CLOSED_PERIODS_ONLY',history_start_month:'2024-01',history_end_month:'2026-08'},payload:{periods}});
}
test('open-period deterioration risk evaluates empirical closes under fixed certified rule',()=>{
 const observed=env('p1.cumulative_period_observation',{measure:{id:'VIN_SALES'},universe:{commercial_universe:'OWN_STORES'},dimensions:{store_id:'8'},temporal:{period_identity:'2026-09',cutoff:'2026-09-29'},payload:{observed_value:10}});
 const result=executeOpenPeriodDeteriorationRisk({evidence:{observed_to_cutoff:observed,model_history:history()}});
 assert.equal(result.rule.baseline,'moving_average_12');
 assert.equal(result.rule.deviation,'historical_percentile');
 assert.equal(result.rule.persistence,'deepening_2');
 assert.equal(result.scenario_count>0,true);
 assert.equal(result.deterioration_risk_probability>=0&&result.deterioration_risk_probability<=1,true);
 assert.equal(result.open_period_adverse_signal.adverse_risk_probability>=0&&result.open_period_adverse_signal.adverse_risk_probability<=1,true);
 assert.equal(Number.isFinite(result.open_period_adverse_signal.first_integer_close_not_adverse),true);
 assert.equal(result.method,'EMPIRICAL_SAME_DAY_COMPLETION_SCENARIOS_EVALUATED_UNDER_CERTIFIED_DETERIORATION_RULE');
});
test('open-period deterioration risk rejects cross-store evidence',()=>{
 const observed=env('p1.cumulative_period_observation',{measure:{id:'VIN_SALES'},universe:{commercial_universe:'OWN_STORES'},dimensions:{store_id:'7'},temporal:{period_identity:'2026-09',cutoff:'2026-09-29'},payload:{observed_value:10}});
 assert.throws(()=>executeOpenPeriodDeteriorationRisk({evidence:{observed_to_cutoff:observed,model_history:history()}}),/same store required/);
});
