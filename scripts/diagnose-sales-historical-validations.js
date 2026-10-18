import { appendFile } from 'node:fs/promises';
import { PERIOD_CLOSE_HISTORY_POLICY_V01 } from '../lib/data-floor/sales/contract.js';
import { closeAzurePool } from '../lib/azure-postgres.js';
import { dailyCloseBacktestContextV01 } from '../lib/motors/daily-close-backtest-context-v01.js';
import { monthDays } from '../lib/daily-close-backtest/monthRange.js';

const VALIDATION_KEYS = [
  'company_grain_unique',
  'store_grain_unique',
  'seller_grain_unique',
  'cutoff_belongs_to_target_month',
  'company_nonnegative',
  'store_nonnegative',
  'seller_nonnegative',
  'company_observed_le_actual',
  'store_observed_le_actual',
  'seller_observed_le_actual',
  'company_month_end_equals_close',
  'store_month_end_equals_close',
  'seller_month_end_equals_close',
  'month_end_store_identity_complete',
  'month_end_channels_complete',
  'no_negative_store_state',
  'no_negative_seller_state',
  'company_store_close_reconciles',
  'eligible_seller_close_not_above_store',
];

function previousClosedMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const index = year * 12 + month - 2;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function observationKey(row, key) {
  if (key === 'company_grain_unique') return `${row.target_month}|${row.cutoff_date}`;
  if (key === 'store_grain_unique') return `${row.target_month}|${row.cutoff_date}|${row.sucursal_id}`;
  return `${row.target_month}|${row.cutoff_date}|${row.sucursal_id}|${row.persona_id}`;
}

function duplicateRows(rows, key) {
  const seen = new Set();
  const duplicates = [];
  for (const row of rows) {
    const composite = observationKey(row, key);
    if (seen.has(composite)) duplicates.push(row);
    else seen.add(composite);
  }
  return duplicates;
}

function failedRows(context, key) {
  const observationSets = {
    company: context.company_observations,
    store: context.store_observations,
    seller: context.seller_observations,
  };
  const monthEnd = (row) => row.day_of_month === monthDays(row.target_month);
  if (key.endsWith('_grain_unique')) {
    const grain = key.startsWith('company_') ? 'company' : key.startsWith('store_') ? 'store' : 'seller';
    return duplicateRows(observationSets[grain] ?? [], key).map((row) => ({ ...row, diagnostic: 'duplicate_grain' }));
  }
  if (key === 'cutoff_belongs_to_target_month') {
    return Object.values(observationSets).flat()
      .filter((row) => row.cutoff_date.slice(0, 7) !== row.target_month)
      .map((row) => ({ target_month: row.target_month, cutoff_date: row.cutoff_date }));
  }
  if (key.endsWith('_nonnegative')) {
    const grain = key.startsWith('company_') ? 'company' : key.startsWith('store_') ? 'store' : 'seller';
    return (observationSets[grain] ?? []).filter((row) =>
      row.observed_to_date < 0 || (grain === 'company'
        ? row.actual_close < 0
        : row.actual_close <= 0));
  }
  if (key.endsWith('_observed_le_actual')) {
    const grain = key.startsWith('company_') ? 'company' : key.startsWith('store_') ? 'store' : 'seller';
    return (observationSets[grain] ?? []).filter((row) => row.observed_to_date > row.actual_close);
  }
  if (key.endsWith('_month_end_equals_close')) {
    const grain = key.startsWith('company_') ? 'company' : key.startsWith('store_') ? 'store' : 'seller';
    return (observationSets[grain] ?? []).filter((row) =>
      monthEnd(row) && row.observed_to_date !== row.actual_close);
  }
  const coverage = context.coverage.month_end ?? [];
  const predicates = {
    month_end_store_identity_complete: (row) =>
      row.month_end_unresolved_store !== 0 || row.month_end_ambiguous_store !== 0,
    month_end_channels_complete: (row) => row.month_end_unknown_channel !== 0,
    no_negative_store_state: (row) => row.negative_store_state_seen,
    no_negative_seller_state: (row) => row.negative_seller_state_seen,
    company_store_close_reconciles: (row) =>
      row.company_actual_close !== row.eligible_store_close_sum,
    eligible_seller_close_not_above_store: (row) =>
      row.eligible_seller_close_sum > row.eligible_store_close_sum,
  };
  return coverage.filter(predicates[key] ?? (() => false));
}

function sampleDetails(context, key) {
  const rows = failedRows(context, key);
  const safeRows = rows.slice(0, 25).map((row) => ({
    target_month: row.target_month,
    ...(row.cutoff_date ? { cutoff_date: row.cutoff_date } : {}),
    ...(row.sucursal_id != null ? { sucursal_id: row.sucursal_id } : {}),
    ...(row.persona_id != null ? { persona_id: row.persona_id } : {}),
    ...(row.observed_to_date != null ? { observed_to_date: row.observed_to_date } : {}),
    ...(row.actual_close != null ? { actual_close: row.actual_close } : {}),
    ...(row.company_actual_close != null ? { company_actual_close: row.company_actual_close } : {}),
    ...(row.eligible_store_close_sum != null ? { eligible_store_close_sum: row.eligible_store_close_sum } : {}),
    ...(row.eligible_seller_close_sum != null ? { eligible_seller_close_sum: row.eligible_seller_close_sum } : {}),
    ...(row.month_end_unresolved_store != null ? { month_end_unresolved_store: row.month_end_unresolved_store } : {}),
    ...(row.month_end_ambiguous_store != null ? { month_end_ambiguous_store: row.month_end_ambiguous_store } : {}),
    ...(row.month_end_unknown_channel != null ? { month_end_unknown_channel: row.month_end_unknown_channel } : {}),
    ...(row.negative_store_state_seen != null ? { negative_store_state_seen: row.negative_store_state_seen } : {}),
    ...(row.negative_seller_state_seen != null ? { negative_seller_state_seen: row.negative_seller_state_seen } : {}),
    ...(row.diagnostic ? { diagnostic: row.diagnostic } : {}),
  }));
  return { violation_count: rows.length, sample_limit: 25, samples: safeRows };
}

function redact(error) {
  let message = String(error?.message ?? error);
  const secret = process.env.AZURE_DATABASE_URL;
  if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]');
  message = message.replace(/AZURE_DATABASE_URL[^\n]*/gi, 'AZURE_DATABASE_URL [redacted]');
  return error?.code ? `${error.code}: ${message}` : message;
}

async function main() {
  if (!process.env.AZURE_DATABASE_URL) {
    throw new Error('AZURE_DATABASE_URL is not configured in the Production environment.');
  }

  const startMonth = PERIOD_CLOSE_HISTORY_POLICY_V01.start_month;
  const endMonth = previousClosedMonth();
  const context = await dailyCloseBacktestContextV01({
    start_month: startMonth,
    end_month: endMonth,
  });
  const actualKeys = Object.keys(context.validation).filter((key) => key !== 'closed_months_only'
    && key !== 'no_future_evidence_in_observed_to_date');
  const missing = VALIDATION_KEYS.filter((key) => !Object.hasOwn(context.validation, key));
  const unexpected = actualKeys.filter((key) => !VALIDATION_KEYS.includes(key));
  if (missing.length || unexpected.length || VALIDATION_KEYS.length !== 19) {
    throw new Error(`Original SALES validation set mismatch: missing=[${missing.join(',')}] unexpected=[${unexpected.join(',')}]`);
  }

  const failed = VALIDATION_KEYS.filter((key) => context.validation[key] !== true);
  const report = {
    diagnostic: 'historical_sales_backtest_v01',
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    database_access: 'AZURE_DATABASE_URL only',
    neon_connection_or_fallback: 'NONE',
    read_only: true,
    range: {
      start_month: startMonth,
      end_month: endMonth,
      months_requested: context.coverage.months_requested,
      source_rows: context.coverage.source_rows,
      tie_groups_resolved: context.coverage.tie_groups_resolved,
    },
    original_validation_count: VALIDATION_KEYS.length,
    passed_validation_count: VALIDATION_KEYS.length - failed.length,
    failed_validation_count: failed.length,
    validations: Object.fromEntries(VALIDATION_KEYS.map((key) => [key, context.validation[key]])),
    failures: failed.map((key) => ({
      validation: key,
      details: sampleDetails(context, key),
    })),
    month_end_coverage: context.coverage.month_end,
  };
  const output = JSON.stringify(report, null, 2);
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Historical SALES diagnostic\n\n\`\`\`json\n${output}\n\`\`\`\n`);
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    diagnostic: 'historical_sales_backtest_v01',
    status: 'BLOCKED',
    error: redact(error),
  }));
  process.exitCode = 1;
} finally {
  await closeAzurePool().catch((error) => {
    console.error(JSON.stringify({ cleanup: 'failed', error: redact(error) }));
    process.exitCode = 1;
  });
}
