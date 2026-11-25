import test from 'node:test';
import assert from 'node:assert/strict';
import {describeEvidenceRequests,resolveEvidenceRequest} from '../lib/data-floor/evidenceRequests.js';
import {describeSales,SALES_EXPLICIT_EVIDENCE} from '../lib/data-floor/sales/contract.js';

const contract=describeSales();
const request={measure:'VIN_SALES',evidence_shape:'HISTORICAL_PERIOD_SERIES',
  time:{period:'2026-11'},filters:{commercial_universe:'OWN_STORES',store_id:'3'}};

test('discovery enumerates existing shapes and explicit restrictions',()=>{
  const shapes=describeEvidenceRequests(contract,SALES_EXPLICIT_EVIDENCE);
  assert.deepEqual(Object.keys(shapes),contract.evidence_shapes);
  assert.equal(shapes.HISTORICAL_PERIOD_SERIES.route,'CERTIFIER');
  assert.equal(shapes.HISTORICAL_PERIOD_SERIES.time.period.required,true);
});

test('historical, calendar and roster shapes delegate unchanged to the existing certifier',async()=>{
  for(const [shape,filters] of [
    ['HISTORICAL_PERIOD_SERIES',request.filters],['PERIOD_CALENDAR',{}],
    ['SELLER_CONTRIBUTION_HISTORY',request.filters]]){
    const handlers={explicit:SALES_EXPLICIT_EVIDENCE,
      observe:async input=>({evidence_contract:'p1.'+shape.toLowerCase(),input}),
      resolveObservation:()=>assert.fail('wrong route')};
    const out=await resolveEvidenceRequest(contract,handlers,{...request,evidence_shape:shape,filters},'run');
    assert.deepEqual(out.input,{measure:'VIN_SALES',evidence_shape:shape,period:'2026-11',filters});
  }
});

test('rejects ignored scope, invalid period, grouping and history cutoff',async()=>{
  const handlers={explicit:SALES_EXPLICIT_EVIDENCE,observe:()=>assert.fail('must reject before query')};
  for(const changes of [
    {filters:{brand_id:'3'}},{filters:{store_id:['3','4']}},{filters:{commercial_universe:'DEALERS'}},
    {time:{period:'2026-13'}},{time:{period:'2026-11',cutoff:'2026-11-24'}},{group_by:['STORE']}])
    await assert.rejects(resolveEvidenceRequest(contract,handlers,{...request,...changes},'run'));
});

test('ordinary explicit shapes preserve declarative route, authority and run identity',async()=>{
  const evidence={evidence_contract:'p1.sql_first_partial_cumulative_period_observation',authority:'P1_PARTIAL_SOURCE'};
  const req={measure:'VIN_SALES',time:{period:'2026-11',cutoff:'2026-11-24'},filters:{store_id:'3'}};
  const handler={resolveObservation:async (input,id)=>{assert.deepEqual(input,req);assert.equal(id,'same-run');return evidence;}};
  assert.equal(await resolveEvidenceRequest(contract,handler,{...req,evidence_shape:'CUMULATIVE_PERIOD_OBSERVATION'},'same-run'),evidence);
  await assert.rejects(resolveEvidenceRequest(contract,handler,{...req,evidence_shape:'QUANTITATIVE_OBSERVATION'},'same-run'),/REQUESTED_EVIDENCE_SHAPE_NOT_AVAILABLE/);
});
