import { assertP1, finite, invalid } from '../validation.js';
import { classifyClosedPerformance, POLICY } from '../closed-performance/classify.js';
import { shiftMonth } from '../closed-performance/legacy/expectation/monthSeries.js';
import { closedMonthEnd } from '../closed-performance/sales-dataset-adapter.js';
import { parseDeteriorationStatusInput } from '../closed-performance/legacy/deterioration/deteriorationStatusInput.js';

const DIMENSIONS = Object.freeze({
  STORE: { universe: 'OWN_STORES', identity: 'sucursales_master', version: '0.1' },
  SELLER: { universe: 'OWN_STORES', identity: 'personas_master', version: '0.1' },
  MODEL: { universe: 'COMPANY', identity: 'modelos_master_v01', version: '0.1' },
  DEALER_GROUP: { universe: 'DEALERS' },
});
const monthSlot = m => 'history_' + m.replace('-', '_');
const seriesSlot = (a, b) => 'series_' + a.replace('-', '_') + '_' + b.replace('-', '_');
const months = (a, b) => {
  const out = [];
  for (let m = a; m <= b; m = shiftMonth(m, 1)) out.push(m);
  return out;
};
function fail(code, message) { throw invalid(code, message); }
function checkCount(value) {
  finite(value, 'VIN sales');
  if (!Number.isInteger(value) || value < 0) fail('INVALID_EVIDENCE', 'VIN counts must be nonnegative integers');
}
function checkBrand(e, brandId, memberId, dimension, universe) {
  assertP1(e, 'brand performance');
  if (e.status !== 'CERTIFIED' || e.source !== 'SALES' || e.evidence_version !== '0.1.0'
    || e.measure?.id !== 'VIN_SALES' || e.measure?.unit !== 'VIN'
    || e.measure?.aggregation !== 'COUNT_RECOGNIZED_SALE'
    || e.universe?.commercial_universe !== universe
    || e.lineage?.certifier !== 'salesCertifier' || e.lineage?.certifier_version !== '0.13') {
    fail('INCOMPATIBLE_EVIDENCE', 'Certified SALES VIN_SALES@0.13 brand evidence required');
  }
  const expected = dimension === 'DEALER_GROUP'
    ? { brand_id: brandId, dealer_group_id: memberId } : { brand_id: brandId };
  const actual = e.dimensions ?? {};
  if (Object.keys(actual).length !== Object.keys(expected).length
    || Object.entries(expected).some(([k,v]) => String(actual[k]) !== v)
    || Object.entries(expected).some(([k,v]) => String(e.lineage?.source_filters?.[k]) !== v)) {
    fail('INCOMPATIBLE_EVIDENCE', 'Original P1 brand and dealer filters must match exactly');
  }
}
export function executeClosedPeriodBrandPerformance({ evidence = {}, parameters = {} } = {}) {
  if (Object.keys(parameters).some(k => !['cutoff_month','dimension','member_id','brand_id'].includes(k)))
    fail('INVALID_PARAMETERS', 'Only cutoff_month, dimension, member_id, brand_id supported');
  let period;
  try { period = parseDeteriorationStatusInput({ cutoff_month: parameters.cutoff_month }).cutoffMonth; }
  catch (error) { fail('INVALID_PARAMETERS', error.message); }
  const dimension = parameters.dimension, config = DIMENSIONS[dimension];
  if (!config) fail('UNSUPPORTED_GRAIN', 'Only STORE, SELLER, MODEL and DEALER_GROUP are supported');
  const memberId = String(parameters.member_id ?? ''), brandId = String(parameters.brand_id ?? '');
  if (!/^\d+$/.test(memberId) || !/^\d+$/.test(brandId))
    fail('INVALID_PARAMETERS', 'Canonical numeric member_id and brand_id required');
  const byMonth = new Map(), refs = [], unresolved = [];
  const dealer = dimension === 'DEALER_GROUP';
  let start = dealer ? shiftMonth(period, -12) : '2021-01', memberLabel = null;
  for (const [slot, e] of Object.entries(evidence)) {
    checkBrand(e, brandId, memberId, dimension, config.universe);
    if (dealer) {
      if (e.evidence_contract !== 'p1.period_observation_series' || e.grain !== 'COMMERCIAL_MONTH')
        fail('INVALID_EVIDENCE', 'Original P1 dealer group period series required');
      const t = e.temporal ?? {}, a = t.period_from, b = t.period_to;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a ?? '') || !/^\d{4}-(0[1-9]|1[0-2])$/.test(b ?? '')
        || a < '2021-01' || a > b || b > period || slot !== seriesSlot(a,b)
        || t.period_type !== 'COMMERCIAL_MONTH' || t.ordering !== 'ASCENDING'
        || (t.cutoff != null && t.cutoff !== closedMonthEnd(b)))
        fail('INCOMPATIBLE_EVIDENCE', 'Valid closed monthly series and original slot required');
      if (a < start) start = a;
      const expected = months(a,b), rows = e.payload?.observations, seen = new Set();
      if (!Array.isArray(rows)) fail('INVALID_EVIDENCE', 'P1 observations required');
      for (const row of rows) {
        if (!expected.includes(row.period_identity) || seen.has(row.period_identity)
          || byMonth.has(row.period_identity) || !row.evidence_id
          || !e.lineage?.component_evidence_ids?.includes(row.evidence_id))
          fail('INVALID_EVIDENCE', 'Unique monthly P1 observations and component lineage required');
        checkCount(row.value);
        seen.add(row.period_identity);
        byMonth.set(row.period_identity, { period_identity: row.period_identity, value: row.value,
          evidence_id: row.evidence_id, observation_state: row.value ? 'OBSERVED_POSITIVE' : 'ZERO_SALES_ACTIVITY_UNVERIFIED' });
      }
      if (e.coverage?.requested_periods !== expected.length || e.coverage?.observed_periods !== rows.length
        || JSON.stringify(e.coverage?.gaps) !== JSON.stringify(expected.filter(m => !seen.has(m))))
        fail('INVARIANT_VIOLATION', 'P1 dealer series coverage mismatch');
    } else {
      if (e.evidence_contract !== 'p1.dimensional_quantitative_dataset' || e.grain !== 'FILTERED_SALES_UNIVERSE')
        fail('INVALID_EVIDENCE', 'Original P1 dimensional brand dataset required');
      const t = e.temporal ?? {}, m = t.period_identity, d = e.payload?.dimension;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m ?? '') || m < start || m > period
        || slot !== monthSlot(m) || byMonth.has(m) || t.period_type !== 'COMMERCIAL_MONTH'
        || t.cutoff !== closedMonthEnd(m) || t.date_from !== m + '-01' || t.date_to !== closedMonthEnd(m)
        || d?.id !== dimension || d.identity_contract !== config.identity || d.identity_version !== config.version)
        fail('INCOMPATIBLE_EVIDENCE', 'Canonical dimension and unique closed monthly P1 dataset required');
      const members = e.payload?.members, ids = new Set();
      if (!Array.isArray(members)) fail('INVALID_EVIDENCE', 'Original P1 members required');
      let sum = 0, unknown = 0, selected = null;
      for (const row of members) {
        const id = String(row.member_id);
        if ((!/^\d+$/.test(id) && id !== 'UNRESOLVED') || ids.has(id))
          fail('INVALID_EVIDENCE', 'Canonical unique P1 member IDs required');
        ids.add(id); checkCount(row.value); sum += row.value;
        if (id === 'UNRESOLVED') unknown += row.value;
        if (id === memberId) selected = row;
      }
      if (sum !== e.coverage?.filtered_n || unknown !== e.coverage?.dimension_unresolved_n
        || sum - unknown !== e.coverage?.dimension_resolved_n)
        fail('INVARIANT_VIOLATION', 'P1 dimensional coverage does not reconcile');
      if (unknown) unresolved.push({ period: m, value: unknown, evidence_id: e.evidence_id });
      if (selected?.member_label != null) memberLabel = selected.member_label;
      byMonth.set(m, { period_identity: m, value: selected?.value ?? null, evidence_id: e.evidence_id,
        observation_state: selected == null ? 'NOT_OBSERVED' : selected.value ? 'OBSERVED_POSITIVE' : 'ZERO_SALES_ACTIVITY_UNVERIFIED' });
    }
    refs.push({slot,evidence_id:e.evidence_id,evidence_contract:e.evidence_contract,
      evidence_version:e.evidence_version,temporal:e.temporal,lineage:e.lineage});
  }
  const missing = months(start,period).filter(m => !byMonth.has(m));
  const observations = months(start,period).map(m => byMonth.get(m) ?? {
    period_identity:m,value:null,evidence_id:null,observation_state:'NO_P1_OBSERVATION' });
  const confirmed = observations.some(o => o.value != null);
  const result = missing.length || unresolved.length || !confirmed
    ? { state:'UNKNOWN', reason:missing.length?'P1_HISTORY_COVERAGE_INCOMPLETE':
        unresolved.length?'P1_IDENTITY_COVERAGE_INCOMPLETE':'P1_MEMBER_IDENTITY_UNCONFIRMED',
        sufficient_evidence:false,original_deterioration:null,improvement_episode:null,
        current:null,statistical_evidence:[],coverage:{} }
    : classifyClosedPerformance({observations,storeId:memberId,storeLabel:memberLabel ?? memberId,period});
  return {...result,source:'SALES',measure:'VIN_SALES',brand_id:brandId,dimension,
    member_id:memberId,member_label:memberLabel,identity_contract:config.identity ?? null,
    identity_version:config.version ?? null,identity_status:dealer?'P1_FILTERED_CURRENT_GROUP':
      confirmed?'P1_OBSERVED':'UNCONFIRMED',commercial_universe:config.universe,
    grouping_semantics:dealer?'CURRENT_COMMERCIAL_GROUPING':null,period,cutoff:closedMonthEnd(period),
    observed_sales:byMonth.get(period)?.value ?? null,policy:POLICY,
    parameters:{cutoff_month:period,brand_id:brandId,dimension,member_id:memberId},
    coverage:{...result.coverage,history_start:start,history_end:period,
      missing_p1_periods:missing,unresolved_identity_periods:unresolved,
      explicit_zero_periods:observations.filter(o=>o.value===0).map(o=>o.period_identity)},
    evidence:{refs:refs.sort((a,b)=>a.slot.localeCompare(b.slot)),observations},
    limitations:['No brand identity inferred: brand_id must be resolved by P1.',
      'DEALER_GROUP is a current commercial grouping, not certified historical membership.',
      'Missing/zero sales never establish independent activity.',
      'Original statistical policy and thresholds are unchanged; closed months only.']};
}
