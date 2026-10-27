import { assertP1, finite, invalid } from '../validation.js';
import { shiftMonth } from './legacy/expectation/monthSeries.js';
import { salesPerformanceDimension } from './sales-dimensions.js';
import { modelIdentityCoverage } from './model-identity-coverage.js';

export function closedMonthEnd(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Read original P1 envelopes; never relabel a dimension or manufacture members.
export function adaptSalesPerformanceEvidence(evidence, dimension, memberId, period) {
  const config = salesPerformanceDimension(dimension), byMonth = new Map(), refs = [], unresolved = [];
  for (const [slot, e] of Object.entries(evidence)) {
    assertP1(e, slot);
    if (e.status !== 'CERTIFIED' || e.source !== 'SALES'
      || e.evidence_contract !== 'p1.dimensional_quantitative_dataset' || e.evidence_version !== '0.1.0') {
      throw invalid('INVALID_EVIDENCE', 'Certified SALES p1.dimensional_quantitative_dataset@0.1.0 required');
    }
    if (e.measure?.id !== 'VIN_SALES' || e.universe?.commercial_universe !== config.universe
      || e.grain !== 'FILTERED_SALES_UNIVERSE' || Object.keys(e.dimensions ?? {}).length) {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'Wrong universe, grain or additional slice filters');
    }
    const d = e.payload?.dimension;
    if (d?.id !== dimension || d.identity_contract !== config.identity || d.identity_version !== config.version) {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'P1 canonical identity contract/version must remain identical across history');
    }
    const month = e.temporal?.period_identity;
    if (!shiftMonth(month, 0) || month < '2021-01' || month > period || byMonth.has(month)
      || slot !== 'history_' + month.replace('-', '_') || e.temporal?.period_type !== 'COMMERCIAL_MONTH'
      || e.temporal?.cutoff !== closedMonthEnd(month) || e.temporal?.date_from !== month + '-01'
      || e.temporal?.date_to !== closedMonthEnd(month)) {
      throw invalid('INCOMPATIBLE_EVIDENCE', 'Unique full calendar months in history_YYYY_MM slots required');
    }
    const members = e.payload?.members;
    if (!Array.isArray(members)) throw invalid('INVALID_EVIDENCE', 'P1 members required');
    const seen = new Set(); let sum = 0, unresolvedValue = 0;
    for (const member of members) {
      const id = String(member.member_id);
      if ((!/^\d+$/.test(id) && id !== 'UNRESOLVED') || seen.has(id)) throw invalid('INVALID_EVIDENCE', 'Unique canonical numeric IDs required');
      seen.add(id); finite(member.value, 'VIN count');
      if (!Number.isInteger(member.value) || member.value < 0) throw invalid('INVALID_EVIDENCE', 'Non-negative integer VIN counts required');
      sum += member.value; if (id === 'UNRESOLVED') unresolvedValue += member.value;
    }
    if (sum !== e.coverage?.filtered_n || unresolvedValue !== e.coverage?.dimension_unresolved_n
      || sum - unresolvedValue !== e.coverage?.dimension_resolved_n) {
      throw invalid('INVARIANT_VIOLATION', 'P1 member and identity coverage totals must reconcile');
    }
    if (unresolvedValue > 0) unresolved.push({ period: month, value: unresolvedValue, evidence_id: e.evidence_id });
    const member = members.find(r => String(r.member_id) === memberId);
    const value = member?.value ?? null;
    byMonth.set(month, { period_identity: month, value, evidence_id: e.evidence_id,
      member_label: member?.member_label ?? null,
      observation_state: value == null ? 'NOT_OBSERVED' : value === 0 ? 'ZERO_SALES_ACTIVITY_UNVERIFIED' : 'OBSERVED_POSITIVE' });
    refs.push({ slot, evidence_id: e.evidence_id, evidence_contract: e.evidence_contract,
      evidence_version: e.evidence_version, cutoff: e.temporal.cutoff, lineage: e.lineage });
  }
  const missing = [];
  for (let month = '2021-01'; month <= period; month = shiftMonth(month, 1)) if (!byMonth.has(month)) missing.push(month);
  const observations = [...byMonth.values()].sort((a, b) => a.period_identity.localeCompare(b.period_identity));
  const identityCoverage = dimension === 'MODEL'
    ? modelIdentityCoverage(observations, unresolved, period, missing) : null;
  return { config, observations, missing,
    unresolved: identityCoverage ? identityCoverage.relevant_unresolved_periods.map(({ affected_statistical_periods, ...row }) => row) : unresolved,
    identityCoverage, refs: refs.sort((a, b) => a.slot.localeCompare(b.slot)),
    current: byMonth.get(period) ?? null,
    memberLabel: [...observations].reverse().find(r => r.member_label != null)?.member_label ?? null };
}
