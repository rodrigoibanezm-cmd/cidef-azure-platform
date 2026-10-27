import { assertP1, finite, invalid } from '../validation.js';
import { shiftMonth } from './legacy/expectation/monthSeries.js';
import { closedMonthEnd } from './sales-dataset-adapter.js';
import { classifyClosedPerformance, POLICY } from './classify.js';

// The original filtered P1 series remains a series, never a fabricated
// dimensional dataset. Membership is the current commercial grouping used by
// publish-dealer-monthly-sellin.js, not an as-of historical group assignment.
export function executeDealerSeriesPerformance(evidence, memberId, period) {
  const byMonth = new Map(), refs = [];
  let start = shiftMonth(period, -12), certifierVersion = null;
  for (const [slot, e] of Object.entries(evidence)) {
    assertP1(e, slot);
    if (e.status !== 'CERTIFIED' || e.source !== 'SALES'
      || e.evidence_contract !== 'p1.period_observation_series' || e.evidence_version !== '0.1.0') {
      throw invalid('INVALID_EVIDENCE', 'Original certified SALES period observation series required');
    }
    if (e.grain !== 'COMMERCIAL_MONTH' || e.measure?.id !== 'VIN_SALES'
      || e.measure?.unit !== 'VIN' || e.measure?.aggregation !== 'COUNT_RECOGNIZED_SALE'
      || e.universe?.commercial_universe !== 'DEALERS'
      || Object.keys(e.dimensions ?? {}).length !== 1
      || String(e.dimensions.dealer_group_id) !== memberId) {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'Same DEALERS VIN_SALES dealer_group_id slice required');
    }
    const t = e.temporal, from = t?.period_from, to = t?.period_to;
    if (!shiftMonth(from, 0) || !shiftMonth(to, 0) || from < '2021-01' || from > to || to > period
      || t.period_type !== 'COMMERCIAL_MONTH' || t.ordering !== 'ASCENDING'
      || slot !== 'series_' + from.replace('-', '_') + '_' + to.replace('-', '_')
      || (t.cutoff != null && t.cutoff !== closedMonthEnd(to))) {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'Non-overlapping closed-month series with exact range slots required');
    }
    if (e.lineage.certifier !== 'salesCertifier' || e.lineage.certifier_version !== '0.13'
      || (certifierVersion && certifierVersion !== e.lineage.certifier_version)) {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'Consistent SALES certifier version required');
    }
    certifierVersion = e.lineage.certifier_version;
    start = from < start ? from : start;
    const observations = e.payload?.observations;
    if (!Array.isArray(observations)) throw invalid('INVALID_EVIDENCE', 'P1 observations required');
    const expected = [];
    for (let m = from; m <= to; m = shiftMonth(m, 1)) expected.push(m);
    const local = new Set();
    for (const o of observations) {
      if (!expected.includes(o.period_identity) || local.has(o.period_identity) || byMonth.has(o.period_identity)
        || !o.evidence_id || !e.lineage.component_evidence_ids?.includes(o.evidence_id)) {
        throw invalid('INVALID_EVIDENCE', 'Unique months and original component refs required');
      }
      finite(o.value, 'monthly VIN');
      if (!Number.isInteger(o.value) || o.value < 0) throw invalid('INVALID_EVIDENCE', 'Non-negative integer VIN required');
      local.add(o.period_identity);
      byMonth.set(o.period_identity, { ...o, series_evidence_id: e.evidence_id,
        observation_state: o.value === 0 ? 'ZERO_SALES_ACTIVITY_UNVERIFIED' : 'OBSERVED_POSITIVE' });
    }
    const gaps = expected.filter(m => !local.has(m));
    if (e.coverage?.requested_periods !== expected.length || e.coverage?.observed_periods !== observations.length
      || JSON.stringify(e.coverage?.gaps) !== JSON.stringify(gaps)) {
      throw invalid('INVARIANT_VIOLATION', 'P1 series coverage must reconcile');
    }
    refs.push({ slot, evidence_id: e.evidence_id, evidence_contract: e.evidence_contract,
      evidence_version: e.evidence_version, temporal: t, lineage: e.lineage });
  }
  const observations = [], missing = [];
  for (let m = start; m <= period; m = shiftMonth(m, 1)) {
    if (!byMonth.has(m)) missing.push(m);
    observations.push(byMonth.get(m) ?? { period_identity: m, value: null,
      evidence_id: null, observation_state: 'NO_P1_OBSERVATION' });
  }
  const current = byMonth.get(period);
  const result = missing.length ? { state: 'UNKNOWN', reason: 'P1_HISTORY_COVERAGE_INCOMPLETE',
    sufficient_evidence: false, original_deterioration: null, improvement_episode: null,
    current: null, statistical_evidence: [], coverage: {} }
    : classifyClosedPerformance({ observations, storeId: memberId, storeLabel: memberId, period });
  return { ...result, source: 'SALES', measure: 'VIN_SALES', dimension: 'DEALER_GROUP',
    member_id: memberId, member_label: null, identity_contract: null, identity_version: null,
    identity_status: 'P1_FILTERED_CURRENT_GROUP', grouping_semantics: 'CURRENT_COMMERCIAL_GROUPING',
    commercial_universe: 'DEALERS', period, cutoff: closedMonthEnd(period),
    observed_sales: current?.value ?? null, observation_state: current?.observation_state ?? 'NO_P1_OBSERVATION',
    policy: POLICY, parameters: { cutoff_month: period, dimension: 'DEALER_GROUP', member_id: memberId },
    coverage: { ...result.coverage, history_start: start, history_end: period,
      history_scope: 'REQUESTED_SERIES_WITH_NECESSARY_WARMUP', missing_p1_periods: missing,
      explicit_zero_periods: observations.filter(o => o.value === 0).map(o => o.period_identity),
      observed_positive_months: observations.filter(o => o.value > 0).length },
    evidence: { refs, observations }, limitations: [
      'Current commercial grouping, not historical as-of membership certification.',
      'Statistics use all supplied original series observations; results are conditional on the stated history window.',
      'Zero sales is certified but independent activity is unavailable; sparse statistical core remains unchanged.',
      'No temporal fingerprints, FETCH-derived counts, label merges or invented dimensional identity contract.',
      'Closed months only; no open-period risk.',
    ] };
}
