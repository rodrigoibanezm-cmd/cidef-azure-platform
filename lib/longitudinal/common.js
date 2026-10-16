const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_GRAINS = new Set(['MONTH', 'YEAR']);
const CUTOFF_MODES = new Set(['FULL_PERIOD', 'SAME_DAY']);

export function semanticError(code, detail = null) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export function normalizeEnum(value, allowed, code, fallback = null) {
  const normalized = value == null || value === '' ? fallback : String(value).trim().toUpperCase();
  if (!normalized || !allowed.has(normalized)) throw semanticError(code, String(value ?? 'missing'));
  return normalized;
}

export function validDate(value) {
  if (!DATE_RE.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function toIsoDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (validDate(text.slice(0, 10))) return text.slice(0, 10);
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

export function parseDateRange(input = {}) {
  const dateFrom = String(input.date_from || '');
  const dateTo = String(input.date_to || '');
  if (!validDate(dateFrom) || !validDate(dateTo)) throw semanticError('INVALID_DATE_RANGE');
  if (dateFrom > dateTo) throw semanticError('INVALID_DATE_RANGE', 'date_from must be <= date_to');
  return { dateFrom, dateTo };
}

export function parseTimeGrain(value) {
  return normalizeEnum(value, TIME_GRAINS, 'INVALID_TIME_GRAIN', 'MONTH');
}

export function parseCutoff(input = {}) {
  const cutoffMode = normalizeEnum(input.cutoff_mode, CUTOFF_MODES, 'INVALID_CUTOFF_MODE', 'FULL_PERIOD');
  const cutoffDate = input.cutoff_date == null || input.cutoff_date === '' ? null : String(input.cutoff_date);
  if (cutoffDate != null && !validDate(cutoffDate)) throw semanticError('INVALID_CUTOFF_DATE');
  return { cutoffMode, cutoffDate };
}

export function periodForDate(value, timeGrain) {
  const iso = String(value).slice(0, 10);
  return timeGrain === 'YEAR' ? iso.slice(0, 4) : iso.slice(0, 7);
}

export function enumeratePeriods(dateFrom, dateTo, timeGrain) {
  const periods = [];
  const cursor = new Date(`${dateFrom.slice(0, timeGrain === 'YEAR' ? 4 : 7)}${timeGrain === 'YEAR' ? '-01-01' : '-01'}T00:00:00.000Z`);
  const endPeriod = periodForDate(dateTo, timeGrain);
  while (periodForDate(cursor.toISOString(), timeGrain) <= endPeriod) {
    periods.push(periodForDate(cursor.toISOString(), timeGrain));
    if (timeGrain === 'YEAR') cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return periods;
}

export function withChanges(series, valueField = 'value') {
  return series.map((row, index) => {
    const current = row[valueField] == null ? null : Number(row[valueField]);
    const previous = index === 0 || series[index - 1][valueField] == null
      ? null : Number(series[index - 1][valueField]);
    return {
      ...row,
      absoluteChange: previous == null || current == null ? null : current - previous,
      pctChange: previous == null || current == null || previous === 0 ? null : (current - previous) / previous,
    };
  });
}

export function endOfPeriod(value, timeGrain) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (timeGrain === 'YEAR') return `${date.getUTCFullYear()}-12-31`;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export function comparisonPosition(value, timeGrain) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (timeGrain === 'YEAR') {
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    return Math.floor((date.getTime() - start) / 86400000) + 1;
  }
  return date.getUTCDate();
}

export function dateWithinComparableCutoff(value, parsed, comparisonDay) {
  const iso = String(value).slice(0, 10);
  if (iso < parsed.dateFrom || iso > parsed.dateTo) return false;
  if (parsed.cutoffDate && iso > parsed.cutoffDate) return false;
  if (parsed.cutoffMode !== 'SAME_DAY' || comparisonDay == null) return true;
  return comparisonPosition(iso, parsed.timeGrain) <= comparisonDay;
}

export function buildTemporalSemantics(parsed, lastObservedDate = null) {
  const observed = toIsoDate(lastObservedDate);
  const candidates = observed ? [parsed.dateTo, parsed.cutoffDate, observed].filter(Boolean).sort() : [];
  const effectiveDateTo = candidates[0] ?? null;
  const comparisonDay = parsed.cutoffMode === 'SAME_DAY'
    ? comparisonPosition(parsed.cutoffDate || effectiveDateTo, parsed.timeGrain) : null;
  const lastPeriodComplete = effectiveDateTo != null
    && effectiveDateTo >= endOfPeriod(parsed.dateTo, parsed.timeGrain);
  return {
    requestedDateFrom: parsed.dateFrom,
    requestedDateTo: parsed.dateTo,
    effectiveDateFrom: parsed.dateFrom,
    effectiveDateTo,
    lastObservedDate: observed,
    lastPeriodComplete,
    cutoffMode: parsed.cutoffMode,
    ...(comparisonDay == null ? {} : { comparisonDay }),
  };
}

export function coverageRow(dimension, counts = {}) {
  const resolved = Number(counts.resolved || 0);
  const unresolved = Number(counts.unresolved || 0);
  const ambiguous = Number(counts.ambiguous || 0);
  const notApplicable = Number(counts.notApplicable || 0);
  const total = Number(counts.total ?? resolved + unresolved + ambiguous + notApplicable);
  return {
    dimension, resolved, unresolved, ambiguous, notApplicable, total,
    resolvedRatio: total === 0 ? null : resolved / total,
    unresolvedRatio: total === 0 ? null : unresolved / total,
    ambiguousRatio: total === 0 ? null : ambiguous / total,
    notApplicableRatio: total === 0 ? null : notApplicable / total,
  };
}

export function identityWarnings(dimensionCoverage = []) {
  const warnings = [];
  for (const row of dimensionCoverage) {
    const prefix = row.dimension.endsWith('_IDENTITY') ? row.dimension : `${row.dimension}_IDENTITY`;
    if (row.unresolved > 0) warnings.push(`${prefix}_UNRESOLVED_PRESENT`);
    if (row.ambiguous > 0) warnings.push(`${prefix}_AMBIGUOUS_PRESENT`);
  }
  return warnings;
}

export function temporalWarnings(temporalSemantics) {
  const warnings = [];
  if (!temporalSemantics.lastPeriodComplete) warnings.push('LAST_PERIOD_INCOMPLETE');
  if (temporalSemantics.lastObservedDate
    && temporalSemantics.requestedDateTo > temporalSemantics.lastObservedDate) {
    warnings.push('REQUESTED_DATE_TO_AFTER_LAST_OBSERVED_DATE');
  }
  if (!temporalSemantics.lastObservedDate) warnings.push('NO_OBSERVED_EVIDENCE_IN_RANGE');
  return warnings;
}

export function parseFilterObject(filters, supported) {
  if (filters == null) return {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw semanticError('INVALID_FILTER');
  const output = {};
  for (const [key, raw] of Object.entries(filters)) {
    if (!supported.has(key)) throw semanticError('UNSUPPORTED_FILTER', key);
    const values = Array.isArray(raw) ? raw : [raw];
    const cleaned = [...new Set(values.filter((value) => value != null && String(value).trim() !== '').map((value) => String(value).trim()))];
    if (!cleaned.length) throw semanticError('INVALID_FILTER', key);
    output[key] = cleaned;
  }
  return output;
}

export function filterMatches(value, accepted) {
  if (!accepted) return true;
  const normalized = value == null ? null : String(value).trim().toUpperCase();
  return accepted.some((candidate) => String(candidate).trim().toUpperCase() === normalized);
}

export function outputEnvelope({
  motor, domain, parsed, series, seriesByBreakdown = null, temporalSemantics,
  coverage = { dimensionCoverage: [] }, warnings = [], metadata = {},
}) {
  return {
    motor,
    version: '0.2',
    domain,
    metric: parsed.metric,
    grain: parsed.grain,
    timeGrain: parsed.timeGrain,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    filters: parsed.filters || {},
    series,
    breakdown: parsed.breakdown,
    ...(seriesByBreakdown ? { seriesByBreakdown } : {}),
    temporalSemantics,
    coverage,
    warnings,
    metadata: {
      persistence: 'NONE',
      execution: 'ON_DEMAND',
      interpretation: 'NONE',
      ...metadata,
    },
  };
}
