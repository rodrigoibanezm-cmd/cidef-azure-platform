import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ORIGIN_COMMIT = 'f74022515015e48725da60af8b18a120b7ddf9c1';
const START_MONTH = '2021-01';
const END_MONTH = '2026-09';
const PERIOD = '2022-10';
const STORE_ID = '15';
const TARGET_VIN = 'LGG8E2D12PZ352797';
const EARLY_CUTOFF = '2022-10-21';
const CLOSE_CUTOFF = '2022-10-31';

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

const workerSource = `
import { dailyCloseBacktestContextV01 } from './lib/motors/daily-close-backtest-context-v01.js';
import { buildVentasCommercialContexts } from './lib/ventas-commercial/buildVentasCommercialContext.js';
import { closeRvmDb } from './lib/rvm-db.js';

const validationKeys = ${JSON.stringify(VALIDATION_KEYS)};
const startMonth = process.env.HISTORY_START_MONTH;
const endMonth = process.env.HISTORY_END_MONTH;
const period = process.env.DIAG_PERIOD;
const storeId = process.env.DIAG_STORE_ID;
const targetVin = process.env.DIAG_TARGET_VIN;
const earlyCutoff = process.env.DIAG_EARLY_CUTOFF;
const closeCutoff = process.env.DIAG_CLOSE_CUTOFF;

function safeSale(row) {
  return {
    vin: row.vin ?? null,
    source_id: row.source_id ?? null,
    fecha_venta: row.fecha_venta ?? null,
    fecha_venta_iso: row.fecha_venta_iso ?? null,
    mes_venta: row.mes_venta ?? null,
    recognition_basis: row.recognition_basis ?? null,
    factura: row.factura ?? null,
    nro_factura: row.nro_factura ?? null,
    nro_operacion: row.nro_operacion ?? null,
    sucursal_source_key: row.sucursal_source_key ?? null,
    sucursal_venta_id: row.sucursal_venta_id ?? null,
    sucursal_venta_nombre: row.sucursal_venta_nombre ?? null,
    categoria_cliente: row.categoria_cliente ?? null,
    canal_salida: row.canal_salida ?? null,
    commercial_channel_authority: row.commercial_channel_authority ?? null,
    commercial_destination_authority: row.commercial_destination_authority ?? null,
  };
}

function storeSales(context) {
  return (context?.sales ?? []).filter((row) =>
    row.mes_venta === period
    && String(row.sucursal_venta_id ?? '') === storeId
    && row.vin != null);
}

function redact(error) {
  return {
    name: String(error?.name ?? 'Error'),
    code: error?.code ?? null,
  };
}

let report;
let failure;
try {
  const context = await dailyCloseBacktestContextV01({
    start_month: startMonth,
    end_month: endMonth,
  });
  const validation = Object.fromEntries(validationKeys.map((key) => [key, context.validation[key]]));
  const failedStoreRows = context.store_observations
    .filter((row) => Number(row.observed_to_date) > Number(row.actual_close))
    .map((row) => ({
      target_month: row.target_month,
      cutoff_date: row.cutoff_date,
      sucursal_id: row.sucursal_id,
      observed_to_date: row.observed_to_date,
      actual_close: row.actual_close,
    }));

  const early = (await buildVentasCommercialContexts(
    { cutoff_date: earlyCutoff }, ['OWN_STORES'],
  )).get('OWN_STORES');
  const close = (await buildVentasCommercialContexts(
    { cutoff_date: closeCutoff }, ['OWN_STORES'],
  )).get('OWN_STORES');
  const earlyStoreSales = storeSales(early);
  const closeStoreSales = storeSales(close);
  const earlyTargetRows = earlyStoreSales
    .filter((row) => String(row.vin).trim().toUpperCase() === targetVin);
  const closeTargetRows = closeStoreSales
    .filter((row) => String(row.vin).trim().toUpperCase() === targetVin);
  const closeVins = new Set(closeStoreSales.map((row) => String(row.vin).trim().toUpperCase()));

  report = {
    ok: true,
    backend: process.env.DIAG_BACKEND,
    parameters: { start_month: startMonth, end_month: endMonth },
    history: {
      status: context.status,
      source_rows: context.coverage.source_rows,
      months_requested: context.coverage.months_requested,
      validation_count: VALIDATION_KEYS.length,
      validations: validation,
      failed_store_observations: failedStoreRows,
    },
    vin_case: {
      period,
      store_id: storeId,
      early_cutoff: earlyCutoff,
      close_cutoff: closeCutoff,
      early_store_sales: earlyStoreSales.length,
      close_store_sales: closeStoreSales.length,
      target_vin_early_rows: earlyTargetRows.map(safeSale),
      target_vin_close_rows: closeTargetRows.map(safeSale),
      target_vin_is_early_only_in_store: earlyTargetRows.length > 0 && !closeVins.has(targetVin),
    },
  };
} catch (error) {
  failure = redact(error);
} finally {
  await closeRvmDb().catch((error) => {
    failure ??= { name: 'CleanupError', code: error?.code ?? null };
  });
}

if (failure) {
  console.log(JSON.stringify({
    ok: false,
    backend: process.env.DIAG_BACKEND,
    parameters: { start_month: startMonth, end_month: endMonth },
    error: failure,
  }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report));
}
`;

function requireSecret(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function runBackend(backend, connectionValue) {
  const env = { ...process.env };
  for (const key of ['AZURE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL']) {
    delete env[key];
  }

  if (backend === 'Neon') env.DATABASE_URL = connectionValue;
  else env.AZURE_DATABASE_URL = connectionValue;

  Object.assign(env, {
    DIAG_BACKEND: backend,
    HISTORY_START_MONTH: START_MONTH,
    HISTORY_END_MONTH: END_MONTH,
    DIAG_PERIOD: PERIOD,
    DIAG_STORE_ID: STORE_ID,
    DIAG_TARGET_VIN: TARGET_VIN,
    DIAG_EARLY_CUTOFF: EARLY_CUTOFF,
    DIAG_CLOSE_CUTOFF: CLOSE_CUTOFF,
  });

  const originPath = resolve(process.env.CIDEF_ORIGIN_PATH ?? 'cidef-data-loader');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', workerSource], {
    cwd: originPath,
    env,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  });

  const line = String(child.stdout ?? '').trim().split(/\\r?\\n/).at(-1);
  let result;
  try {
    result = JSON.parse(line);
  } catch {
    throw new Error(`${backend} diagnostic process returned no valid report (exit ${child.status ?? 'unknown'}).`);
  }
  if (child.error) throw new Error(`${backend} diagnostic process could not start.`);
  if (!result?.ok || child.status !== 0) {
    throw new Error(`${backend} diagnostic was blocked (error ${result?.error?.code ?? result?.error?.name ?? 'unknown'}).`);
  }
  return result;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  const neonUrl = requireSecret('NEON_DATABASE_URL');
  const azureUrl = requireSecret('AZURE_DATABASE_URL');
  const neon = runBackend('Neon', neonUrl);
  const azure = runBackend('Azure', azureUrl);

  const comparison = {
    same_19_validation_results: sameJson(neon.history.validations, azure.history.validations),
    same_failed_store_observations: sameJson(
      neon.history.failed_store_observations,
      azure.history.failed_store_observations,
    ),
    same_vin_evidence: sameJson(neon.vin_case, azure.vin_case),
    validation_differences: Object.keys(neon.history.validations).filter(
      (key) => neon.history.validations[key] !== azure.history.validations[key],
    ),
  };

  const report = {
    diagnostic: 'sales_historical_certification_neon_vs_azure',
    source_repository: 'rodrigoibanezm-cmd/cidef-data-loader',
    source_commit: ORIGIN_COMMIT,
    read_only: true,
    p3_or_snapshot_operations: 'NONE',
    adapter_selection: {
      Neon: 'origin rvmDb with DATABASE_URL only',
      Azure: 'origin rvmDb with AZURE_DATABASE_URL only',
      fallback_between_backends: 'NONE',
    },
    parameters: {
      history: { start_month: START_MONTH, end_month: END_MONTH },
      validation_count: VALIDATION_KEYS.length,
      vin_case: { period: PERIOD, store_id: STORE_ID, cutoffs: [EARLY_CUTOFF, CLOSE_CUTOFF] },
    },
    comparison,
    neon,
    azure,
  };

  console.log(JSON.stringify(report));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '## SALES historical certification: Neon vs Azure',
      '',
      `- Same 19 validations: **${comparison.same_19_validation_results}**`,
      `- Same failed store observations: **${comparison.same_failed_store_observations}**`,
      `- Same VIN evidence: **${comparison.same_vin_evidence}**`,
      `- Failed validations: ${Object.entries(neon.history.validations).filter(([, value]) => value === false).map(([key]) => key).join(', ') || 'none'}`,
      '',
      'Full sanitized JSON report is in the job log.',
      '',
    ].join('\\n');
    await import('node:fs/promises').then(({ appendFile }) =>
      appendFile(process.env.GITHUB_STEP_SUMMARY, summary));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    diagnostic: 'sales_historical_certification_neon_vs_azure',
    status: 'BLOCKED',
    error: {
      name: String(error?.name ?? 'Error'),
      code: error?.code ?? null,
    },
  }));
  process.exitCode = 1;
});
