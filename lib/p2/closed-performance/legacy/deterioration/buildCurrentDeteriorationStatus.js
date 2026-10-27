import { shiftMonth } from '../expectation/monthSeries.js';
import { evaluatePersistence, isAdverse } from './orgPersistence.js';
import { DETERIORATION_STATUS_RULE } from './deteriorationStatusInput.js';

const { baseline: BASELINE, deviation: METHOD, persistence: RULE } = DETERIORATION_STATUS_RULE;

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.baseline !== BASELINE) continue;
    const key = String(row.unit_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) group.sort((a, b) => a.month.localeCompare(b.month));
  return groups;
}

function evidenceRow(row) {
  if (!row) return null;
  return {
    month: row.month,
    sales: row.sales,
    baseline: row.baseline_value,
    error: row.deviations.error,
    historical_percentile: row.deviations.historical_percentile ?? null,
    adverse: isAdverse(row, METHOD),
  };
}

function activeEpisode(group) {
  let segment = [];
  let active = null;
  for (const row of group) {
    if (segment.length && shiftMonth(segment.at(-1).month, 1) !== row.month) {
      segment = [];
      active = null;
    }
    segment.push(row);
    const evidence = evaluatePersistence(RULE, segment, METHOD);
    if (evidence && !active) {
      active = {
        onset_month: evidence.onset_month,
        confirmation_month: row.month,
        evidence_months: evidence.evidence_months,
      };
    } else if (!evidence && !isAdverse(row, METHOD)) {
      active = null;
    }
  }
  return active;
}

function observationState(unit, cutoffMonth) {
  if (!unit.months.has(cutoffMonth)) return 'UNKNOWN';
  return unit.months.get(cutoffMonth) === 0 ? 'ACTIVE_ZERO' : 'OBSERVED_POSITIVE';
}

function baseStatus(unit, status, reason, cutoffMonth) {
  return {
    unit_id: unit.unit_id,
    unit_label: unit.unit_label,
    status,
    status_reason: reason,
    observation_state: observationState(unit, cutoffMonth),
    current: null,
    onset_month: null,
    confirmation_month: null,
    persistence_rows: [],
  };
}

function statusForUnit(unit, group, cutoffMonth) {
  if (!unit.months.has(cutoffMonth)) return baseStatus(unit, 'UNKNOWN', 'UNKNOWN_ACTUAL', cutoffMonth);
  const current = group.find((row) => row.month === cutoffMonth) || null;
  if (!current) return baseStatus(unit, 'UNKNOWN', 'BASELINE_UNAVAILABLE', cutoffMonth);
  if (current.deviations.historical_percentile == null) {
    return { ...baseStatus(unit, 'UNKNOWN', 'DEVIATION_UNAVAILABLE', cutoffMonth), current: evidenceRow(current) };
  }
  const active = activeEpisode(group);
  const byMonth = new Map(group.map((row) => [row.month, row]));
  return {
    ...baseStatus(unit, active ? 'DETERIORATING' : 'NOT_DETERIORATING', active ? 'ACTIVE_EPISODE' : 'NO_ACTIVE_EPISODE', cutoffMonth),
    current: evidenceRow(current),
    onset_month: active?.onset_month ?? null,
    confirmation_month: active?.confirmation_month ?? null,
    persistence_rows: (active?.evidence_months || []).map((month) => evidenceRow(byMonth.get(month))),
  };
}

export function buildCurrentDeteriorationStatus(rows, units, cutoffMonth) {
  const groups = groupRows(rows);
  const statuses = [...units.values()].map((unit) => (
    statusForUnit(unit, groups.get(String(unit.unit_id)) || [], cutoffMonth)
  )).sort((a, b) => String(a.unit_label).localeCompare(String(b.unit_label)));
  const counts = { DETERIORATING: 0, NOT_DETERIORATING: 0, UNKNOWN: 0 };
  for (const row of statuses) counts[row.status] += 1;
  return { statuses, counts };
}
