import { invalid } from '../validation.js';
import { classifyClosedPerformance, POLICY } from '../closed-performance/classify.js';
import { adaptSalesPerformanceEvidence, closedMonthEnd } from '../closed-performance/sales-dataset-adapter.js';
import { parseDeteriorationStatusInput } from '../closed-performance/legacy/deterioration/deteriorationStatusInput.js';
import { executeDealerSeriesPerformance } from '../closed-performance/dealer-series-adapter.js';

export function executeClosedPeriodSalesPerformance({ evidence = {}, parameters = {} } = {}) {
  if (Object.keys(parameters).some(k => !['cutoff_month', 'dimension', 'member_id'].includes(k))) {
    throw invalid('INVALID_PARAMETERS', 'Only cutoff_month, dimension and member_id supported; statistical rules are fixed');
  }
  let period;
  try { period = parseDeteriorationStatusInput({ cutoff_month: parameters.cutoff_month }).cutoffMonth; }
  catch (error) { throw invalid('INVALID_PARAMETERS', error.message); }
  if (!['string', 'number'].includes(typeof parameters.member_id) || !/^\d+$/.test(String(parameters.member_id))) {
    throw invalid('INVALID_PARAMETERS', 'One canonical numeric member_id required');
  }
  const memberId = String(parameters.member_id), dimension = parameters.dimension;
  if (dimension === 'DEALER_GROUP') return executeDealerSeriesPerformance(evidence, memberId, period);
  const adapted = adaptSalesPerformanceEvidence(evidence, dimension, memberId, period);
  const { config, observations, missing, unresolved, refs, current, memberLabel } = adapted;
  const identityConfirmed = observations.some(row => row.value != null);
  let result;
  if (missing.length || unresolved.length || !identityConfirmed) {
    const reason = missing.length ? 'P1_HISTORY_COVERAGE_INCOMPLETE'
      : unresolved.length ? 'P1_IDENTITY_COVERAGE_INCOMPLETE' : 'P1_MEMBER_IDENTITY_UNCONFIRMED';
    result = { state: 'UNKNOWN', reason,
      sufficient_evidence: false, original_deterioration: null, improvement_episode: null,
      current: null, statistical_evidence: [], coverage: {} };
  } else {
    // Existing function argument names are retained for binary/source parity;
    // member identity and the original P1 evidence are NOT recast as STORE.
    result = classifyClosedPerformance({ observations, storeId: memberId,
      storeLabel: memberLabel ?? memberId, period });
  }
  return {
    ...result, source: 'SALES', measure: 'VIN_SALES', dimension, member_id: memberId,
    member_label: memberLabel, identity_contract: config.identity, identity_version: config.version,
    identity_status: identityConfirmed ? 'P1_OBSERVED' : 'UNCONFIRMED',
    commercial_universe: config.universe, period, cutoff: closedMonthEnd(period),
    observed_sales: current?.value ?? null, observation_state: current?.observation_state ?? 'NO_P1_DATASET',
    policy: POLICY, parameters: { cutoff_month: period, dimension, member_id: memberId },
    coverage: { ...result.coverage, missing_p1_periods: missing, unresolved_identity_periods: unresolved,
      history_start: '2021-01', history_end: period,
      observed_positive_months: observations.filter(r => r.value > 0).length,
      first_observed_period: observations.find(r => r.value != null)?.period_identity ?? null,
      last_observed_period: observations.findLast(r => r.value != null)?.period_identity ?? null,
      explicit_zero_periods: observations.filter(r => r.value === 0).map(r => r.period_identity),
      unobserved_member_periods: observations.filter(r => r.value == null).map(r => r.period_identity) },
    evidence: { refs, observations },
    limitations: [
      'The statistical core and approved thresholds are unchanged from c3ee707.',
      'Explicit zero sales differs from missing information, but ACTIVE_ZERO needs independent P1 activity evidence not published by these contracts.',
      'No label-based merging, cross-ID stitching, active roster inference or future months.',
      'Historical gaps and unresolved identities are not filled or assigned to a member.',
      'Closed months only; not open-period risk or hypothesis significance.',
    ],
  };
}
