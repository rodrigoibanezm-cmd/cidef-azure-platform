import { neon } from '@neondatabase/serverless';

export const ENGINE_NAME = 'ventas_monthly_dedup_sensitivity_v01';
export const ENGINE_VERSION = '0.1';

function db() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('Missing Neon DATABASE_URL');
  return neon(url);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const CANONICAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function parseFechaFactura(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  const canonical = CANONICAL_DATE_RE.exec(raw);
  const match = canonical ?? DATE_RE.exec(raw);
  if (!match) return { error: 'unsupported_format', raw };

  const month = Number(match[canonical ? 2 : 1]);
  const day = Number(match[canonical ? 3 : 2]);
  const yearRaw = Number(match[canonical ? 1 : 3]);
  const year = !canonical && match[3].length === 2 ? 2000 + yearRaw : yearRaw;
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return { error: 'invalid_date', raw };
  }

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) return { error: 'invalid_date', raw };

  return { date, month: `${year}-${String(month).padStart(2, '0')}`, raw };
}

function assertMonth(value, name) {
  if (!MONTH_RE.test(String(value || ''))) throw new Error(`${name} must use YYYY-MM`);
  return String(value);
}

function monthRange(startMonth, endMonth) {
  const [sy, sm] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
  const start = sy * 12 + sm - 1;
  const end = ey * 12 + em - 1;
  if (end < start) throw new Error('end_month must be >= start_month');
  const months = [];
  for (let cursor = start; cursor <= end; cursor += 1) {
    const year = Math.floor(cursor / 12);
    const month = (cursor % 12) + 1;
    months.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return months;
}

const pct = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
const avg = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

function normalizedVin(value) {
  if (value == null) return null;
  const vin = String(value).trim();
  return vin === '' ? null : vin;
}

export function calculateVentasMonthlyDedupSensitivity(rows, input) {
  const startMonth = assertMonth(input?.start_month, 'start_month');
  const endMonth = assertMonth(input?.end_month, 'end_month');
  const requestedMonths = monthRange(startMonth, endMonth);

  const vinStats = new Map();
  const nullVinMonths = new Map();
  let parseableRows = 0;
  let unparseableRows = 0;
  let nullFechaRows = 0;
  let nonNullVinRows = 0;
  let nullVinRows = 0;
  let unassignableNullVinRows = 0;
  const warnings = [];

  for (const row of rows) {
    const vin = normalizedVin(row.nro_vin_chasis);
    if (vin == null) nullVinRows += 1;
    else nonNullVinRows += 1;

    if (vin != null && !vinStats.has(vin)) vinStats.set(vin, { count: 0, first: null, last: null, dateError: false });
    if (vin != null) vinStats.get(vin).count += 1;

    const parsed = parseFechaFactura(row.fecha_factura);
    if (parsed == null) {
      nullFechaRows += 1;
      if (vin == null) unassignableNullVinRows += 1;
      else vinStats.get(vin).dateError = true;
      continue;
    }
    if (parsed.error) {
      unparseableRows += 1;
      if (vin == null) unassignableNullVinRows += 1;
      else vinStats.get(vin).dateError = true;
      continue;
    }
    parseableRows += 1;

    if (vin == null) {
      nullVinMonths.set(parsed.month, (nullVinMonths.get(parsed.month) || 0) + 1);
      continue;
    }

    const current = vinStats.get(vin);
    if (!current.first || parsed.date < current.first.date) current.first = parsed;
    if (!current.last || parsed.date > current.last.date) current.last = parsed;
  }

  const vinsWithDateErrors = [...vinStats.values()].filter((v) => v.dateError).length;
  if (nullFechaRows) warnings.push(`${nullFechaRows} rows have null/blank fecha_factura`);
  if (unparseableRows) warnings.push(`${unparseableRows} rows have unparseable fecha_factura`);
  if (vinsWithDateErrors) warnings.push(`${vinsWithDateErrors} non-null VINs have at least one invalid/missing fecha_factura and were excluded from FIRST/LAST assignment`);
  if (unassignableNullVinRows) warnings.push(`${unassignableNullVinRows} null-VIN rows have invalid/missing fecha_factura and were not assignable to a month`);

  const firstCounts = new Map(nullVinMonths);
  const lastCounts = new Map(nullVinMonths);
  const transfers = new Map();
  let vinsSingleOccurrence = 0;
  let vinsMultipleOccurrences = 0;
  let vinsSameFirstLastMonth = 0;
  let vinsWithDifferentFirstLastMonth = 0;
  let assignableNonNullVins = 0;

  for (const vin of vinStats.values()) {
    if (vin.count === 1) vinsSingleOccurrence += 1;
    else vinsMultipleOccurrences += 1;
    if (vin.dateError || !vin.first || !vin.last) continue;
    assignableNonNullVins += 1;
    if (vin.first.month === vin.last.month) vinsSameFirstLastMonth += 1;
    else {
      vinsWithDifferentFirstLastMonth += 1;
      const key = `${vin.first.month}|${vin.last.month}`;
      transfers.set(key, (transfers.get(key) || 0) + 1);
    }
    firstCounts.set(vin.first.month, (firstCounts.get(vin.first.month) || 0) + 1);
    lastCounts.set(vin.last.month, (lastCounts.get(vin.last.month) || 0) + 1);
  }

  const monthly = requestedMonths.map((month) => {
    const salesFirst = firstCounts.get(month) || 0;
    const salesLast = lastCounts.get(month) || 0;
    const deltaSigned = salesLast - salesFirst;
    const deltaAbs = Math.abs(deltaSigned);
    return {
      month,
      sales_first: salesFirst,
      sales_last: salesLast,
      delta_signed: deltaSigned,
      delta_abs: deltaAbs,
      delta_pct: pct(deltaAbs, salesFirst),
      yoy_first_abs: null,
      yoy_first_pct: null,
      yoy_last_abs: null,
      yoy_last_pct: null,
      yoy_delta_between_scenarios: null,
    };
  });

  const monthIndex = new Map(monthly.map((row, index) => [row.month, index]));
  for (const row of monthly) {
    const [year, month] = row.month.split('-').map(Number);
    const prior = monthly[monthIndex.get(`${year - 1}-${String(month).padStart(2, '0')}`)];
    if (!prior) continue;
    row.yoy_first_abs = row.sales_first - prior.sales_first;
    row.yoy_first_pct = prior.sales_first === 0 ? null : row.sales_first / prior.sales_first - 1;
    row.yoy_last_abs = row.sales_last - prior.sales_last;
    row.yoy_last_pct = prior.sales_last === 0 ? null : row.sales_last / prior.sales_last - 1;
    row.yoy_delta_between_scenarios = row.yoy_last_pct == null || row.yoy_first_pct == null
      ? null
      : row.yoy_last_pct - row.yoy_first_pct;
  }

  const deltasAbs = monthly.map((row) => row.delta_abs);
  const deltasPct = monthly.map((row) => row.delta_pct).filter((value) => value != null);
  const maxAbsRow = monthly.reduce((best, row) => (!best || row.delta_abs > best.delta_abs ? row : best), null);
  const maxPctRow = monthly.reduce((best, row) => row.delta_pct != null && (!best || row.delta_pct > best.delta_pct) ? row : best, null);

  const totalUnitsFirstGlobal = [...firstCounts.values()].reduce((sum, value) => sum + value, 0);
  const totalUnitsLastGlobal = [...lastCounts.values()].reduce((sum, value) => sum + value, 0);
  const expectedUnitsRaw = vinStats.size + nullVinRows;
  const expectedUnitsAssignable = assignableNonNullVins + nullVinRows - unassignableNullVinRows;
  const globalSignedDelta = totalUnitsLastGlobal - totalUnitsFirstGlobal;
  const windowSignedDelta = monthly.reduce((sum, row) => sum + row.delta_signed, 0);

  if (totalUnitsFirstGlobal !== totalUnitsLastGlobal) warnings.push('FIRST/LAST global totals do not reconcile');
  if (expectedUnitsAssignable !== totalUnitsFirstGlobal) warnings.push('Assignable expected units do not reconcile with FIRST total');

  return {
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    status: warnings.length ? 'warning' : 'ok',
    inputs: { start_month: startMonth, end_month: endMonth },
    parser: {
      accepted_format: 'MM/DD/YY H:MI or MM/DD/YYYY H:MI, optional seconds',
      two_digit_year_policy: '2000 + YY',
      timezone_policy: 'UTC calendar validation; time never changes month assignment',
    },
    coverage: {
      source_rows: rows.length,
      parseable_fecha_factura_rows: parseableRows,
      unparseable_fecha_factura_rows: unparseableRows,
      null_fecha_factura_rows: nullFechaRows,
      non_null_vin_rows: nonNullVinRows,
      distinct_non_null_vins: vinStats.size,
      null_vin_rows: nullVinRows,
      duplicate_excess_rows: nonNullVinRows - vinStats.size,
      vins_with_date_errors: vinsWithDateErrors,
      unassignable_null_vin_rows: unassignableNullVinRows,
    },
    duplicate_analysis: {
      vins_single_occurrence: vinsSingleOccurrence,
      vins_multiple_occurrences: vinsMultipleOccurrences,
      vins_same_first_last_month: vinsSameFirstLastMonth,
      vins_with_different_first_last_month: vinsWithDifferentFirstLastMonth,
    },
    summary: {
      months_observed: monthly.length,
      average_absolute_difference: avg(deltasAbs),
      average_absolute_percentage_difference: avg(deltasPct),
      max_absolute_difference: maxAbsRow?.delta_abs ?? null,
      max_absolute_difference_month: maxAbsRow?.month ?? null,
      max_percentage_difference: maxPctRow?.delta_pct ?? null,
      max_percentage_difference_month: maxPctRow?.month ?? null,
      months_with_any_difference: monthly.filter((row) => row.delta_abs > 0).length,
      months_over_1pct: monthly.filter((row) => row.delta_pct != null && row.delta_pct > 0.01).length,
      months_over_2pct: monthly.filter((row) => row.delta_pct != null && row.delta_pct > 0.02).length,
    },
    monthly,
    month_transfers: [...transfers.entries()]
      .map(([key, vinCount]) => {
        const [fromMonth, toMonth] = key.split('|');
        return { from_month: fromMonth, to_month: toMonth, vin_count: vinCount };
      })
      .sort((a, b) => a.from_month.localeCompare(b.from_month) || a.to_month.localeCompare(b.to_month)),
    validation: {
      total_units_first_global: totalUnitsFirstGlobal,
      total_units_last_global: totalUnitsLastGlobal,
      expected_units_raw: expectedUnitsRaw,
      expected_units_assignable: expectedUnitsAssignable,
      totals_match: totalUnitsFirstGlobal === totalUnitsLastGlobal,
      global_signed_delta: globalSignedDelta,
      window_signed_delta: windowSignedDelta,
    },
    warnings,
  };
}

export async function ventasMonthlyDedupSensitivityV01(input = {}) {
  const sql = db();
  const rows = await sql.query(`SELECT nro_vin_chasis, fecha_factura FROM ventas_raw`);
  return calculateVentasMonthlyDedupSensitivity(rows, input);
}
