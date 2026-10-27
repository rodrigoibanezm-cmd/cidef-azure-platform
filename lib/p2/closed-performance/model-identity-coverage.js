import { POLICY } from './classify.js';
import { shiftMonth } from './legacy/expectation/monthSeries.js';

// Structural coverage only: no identity allocation, imputed sales, deviation
// calculation or history truncation. An unresolved count might belong to any
// model, so its month is only an upper bound on possible positive presence.
export function modelIdentityCoverage(observations, unresolved, period, missing = []) {
  const window = month => Array.from({ length: POLICY.baseline_months + 1 },
    (_, offset) => shiftMonth(month, -offset));
  const possible = new Set([
    ...observations.filter(row => row.value > 0).map(row => row.period_identity),
    ...unresolved.map(row => row.period),
  ]);
  const currentPossible = window(period).every(month => possible.has(month));
  // Every earlier computable error can enter the empirical percentile, even
  // across gaps. Keep ALL potential rows, not just the current MA12 window.
  const formalWindows = [...possible].sort().map(month => ({
    month, dependencies: window(month),
  })).filter(row => row.dependencies.every(month => possible.has(month)));
  const relevant = [], excluded = [];
  for (const row of unresolved) {
    const affected = formalWindows.filter(candidate => candidate.dependencies.includes(row.period))
      .map(candidate => candidate.month);
    if (missing.length || affected.length) relevant.push({ ...row,
      affected_statistical_periods: affected });
    else excluded.push({ ...row, reason: 'OUTSIDE_ALL_POSSIBLE_STATISTICAL_ROWS' });
  }
  return {
    method: 'MODEL_STATISTICAL_DEPENDENCY_COVERAGE_V01',
    baseline_months: POLICY.baseline_months,
    analysis_complete: missing.length === 0,
    current_formal_row_possible: currentPossible,
    dependency_periods: [...new Set([...window(period),
      ...formalWindows.flatMap(row => row.dependencies)])].sort(),
    unresolved_source_periods: unresolved,
    relevant_unresolved_periods: relevant,
    excluded_unresolved_periods: excluded,
    history_truncated: false, allocated_unresolved_sales: false,
  };
}
