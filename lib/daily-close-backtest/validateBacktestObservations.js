import { monthDays } from './monthRange.js';

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isMonthEnd(row) {
  return row.day_of_month === monthDays(row.target_month);
}

export function validateBacktestObservations(result) {
  const company = result.companyObservations || [];
  const stores = result.storeObservations || [];
  const sellers = result.sellerObservations || [];
  const monthCoverage = result.monthCoverage || [];

  const validations = {
    company_grain_unique: uniqueBy(company, (r) => `${r.target_month}|${r.cutoff_date}`),
    store_grain_unique: uniqueBy(stores, (r) => `${r.target_month}|${r.cutoff_date}|${r.sucursal_id}`),
    seller_grain_unique: uniqueBy(
      sellers, (r) => `${r.target_month}|${r.cutoff_date}|${r.sucursal_id}|${r.persona_id}`,
    ),
    cutoff_belongs_to_target_month: [...company, ...stores, ...sellers]
      .every((r) => r.cutoff_date.slice(0, 7) === r.target_month),
    company_nonnegative: company.every((r) => r.observed_to_date >= 0 && r.actual_close >= 0),
    store_nonnegative: stores.every((r) => r.observed_to_date >= 0 && r.actual_close > 0),
    seller_nonnegative: sellers.every((r) => r.observed_to_date >= 0 && r.actual_close > 0),
    company_observed_le_actual: company.every((r) => r.observed_to_date <= r.actual_close),
    store_observed_le_actual: stores.every((r) => r.observed_to_date <= r.actual_close),
    seller_observed_le_actual: sellers.every((r) => r.observed_to_date <= r.actual_close),
    company_month_end_equals_close: company.filter(isMonthEnd).every((r) => r.observed_to_date === r.actual_close),
    store_month_end_equals_close: stores.filter(isMonthEnd).every((r) => r.observed_to_date === r.actual_close),
    seller_month_end_equals_close: sellers.filter(isMonthEnd).every((r) => r.observed_to_date === r.actual_close),
    month_end_store_identity_complete: monthCoverage.every(
      (r) => r.month_end_unresolved_store === 0 && r.month_end_ambiguous_store === 0,
    ),
    month_end_channels_complete: monthCoverage.every((r) => r.month_end_unknown_channel === 0),
    no_negative_store_state: monthCoverage.every((r) => !r.negative_store_state_seen),
    no_negative_seller_state: monthCoverage.every((r) => !r.negative_seller_state_seen),
    company_store_close_reconciles: monthCoverage.every(
      (r) => r.company_actual_close === r.eligible_store_close_sum,
    ),
    eligible_seller_close_not_above_store: monthCoverage.every(
      (r) => r.eligible_seller_close_sum <= r.eligible_store_close_sum,
    ),
  };

  return { validations, ok: Object.values(validations).every(Boolean) };
}
