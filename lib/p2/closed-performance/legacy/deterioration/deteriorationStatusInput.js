import { shiftMonth } from '../expectation/monthSeries.js';

const ALLOWED_KEYS = new Set(['cutoff_month']);

export const DETERIORATION_STATUS_RULE = Object.freeze({
  grain: 'tienda',
  baseline: 'moving_average_12',
  deviation: 'historical_percentile',
  persistence: 'deepening_2',
});

function currentMonthSantiago(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

export function parseDeteriorationStatusInput(input = {}, now = new Date()) {
  const unsupported = Object.keys(input).filter((key) => !ALLOWED_KEYS.has(key));
  if (unsupported.length) {
    throw new Error(`Unsupported input(s) for org_sales_deterioration_status_v01: ${unsupported.join(', ')}`);
  }
  const cutoffMonth = String(input.cutoff_month || '');
  if (!shiftMonth(cutoffMonth, 0)) throw new Error('cutoff_month must use YYYY-MM');
  if (cutoffMonth >= currentMonthSantiago(now)) {
    throw new Error('cutoff_month must be a closed calendar month in America/Santiago');
  }
  return {
    grain: DETERIORATION_STATUS_RULE.grain,
    startMonth: cutoffMonth,
    endMonth: cutoffMonth,
    baselines: [DETERIORATION_STATUS_RULE.baseline],
    deviations: [DETERIORATION_STATUS_RULE.deviation],
    persistence: [DETERIORATION_STATUS_RULE.persistence],
    cutoffMonth,
  };
}
