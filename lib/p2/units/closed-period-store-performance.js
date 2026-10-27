import { assertP1, finite, invalid } from '../validation.js';
import { classifyClosedPerformance, POLICY } from '../closed-performance/classify.js';
import { parseDeteriorationStatusInput } from '../closed-performance/legacy/deterioration/deteriorationStatusInput.js';
import { shiftMonth } from '../closed-performance/legacy/expectation/monthSeries.js';

function monthEnd(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// P1 STORE datasets are shared across stores. MCP resolves history_YYYY_MM refs.
export function executeClosedPeriodStorePerformance({ evidence = {}, parameters = {} } = {}) {
  if (Object.keys(parameters).some(k => !['cutoff_month', 'store_id'].includes(k))) {
    throw invalid('INVALID_PARAMETERS', 'Only cutoff_month and store_id supported; rules are fixed');
  }
  let period;
  try { period = parseDeteriorationStatusInput({ cutoff_month: parameters.cutoff_month }).cutoffMonth; }
  catch (error) { throw invalid('INVALID_PARAMETERS', error.message); }
  const store = parameters.store_id;
  if (!['string', 'number'].includes(typeof store) || !/^\d+$/.test(String(store))) {
    throw invalid('INVALID_PARAMETERS', 'One canonical numeric store_id required');
  }
  const storeId = String(store), byMonth = new Map(), refs = [];
  for (const [slot, e] of Object.entries(evidence)) {
    assertP1(e, slot);
    if (e.status !== 'CERTIFIED' || e.source !== 'SALES'
      || e.evidence_contract !== 'p1.dimensional_quantitative_dataset' || e.evidence_version !== '0.1.0') {
      throw invalid('INVALID_EVIDENCE', 'Certified SALES p1.dimensional_quantitative_dataset@0.1.0 required');
    }
    if (e.measure?.id !== 'VIN_SALES' || e.universe?.commercial_universe !== 'OWN_STORES'
      || e.grain !== 'FILTERED_SALES_UNIVERSE' || Object.keys(e.dimensions ?? {}).length) {
      throw invalid('UNSUPPORTED_GRAIN', 'Unfiltered SALES VIN_SALES OWN_STORES STORE datasets required');
    }
    const d = e.payload?.dimension;
    if (d?.id !== 'STORE' || d.identity_contract !== 'sucursales_master' || d.identity_version !== '0.1') {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'Canonical STORE identity required');
    }
    const month = e.temporal?.period_identity;
    if (!shiftMonth(month, 0) || month < '2021-01' || month > period || byMonth.has(month)
      || slot !== 'history_' + month.replace('-', '_') || e.temporal?.period_type !== 'COMMERCIAL_MONTH'
      || e.temporal?.cutoff !== monthEnd(month) || e.temporal?.date_from !== month + '-01'
      || e.temporal?.date_to !== monthEnd(month)) {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'Unique complete closed months in history_YYYY_MM slots required');
    }
    if (e.coverage?.dimension_unresolved_n !== 0) throw invalid('INCOMPATIBLE_EVIDENCE', 'Unresolved STORE identities prevent parity');
    const members = e.payload?.members;
    if (!Array.isArray(members)) throw invalid('INVALID_EVIDENCE', 'STORE members required');
    const seen = new Set(); let sum = 0;
    for (const member of members) {
      if (!/^\d+$/.test(String(member.member_id)) || seen.has(String(member.member_id))) throw invalid('INVALID_EVIDENCE', 'Unique canonical member IDs required');
      seen.add(String(member.member_id)); finite(member.value, 'monthly VIN');
      if (!Number.isInteger(member.value) || member.value < 0) throw invalid('INVALID_EVIDENCE', 'Non-negative integer VIN counts required');
      sum += member.value;
    }
    if (sum !== e.coverage?.filtered_n) throw invalid('INVARIANT_VIOLATION', 'STORE counts must reconcile with certified total');
    const member = members.find(r => String(r.member_id) === storeId);
    byMonth.set(month, { period_identity: month, value: member?.value ?? null,
      evidence_id: e.evidence_id, store_label: member?.member_label ?? null });
    refs.push({ slot, evidence_id: e.evidence_id, evidence_contract: e.evidence_contract,
      evidence_version: e.evidence_version, cutoff: e.temporal.cutoff, lineage: e.lineage });
  }
  const missing = [];
  for (let month = '2021-01'; month <= period; month = shiftMonth(month, 1)) if (!byMonth.has(month)) missing.push(month);
  const observations = [...byMonth.values()].sort((a, b) => a.period_identity.localeCompare(b.period_identity));
  let result;
  if (missing.length) {
    result = { state: 'UNKNOWN', reason: 'P1_HISTORY_COVERAGE_INCOMPLETE', sufficient_evidence: false,
      original_deterioration: null, improvement_episode: null, current: null, statistical_evidence: [], coverage: {} };
  } else result = classifyClosedPerformance({ observations, storeId, storeLabel: byMonth.get(period)?.store_label ?? storeId, period });
  return {
    ...result, period, cutoff: monthEnd(period), source: 'SALES', measure: 'VIN_SALES',
    commercial_universe: 'OWN_STORES', store_id: storeId, store_label: byMonth.get(period)?.store_label ?? null,
    observed_sales: byMonth.get(period)?.value ?? null,
    policy: POLICY, parameters: { cutoff_month: period, store_id: storeId },
    coverage: { ...result.coverage, missing_p1_periods: missing, history_start: '2021-01', history_end: period },
    evidence: { refs: refs.sort((a, b) => a.slot.localeCompare(b.slot)),
      observations: observations.map(r => ({ ...r, observation_state: r.value > 0 ? 'OBSERVED_POSITIVE' : 'UNKNOWN' })) },
    limitations: [
      'Operational mirror rule, not a hypothesis significance test.',
      'Zero/absent sales without independent active-store evidence remain UNKNOWN; absence is never filled with zero.',
      'Parity concerns the statistical rule on identical P1 observations, not legacy RAW/identity acquisition.',
      'History policy starts 2021-01; earlier sales and independent NV activity are not exposed by these P1 inputs.',
      'Closed calendar months only; no open-period risk or forecast.',
    ],
  };
}
