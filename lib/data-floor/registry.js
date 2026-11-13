import { describeSellout, inspectSellout, fetchSellout, observeSellout } from './selloutCertifier.js';
import { describeSales, inspectSales, fetchSales, observeSalesEvidence, buildSalesTemporalFingerprint, resolveSalesObservation } from './salesCertifier.js';
import { describeInventory, inspectInventory, fetchInventory } from './inventoryCertifier.js';
import { describeRvm, inspectRvm, fetchRvm, observeRvmEvidence, resolveRvmObservation } from './rvmCertifier.js';
import { describeForum, inspectForum, fetchForum, observeForumEvidence } from './forumCertifier.js';
import { resolveForumObservation } from './forum/observations.js';
import { describeTargets, inspectTargets, fetchTargets, observeTargetsEvidence } from './targetsCertifier.js';

import { describeCrm, inspectCrm, observeCrmEvidence } from './crmCertifier.js';
import { describePricing, inspectPricing, observePricingEvidence } from './pricingCertifier.js';
import { shareRunExecution } from './runUniverses.js';
import { findCurrentRunSalesObservation, findCurrentRunForumObservation } from '../p3/executionJournal.js';

const SOURCES = Object.freeze({
  SELL_OUT: Object.freeze({ describe: describeSellout, inspect: inspectSellout, fetch: fetchSellout, observe: observeSellout }),
  SALES: Object.freeze({ describe: describeSales, inspect: inspectSales, fetch: fetchSales, observe: observeSalesEvidence, temporalFingerprint: buildSalesTemporalFingerprint, findCurrentObservation: findCurrentRunSalesObservation, resolveObservation: resolveSalesObservation }),
  INVENTORY: Object.freeze({ describe: describeInventory, inspect: inspectInventory, fetch: fetchInventory }),
  RVM: Object.freeze({ describe: describeRvm, inspect: inspectRvm, fetch: fetchRvm, observe: observeRvmEvidence, resolveObservation: resolveRvmObservation }),
  FORUM: Object.freeze({ describe: describeForum, inspect: inspectForum, fetch: fetchForum, observe: observeForumEvidence, findCurrentObservation: findCurrentRunForumObservation, resolveObservation: resolveForumObservation }),
  CRM: Object.freeze({ describe: describeCrm, inspect: inspectCrm, observe: observeCrmEvidence }),
  TARGETS: Object.freeze({ describe: describeTargets, inspect: inspectTargets, fetch: fetchTargets, observe: observeTargetsEvidence }),
  PRICING: Object.freeze({ describe: describePricing, inspect: inspectPricing, observe: observePricingEvidence }),
});

function source(id){
  const key=String(id||'').trim().toUpperCase();
  const item=SOURCES[key];
  if(!item) throw new Error('UNKNOWN_DATA_SOURCE: '+key);
  return {key,item};
}

export function describeDataSource(id){
  const {item}=source(id);
  return item.describe();
}
export async function inspectDataSource(id,input={}){
  const {item}=source(id);
  return item.inspect(input);
}
export async function fetchDataSource(id,input={}){
  const {item}=source(id);
  if(!item.fetch) throw new Error('FETCH_NOT_SUPPORTED: '+String(id||'').trim().toUpperCase());
  return item.fetch(input);
}
export async function observeDataSource(id,input={}){
  const {item}=source(id);
  if(!item.observe) throw new Error('OBSERVE_NOT_SUPPORTED: '+String(id||'').trim().toUpperCase());
  return item.observe(input);
}
export async function temporalFingerprintDataSource(id,input={},focusEvidence=null){
  const {item}=source(id);
  if(!item.temporalFingerprint)return null;
  return item.temporalFingerprint(input,focusEvidence);
}

export async function resolveDataObservation(runId, id, input, {measureExecution, onReuse}) {
  const {key, item} = source(id);
  const {request} = input;
  const declarative = request !== undefined;
  // A domain may register resolveObservation(request) and return its P1 evidence envelope.
  if (declarative && !item.resolveObservation) {
    throw new Error('DECLARATIVE_OBSERVATION_NOT_SUPPORTED: '+key);
  }
  let startedHere = false;
  try {
    const {evidence, reusedFrom} = await shareRunExecution(runId, id, 'data_observe', input, async () => {
      startedHere = true;
      if (!declarative && item.findCurrentObservation) {
        const prior = await item.findCurrentObservation({run_id:runId, source:id, ...input});
        if (prior) return {evidence:prior.output_json, reusedFrom:prior.sequence_no};
      }
      return measureExecution(async () => {
        const focus = declarative ? await item.resolveObservation(request) : await observeDataSource(id, input);
        if (!item.temporalFingerprint) return {evidence:focus};
        const fingerprintInput = declarative ? {
          measure: focus.measure.id,
          evidence_shape: focus.evidence_contract.split('.').at(-1).toUpperCase(),
          dimension: focus.payload.dimension?.id,
          period: request.time?.period,
          period_to: request.time?.to_period,
          cutoff: request.time?.cutoff,
          filters: request.filters,
        } : input;
        const temporal_fingerprint = await item.temporalFingerprint(fingerprintInput, focus, runId);
        return {evidence:temporal_fingerprint ? {...focus, temporal_fingerprint} : focus};
      });
    });
    if (reusedFrom !== undefined) onReuse('evidence', reusedFrom);
    return evidence;
  } finally {
    if (!startedHere) onReuse('in_flight');
  }
}

export function listDataSources(){ return Object.keys(SOURCES); }
