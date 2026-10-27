import { shiftMonth } from '../expectation/monthSeries.js';

function adverse(row, method) {
  if (method === 'relative') return row.deviations.relative != null && row.deviations.relative < 0;
  if (method === 'scaled_mad') return row.deviations.scaled_mad != null && row.deviations.scaled_mad < 0;
  if (method === 'historical_percentile') {
    const value = row.deviations.historical_percentile;
    return value != null && value < 0.5;
  }
  return false;
}

function tail(rows, size) {
  return rows.length >= size ? rows.slice(-size) : null;
}

function contiguous(window) {
  if (!window) return false;
  for (let i = 1; i < window.length; i += 1) {
    if (shiftMonth(window[i - 1].month, 1) !== window[i].month) return false;
  }
  return true;
}

function result(window) {
  return { onset_month: window[0].month, evidence_months: window.map((row) => row.month) };
}

export function evaluatePersistence(rule, rows, method) {
  let match = /^consecutive_(\d+)$/.exec(rule);
  if (match) {
    const window = tail(rows, Number(match[1]));
    return contiguous(window) && window.every((row) => adverse(row, method)) ? result(window) : null;
  }
  match = /^frequency_(\d+)_of_(\d+)$/.exec(rule);
  if (match) {
    const need = Number(match[1]);
    const window = tail(rows, Number(match[2]));
    if (!contiguous(window)) return null;
    const hits = window.filter((row) => adverse(row, method));
    if (hits.length < need || !adverse(window.at(-1), method)) return null;
    return { onset_month: hits[0].month, evidence_months: hits.map((row) => row.month) };
  }
  match = /^deepening_(\d+)$/.exec(rule);
  if (match) {
    const window = tail(rows, Number(match[1]));
    if (!contiguous(window) || !window.every((row) => adverse(row, method))) return null;
    for (let i = 1; i < window.length; i += 1) {
      if (!(window[i].deviations.error < window[i - 1].deviations.error)) return null;
    }
    return result(window);
  }
  throw new Error(`Unknown persistence rule: ${rule}`);
}

export function isAdverse(row, method) {
  return adverse(row, method);
}
