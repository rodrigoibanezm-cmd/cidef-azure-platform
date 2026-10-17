import { buildBacktestObservations } from '../daily-close-backtest/buildBacktestObservations.js';
import { buildDailySnapshots } from '../daily-close-backtest/buildDailySnapshots.js';
import { buildRecognitionEvents } from '../daily-close-backtest/buildRecognitionEvents.js';
import { assertClosedRange } from '../daily-close-backtest/monthRange.js';
import { validateBacktestObservations } from '../daily-close-backtest/validateBacktestObservations.js';
import { buildVentasHistoricalTimeline } from '../ventas-universe/buildVentasHistoricalTimeline.js';

export const ENGINE_NAME = 'daily_close_backtest_context_v01';
export const ENGINE_VERSION = '0.3';

export function calculateDailyCloseBacktestContextFromTimeline(timeline, identityMaps, input, now = new Date(), sourceRows = null) {
  const startMonth = input?.start_month;
  const endMonth = input?.end_month;
  const months = assertClosedRange(startMonth, endMonth, now);
  const snapshots = buildDailySnapshots(timeline.events, identityMaps, months);
  const built = buildBacktestObservations(snapshots);
  const checked = validateBacktestObservations(built);
  const warnings = [];

  if (timeline.tie_groups_resolved > 0) {
    warnings.push(`${timeline.tie_groups_resolved} exact fecha_factura tie groups resolved with lowest stable id`);
  }
  for (const [name, value] of Object.entries(checked.validations)) {
    if (!value) warnings.push(`Validation failed: ${name}`);
  }

  return {
    engine: ENGINE_NAME,
    version: ENGINE_VERSION,
    status: checked.ok ? 'ok' : 'warning',
    inputs: { start_month: startMonth, end_month: endMonth },
    policy: {
      recognition: 'certified multi-cutoff timeline; incremental cutoff-safe LAST-by-VIN',
      organization: "certified commercial destination from ventas_universe historical timeline; seller membership remains date-effective",
      company_grain: 'target_month + cutoff_date',
      store_grain: 'target_month + cutoff_date + sucursal_id',
      seller_grain: 'target_month + cutoff_date + observed sucursal_id + VENDEDOR_CIDEF persona_id',
      store_evaluation_cohort: "month-end CIDEF stores with actual_close > 0",
      seller_evaluation_cohort: 'month-end VENDEDOR_CIDEF units with actual_close > 0',
      zero_semantics: 'absent daily row inside eligible store-month => CERTIFIED_ZERO',
      unknown_semantics: 'store-month without positive month-end label is not emitted',
      label_role: 'actual_close is LABEL_ONLY and never current-month predictor input',
      persistence: 'runtime only',
    },
    coverage: {
      source_rows: sourceRows,
      months_requested: months.length,
      first_month: months[0] ?? null,
      last_month: months.at(-1) ?? null,
      tie_groups_resolved: timeline.tie_groups_resolved,
      ...built.counts,
      month_end: built.monthCoverage,
    },
    validation: {
      closed_months_only: true,
      no_future_evidence_in_observed_to_date: true,
      ...checked.validations,
    },
    warnings,
    company_observations: built.companyObservations,
    store_observations: built.storeObservations,
    seller_observations: built.sellerObservations,
    lineage: timeline.timeline ? { universe_timeline: timeline.timeline } : null,
  };
}

export function calculateDailyCloseBacktestContext(rows, identityMaps, input, now = new Date()) {
  const startMonth = input?.start_month;
  const endMonth = input?.end_month;
  const timeline = buildRecognitionEvents(rows, startMonth, endMonth);
  return calculateDailyCloseBacktestContextFromTimeline(timeline, identityMaps, input, now, (rows || []).length);
}

export async function dailyCloseBacktestContextV01(input = {}) {
  const startMonth = input?.start_month;
  const endMonth = input?.end_month;
  assertClosedRange(startMonth, endMonth);
  const timeline = await buildVentasHistoricalTimeline(startMonth, endMonth);
  return calculateDailyCloseBacktestContextFromTimeline(
    timeline,
    timeline.resources.organization,
    input,
    new Date(),
    timeline.source_rows,
  );
}
