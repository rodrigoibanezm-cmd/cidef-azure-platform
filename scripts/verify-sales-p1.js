import { closeAzurePool } from '../lib/azure-postgres.js';
import { ventasMonthlyActualV01 } from '../lib/motors/ventas-monthly-actual-v01.js';

try {
  const result = await ventasMonthlyActualV01({
    target_month: '2026-09',
    cutoff_month: '2026-09',
  });

  const valid = result.status === 'ok'
    && Number.isInteger(result.actual?.sales)
    && result.actual.sales > 0
    && result.validation?.ventas_context_ok === true
    && result.validation?.target_within_cutoff === true
    && result.validation?.cutoff_context_match === true
    && result.validation?.target_month_present === true
    && result.validation?.no_post_cutoff_evidence_used === true;

  if (!valid) {
    throw new Error(`SALES P1 returned an uncertified result: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify({
    engine: result.engine,
    version: result.version,
    status: result.status,
    inputs: result.inputs,
    actual: result.actual,
    validation: result.validation,
  }));
} finally {
  await closeAzurePool();
}
