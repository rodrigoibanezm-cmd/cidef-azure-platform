import { shiftMonth } from '../expectation/monthSeries.js';
import { buildVentasMonthlyAnalyticalContext } from '../ventas-universe/buildVentasMonthlyAnalyticalContext.js';

export const ENGINE_NAME = 'ventas_monthly_actual_v01';
export const ENGINE_VERSION = '0.1';

function validateInput(input) {
  const cutoffMonth = String(input?.cutoff_month || '');
  const targetMonth = String(input?.target_month || '');
  if (!shiftMonth(cutoffMonth, 0)) throw new Error('Invalid cutoff_month; expected YYYY-MM');
  if (!shiftMonth(targetMonth, 0)) throw new Error('Invalid target_month; expected YYYY-MM');
  if (targetMonth > cutoffMonth) throw new Error('target_month must be <= cutoff_month');
  return { cutoffMonth, targetMonth };
}

export function calculateVentasMonthlyActual(context, { cutoffMonth, targetMonth }) {
  if (context?.cutoff_month !== cutoffMonth) {
    throw new Error('ventas context cutoff does not match requested cutoff_month');
  }
  const row = (context.monthlySales || []).find((item) => item.month === targetMonth);
  return {
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    status: context.validation?.ok && row ? 'ok' : 'warning',
    inputs: { cutoff_month: cutoffMonth, target_month: targetMonth },
    policy: {
      recognition: 'ventas_context_v01 LAST-by-VIN inside cutoff',
      temporal_guard: 'cutoff applied before VIN recognition; evidence after cutoff is excluded',
    },
    actual: { month: targetMonth, sales: row?.sales ?? null },
    coverage: context.coverage,
    validation: {
      ventas_context_ok: context.validation?.ok === true,
      target_within_cutoff: targetMonth <= cutoffMonth,
      cutoff_context_match: context.cutoff_month === cutoffMonth,
      target_month_present: Boolean(row),
      no_post_cutoff_evidence_used: true,
    },
    warnings: context.warnings || [],
  };
}

export async function ventasMonthlyActualV01(input = {}) {
  const parsed = validateInput(input);
  const context = await buildVentasMonthlyAnalyticalContext({ cutoffMonth: parsed.cutoffMonth });
  return calculateVentasMonthlyActual(context, parsed);
}
