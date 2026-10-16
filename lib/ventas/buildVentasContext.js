import { buildMonthlySales } from './buildMonthlySales.js';
import { filterVentasRowsThroughCutoff } from './filterVentasRowsThroughCutoff.js';
import { loadVentasRows } from './loadVentasRows.js';
import { resolveVentasRecognition } from './resolveVentasRecognition.js';
import { validateVentasContext } from './validateVentasContext.js';

export const CONTEXT_NAME = 'ventas_context_v01';
export const CONTEXT_VERSION = '0.5';

const POLICY = Object.freeze({
  non_null_vin: 'one recognized sale per VIN using LAST fecha_factura inside available cutoff',
  null_vin: 'one recognized sale per row when fecha_factura is parseable',
  commercial_month: 'YYYY-MM follows the calendar month from day 01 through calendar month end',
  temporal_guard: 'cutoff is applied before VIN recognition; cutoff_month closes on calendar month end',
  invalid_non_null_vin_date: 'exclude entire VIN when any included row has invalid/missing fecha_factura',
  exact_last_tie: 'lowest stable id; technical tie-break only',
  persistence: 'runtime only; no table or materialized layer',
});

export function calculateVentasContext(
  rows,
  { cutoffMonth = null, cutoffDate = null } = {},
) {
  const filtered = filterVentasRowsThroughCutoff(rows, { cutoffMonth, cutoffDate });
  const { recognizedSales, stats } = resolveVentasRecognition(filtered.rows);
  const monthlySales = buildMonthlySales(recognizedSales);
  const { validation, warnings } = validateVentasContext(recognizedSales, monthlySales, stats);

  return {
    context: CONTEXT_NAME,
    version: CONTEXT_VERSION,
    policy: POLICY,
    cutoff_month: filtered.cutoff.type === 'month' ? filtered.cutoff.value : null,
    cutoff_date: filtered.cutoff.type === 'date' ? filtered.cutoff.value : null,
    effective_cutoff_date: filtered.cutoff.type === 'month' ? filtered.cutoff.end_date : filtered.cutoff.value,
    effective_cutoff_month: filtered.cutoff.type === 'month' ? filtered.cutoff.value : null,
    coverage: {
      source_rows: rows.length,
      rows_inside_cutoff: filtered.rows.length,
      rows_excluded_by_cutoff: filtered.excluded,
      ...stats,
    },
    recognizedSales,
    monthlySales,
    validation,
    warnings,
  };
}

export async function buildVentasContext(options = {}) {
  const rows = await loadVentasRows();
  return calculateVentasContext(rows, options);
}
