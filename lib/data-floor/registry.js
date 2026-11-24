import { describeSellout, inspectSellout, fetchSellout, observeSellout, resolveSelloutObservation } from './selloutCertifier.js';
import { describeSales, inspectSales, fetchSales, observeSalesEvidence, buildSalesTemporalFingerprint, resolveSalesObservation } from './salesCertifier.js';
import { describeInventory, inspectInventory, fetchInventory, resolveInventoryObservation } from './inventoryCertifier.js';
import { describeRvm, inspectRvm, fetchRvm, observeRvmEvidence, resolveRvmObservation } from './rvmCertifier.js';
import { describeForum, inspectForum, fetchForum, observeForumEvidence } from './forumCertifier.js';
import { resolveForumObservation } from './forum/observations.js';
import { describeTargets, inspectTargets, fetchTargets, observeTargetsEvidence, resolveTargetsObservation } from './targetsCertifier.js';

import { describePricing, inspectPricing, observePricingEvidence, resolvePricingObservation } from './pricingCertifier.js';
import { shareRunExecution } from './runUniverses.js';
import { findCurrentRunSalesObservation, findCurrentRunForumObservation } from '../p3/executionJournal.js';

const SOURCES = Object.freeze({
  SELL_OUT: Object.freeze({ describe: describeSellout, inspect: inspectSellout, fetch: fetchSellout, observe: observeSellout, resolveObservation: resolveSelloutObservation }),
  SALES: Object.freeze({ describe: describeSales, inspect: inspectSales, fetch: fetchSales, observe: observeSalesEvidence, temporalFingerprint: buildSalesTemporalFingerprint, findCurrentObservation: findCurrentRunSalesObservation, resolveObservation: resolveSalesObservation }),
  INVENTORY: Object.freeze({ describe: describeInventory, inspect: inspectInventory, fetch: fetchInventory, resolveObservation: resolveInventoryObservation }),
  RVM: Object.freeze({ describe: describeRvm, inspect: inspectRvm, fetch: fetchRvm, observe: observeRvmEvidence, resolveObservation: resolveRvmObservation }),
  FORUM: Object.freeze({ describe: describeForum, inspect: inspectForum, fetch: fetchForum, observe: observeForumEvidence, findCurrentObservation: findCurrentRunForumObservation, resolveObservation: resolveForumObservation }),
  TARGETS: Object.freeze({ describe: describeTargets, inspect: inspectTargets, fetch: fetchTargets, observe: observeTargetsEvidence, resolveObservation: resolveTargetsObservation }),
  PRICING: Object.freeze({ describe: describePricing, inspect: inspectPricing, observe: observePricingEvidence, resolveObservation: resolvePricingObservation }),
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

// Route unambiguous legacy observations through the existing declarative P1 contract.
// Unsupported shapes retain their original certified implementation.
export function planDefaultObservation(source, input) {
  if (!input || input.request !== undefined || typeof input.measure !== 'string') return null;
  const {measure, period, cutoff, filters = {}, dimension, evidence_shape: shape} = input;
  const scalar = dimension == null && input.period_from == null && input.period_to == null;
  const rules = {
    SALES: scalar && typeof period === 'string' && typeof cutoff === 'string' &&
      cutoff.length === 10 && shape === 'CUMULATIVE_PERIOD_OBSERVATION',
    FORUM: scalar && typeof period === 'string' && cutoff == null &&
      (!shape || shape === 'QUANTITATIVE_OBSERVATION') &&
      !['PRECURSE','OPERATION_STATES'].includes(measure),
    RVM: scalar && typeof period === 'string' && cutoff == null &&
      (!shape || shape === 'QUANTITATIVE_OBSERVATION'),
    SELL_OUT: scalar && typeof period === 'string' && cutoff == null &&
      (!shape || shape === 'QUANTITATIVE_OBSERVATION'),
    TARGETS: scalar && typeof period === 'string' && cutoff == null &&
      shape === 'REFERENCE_OBSERVATION',
    PRICING: scalar && typeof period === 'string' && cutoff == null &&
      shape === 'COMMERCIAL_CONDITION_WINDOWS',
  };
  if (!rules[source]) return null;
  return {measure, time:{period,...(cutoff == null ? {} : {cutoff})},filters};
}

export async function resolveDataObservation(runId, id, input, {measureExecution, onReuse}) {
  const {key, item} = source(id);
  const request = input.request ?? planDefaultObservation(key, input);
  const declarative = request !== null && request !== undefined;
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
        const focus = declarative ? await item.resolveObservation(request, runId) : await observeDataSource(id, input);
        if (!item.temporalFingerprint || focus.status === 'PARTIAL_SOURCE') return {evidence:focus};
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
