import test from 'node:test';
import assert from 'node:assert/strict';
import { executeP2 } from '../lib/p2/execute.js';
import { discoverP2Units } from '../lib/p2/registry.js';

const base={evidence_version:'0.1.0',authority:'P1_CERTIFIED',status:'CERTIFIED',source:'TEST',operation:'OBSERVE',universe:{commercial_universe:'OWN_STORES'},coverage:{},lineage:{}};
const observed={...base,evidence_id:'o',evidence_contract:'p1.cumulative_period_observation',grain:'FILTERED_SALES_UNIVERSE',measure:{id:'VIN_SALES',unit:'VIN'},dimensions:{store_id:'8'},temporal:{period_identity:'2026-09',cutoff:'2026-09-21'},payload:{observed_value:30}};
const target={...base,evidence_id:'t',evidence_contract:'p1.reference_observation',grain:'STORE_MONTH',measure:{id:'VIN_TARGET',unit:'VIN'},dimensions:{store_id:'8'},temporal:{period_identity:'2026-09'},payload:{value:40,reference_type:'OFFICIAL_TARGET',source:'META'}};
const history={...base,evidence_id:'h',evidence_contract:'p1.historical_period_series',grain:'COMMERCIAL_MONTH_CUTOFF',measure:{id:'VIN_SALES',unit:'VIN'},dimensions:{store_id:'8'},temporal:{target_period:'2026-09',closure:'CLOSED_PERIODS_ONLY'},payload:{periods:[{period_identity:'2026-07',day_of_period:21,observed_to_cutoff:30,actual_close:40},{period_identity:'2026-08',day_of_period:21,observed_to_cutoff:20,actual_close:40}]}};
test('registry exposes target attainment and seller contribution',()=>{const ids=discoverP2Units().units.map(x=>x.unit_id);assert.ok(ids.includes('p2.target_attainment_probability'));assert.ok(ids.includes('p2.reconciled_seller_target_contribution'));});
test('target attainment uses empirical historical completion scenarios',async()=>{const r=await executeP2({run_id:'r',unit_id:'p2.target_attainment_probability',evidence:{observed_to_cutoff:observed,target,model_history:history}});assert.equal(r.status,'EXECUTED');assert.equal(r.result.scenario_count,2);assert.equal(r.result.attainment_probability,1);assert.equal(r.result.implied_close_distribution.min,40);assert.equal(r.result.implied_close_distribution.max,60);});
test('seller target contribution reconciles target and cutoff expectation',async()=>{
 const sellerObserved={...base,evidence_id:'so',evidence_contract:'p1.dimensional_quantitative_dataset',grain:'FILTERED_SALES_UNIVERSE',measure:{id:'VIN_SALES',unit:'VIN'},dimensions:{store_id:'8'},temporal:{period_identity:'2026-09',cutoff:'2026-09-21'},payload:{dimension:{id:'SELLER'},members:[{member_id:'A',value:5},{member_id:'B',value:7}]}};
 const months=['2026-04','2026-05','2026-06','2026-07','2026-08'];
 const sellerHistory={...base,evidence_id:'sh',evidence_contract:'p1.seller_contribution_history',grain:'ACTIVE_SELLER_X_CLOSED_MONTH',measure:{id:'VIN_SALES',unit:'VIN'},dimensions:{store_id:'8'},temporal:{target_period:'2026-09',closure:'CLOSED_PERIODS_ONLY'},payload:{sellers:[{seller_id:'A',seller_label:'A',months:months.map(period_identity=>({period_identity,seller_sales:10,store_sales:40}))},{seller_id:'B',seller_label:'B',months:months.map(period_identity=>({period_identity,seller_sales:30,store_sales:40}))}]}};
 const r=await executeP2({run_id:'r',unit_id:'p2.reconciled_seller_target_contribution',evidence:{seller_observed_to_cutoff:sellerObserved,seller_history:sellerHistory,store_target:target,store_completion_history:history}});
 assert.equal(r.status,'EXECUTED');assert.equal(r.result.reconciliation.target_reconciled,true);assert.equal(r.result.reconciliation.cutoff_expectation_reconciled,true);assert.equal(r.result.sellers.find(x=>x.seller_id==='A').target_contribution,10);assert.equal(r.result.sellers.find(x=>x.seller_id==='B').target_contribution,30);
});

