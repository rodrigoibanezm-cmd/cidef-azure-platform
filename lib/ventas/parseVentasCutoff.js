import { shiftMonth } from '../expectation/monthSeries.js';
import { commercialMonthRange } from './commercialMonth.js';

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function parseCutoffDate(value) {
  const raw = String(value || '');
  if (!DATE_RE.test(raw)) throw new Error('cutoff_date must use valid YYYY-MM-DD format');

  const [year, month, day] = raw.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  if (
    end.getUTCFullYear() !== year ||
    end.getUTCMonth() !== month - 1 ||
    end.getUTCDate() !== day
  ) throw new Error('cutoff_date must use valid YYYY-MM-DD format');

  return { type: 'date', value: raw, end };
}

export function parseVentasCutoff({ cutoffMonth = null, cutoffDate = null } = {}) {
  if (cutoffMonth != null && cutoffDate != null) {
    throw new Error('use cutoff_month or cutoff_date, not both');
  }
  if (cutoffMonth != null) {
    const value = String(cutoffMonth);
    if (shiftMonth(value, 0) !== value) throw new Error('cutoff_month must use YYYY-MM format');
    const range = commercialMonthRange(value);
    return { type: 'month', value, end: range.end, end_date: range.end_date };
  }
  if (cutoffDate != null) return parseCutoffDate(cutoffDate);
  return { type: 'none', value: null };
}
