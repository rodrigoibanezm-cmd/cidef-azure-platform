import { average, getSeries, shiftMonth } from './monthSeries.js';

export function expectedLastYear(index, month) {
  const prior = shiftMonth(month, -12);
  return prior && index.has(prior) ? index.get(prior) : null;
}

export function expectedMovingAverage(index, month, window) {
  const offsets = Array.from({ length: window }, (_, i) => -(i + 1));
  const values = getSeries(index, month, offsets);
  return values ? average(values) : null;
}

export function expectedAdjustedLastYear(index, month, levelMonths = 3) {
  const base = expectedLastYear(index, month);
  if (base == null) return null;

  const recentOffsets = Array.from({ length: levelMonths }, (_, i) => -(i + 1));
  const priorOffsets = recentOffsets.map((offset) => offset - 12);
  const recent = getSeries(index, month, recentOffsets);
  const prior = getSeries(index, month, priorOffsets);
  if (!recent || !prior) return null;

  const recentAvg = average(recent);
  const priorAvg = average(prior);
  if (priorAvg == null || priorAvg === 0) return null;
  return base * (recentAvg / priorAvg);
}

export const EXPECTATION_CANDIDATES = Object.freeze({
  last_year: (index, month) => expectedLastYear(index, month),
  moving_average_3: (index, month) => expectedMovingAverage(index, month, 3),
  moving_average_6: (index, month) => expectedMovingAverage(index, month, 6),
  adjusted_last_year: (index, month) => expectedAdjustedLastYear(index, month, 3),
});

export const EXPECTATION_CANDIDATE_METADATA = Object.freeze({
  last_year: Object.freeze({ definition: 'same STORE x BRAND calendar month one year earlier', required_history_months: 12 }),
  moving_average_3: Object.freeze({ definition: 'mean of the prior three STORE x BRAND months', required_history_months: 3 }),
  moving_average_6: Object.freeze({ definition: 'mean of the prior six STORE x BRAND months', required_history_months: 6 }),
  adjusted_last_year: Object.freeze({ definition: 'last-year month adjusted by the certified recent-versus-prior level', required_history_months: 15 }),
});
