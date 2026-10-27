import { buildCurrentDeteriorationStatus } from './legacy/deterioration/buildCurrentDeteriorationStatus.js';
import { calculateDeviations } from './legacy/deterioration/orgDeviations.js';
import { expectedMovingAverage } from './legacy/expectation/expectedCandidates.js';
import { shiftMonth } from './legacy/expectation/monthSeries.js';

export const POLICY = Object.freeze({
  policy_id: 'CLOSED_STORE_PERFORMANCE_MIRROR_V01',
  baseline: 'moving_average_12', deviation: 'historical_percentile',
  deterioration: 'deepening_2', improvement: 'mirror_deepening_2',
  baseline_months: 12, minimum_prior_errors: 3, neutral_percentile: 0.5,
  favorable_rule: 'historical_percentile > 0.5',
  improvement_confirmation: 'two consecutive favorable months with strictly increasing errors',
  improvement_retention: 'while favorable; terminate on neutral, adverse or UNKNOWN',
  history_start_month: '2021-01',
  history_scope_reference: 'P1 E06_V0_1_HISTORY',
  approval_reference: 'd866e51 + explicit user approval',
  historical_core: 'cidef-data-loader@16f01f381238bc058c3e25e88dca7b550aa487f7',
});

// P1 owns recognition and identity. Missing observations (including zero without
// independent active-store evidence) are absent from the sparse index.
export function buildPerformanceRows(observations, storeId) {
  const months = new Map(observations.filter(r => r.value > 0).map(r => [r.period_identity, r.value]));
  const rows = [], errors = [];
  for (const [month, sales] of [...months].sort(([a], [b]) => a.localeCompare(b))) {
    const baseline = expectedMovingAverage(months, month, 12);
    if (baseline == null) continue;
    const deviations = calculateDeviations(sales, baseline, errors);
    rows.push({ unit_id: storeId, month, sales, baseline: POLICY.baseline, baseline_value: baseline, deviations });
    errors.push(deviations.error);
  }
  return { rows, months };
}

function improvementEpisode(rows, units, period) {
  // Reflection reuses the SAME episode/persistence core: p > .5 becomes
  // (1-p) < .5 and growing errors become decreasing negative errors.
  const reflected = rows.map(row => ({ ...row, deviations: { ...row.deviations,
    error: -row.deviations.error,
    historical_percentile: row.deviations.historical_percentile == null
      ? null : 1 - row.deviations.historical_percentile,
  } }));
  const mirror = buildCurrentDeteriorationStatus(reflected, units, period).statuses[0];
  return mirror.status === 'DETERIORATING' ? {
    onset_month: mirror.onset_month, confirmation_month: mirror.confirmation_month,
    evidence_months: mirror.persistence_rows.map(row => row.month),
  } : null;
}

export function classifyClosedPerformance({ observations, storeId, storeLabel = storeId, period }) {
  const { rows, months } = buildPerformanceRows(observations, storeId);
  const unit = { unit_id: storeId, unit_label: storeLabel, months };
  const units = new Map([[storeId, unit]]);
  // Exact historical status implementation; no redefinition of deterioration.
  const original = buildCurrentDeteriorationStatus(rows, units, period).statuses[0];
  const current = rows.find(r => r.month === period) ?? null;
  const previous = rows.find(r => r.month === shiftMonth(period, -1)) ?? null;
  const sufficient = current?.deviations.historical_percentile != null
    && previous?.deviations.historical_percentile != null;
  const improvement = improvementEpisode(rows, units, period);
  let state, reason;
  if (original.status === 'DETERIORATING') { state = 'DETERIORATING'; reason = 'ORIGINAL_ACTIVE_EPISODE'; }
  else if (original.status === 'UNKNOWN') { state = 'UNKNOWN'; reason = original.status_reason; }
  else if (!sufficient) { state = 'UNKNOWN'; reason = 'TWO_CONSECUTIVE_EVALUABLE_MONTHS_REQUIRED'; }
  else if (improvement) { state = 'IMPROVING'; reason = 'ACTIVE_MIRROR_EPISODE'; }
  else { state = 'STABLE'; reason = 'SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE'; }
  return {
    state, reason, original_deterioration: original, improvement_episode: improvement,
    current: original.current,
    sufficient_evidence: sufficient,
    coverage: { observed_positive_months: months.size, formal_rows: rows.length,
      evaluable_rows: rows.filter(r => r.deviations.historical_percentile != null).length,
      unknown_or_unverified_zero_periods: observations.filter(r => r.value == null || r.value === 0).map(r => r.period_identity) },
    statistical_evidence: rows.map(r => ({ period: r.month, sales: r.sales,
      baseline: r.baseline_value, ...r.deviations })),
  };
}
