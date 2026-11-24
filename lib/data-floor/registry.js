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

// Adapt only observations whose shape and measure are advertised by P1.
// Domain semantics and SQL selection stay inside the registered certifier.
export function planDefaultObservation(contract, input) {
  if (!input || input.request !== undefined || typeof input.measure !== 'string') return null;
  const {measure, period, cutoff, filters = {}, dimension, evidence_shape} = input;
  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) ||
      dimension != null || input.period_from != null || input.period_to != null ||
      !filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
  const shape = evidence_shape ?? 'QUANTITATIVE_OBSERVATION';
  if (!['QUANTITATIVE_OBSERVATION', 'CUMULATIVE_PERIOD_OBSERVATION',
    'REFERENCE_OBSERVATION', 'COMMERCIAL_CONDITION_WINDOWS'].includes(shape) ||
      !contract.evidence_shapes?.includes(shape)) return null;
  const measureId = measure.trim().toUpperCase().replace(
    new RegExp('^' + contract.source + '\\.'), '');
  const advertised = Array.isArray(contract.measures)
    ? contract.measures.some(item => item.id === measureId)
    : Object.hasOwn(contract.measures ?? {}, measureId);
  if (!advertised || (cutoff != null &&
      (shape !== 'CUMULATIVE_PERIOD_OBSERVATION' ||
        typeof cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)))) return null;
  return {measure, time:{period,...(cutoff == null ? {} : {cutoff})}, filters};
}

export async function resolveDataObservation(runId, id, input, {measureExecution, onReuse}) {
  const {key, item} = source(id);
  const request = input.request ?? (item.resolveObservation ? planDefaultObservation(item.describe(), input) : null);
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
