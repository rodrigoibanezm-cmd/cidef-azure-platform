import assert from 'node:assert/strict';
import { closeAzurePool } from '../lib/azure-postgres.js';
import { observeSalesEvidence } from '../lib/data-floor/salesCertifier.js';
import { observeSalesMany } from '../lib/data-floor/sales/multiObserve.js';
import { describeForum, observeForumEvidence } from '../lib/data-floor/forumCertifier.js';

try {
  const period = '2026-09';
  const cutoff = '2026-09-15';
  const sales = await observeSalesMany({
    period,
    cutoff,
    commercial_universe: 'COMPANY',
    operations: [{ kind: 'TOTAL' }, { kind: 'BRAND' }],
  });
  const daily = await observeSalesEvidence({
    measure: 'VIN_SALES',
    evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION',
    period,
    cutoff,
    filters: { commercial_universe: 'COMPANY' },
  });
  const brands = sales.results.find(row => row.operation.kind === 'BRAND')?.evidence;
  assert.equal(daily.authority, 'P1_CERTIFIED');
  assert.equal(daily.temporal?.cutoff, cutoff);
  assert.equal(daily.payload?.observed_value > 0, true);
  assert.equal(brands?.authority, 'P1_CERTIFIED');
  assert.equal(brands?.temporal?.cutoff, cutoff);
  assert.equal(brands?.payload?.dimension?.id, 'BRAND');
  assert.ok(brands?.payload?.members?.length > 0);

  const series = await observeSalesEvidence({
    measure: 'VIN_SALES',
    evidence_shape: 'PERIOD_OBSERVATION_SERIES',
    period_from: '2026-07',
    period_to: '2026-09',
    filters: { commercial_universe: 'COMPANY' },
  });
  assert.equal(series.authority, 'P1_CERTIFIED');
  assert.equal(series.evidence_contract, 'p1.period_observation_series');
  assert.equal(series.payload.observations.length, 3);

  const forumContract = describeForum();
  assert.equal(forumContract.measures.PRECURSE.unit, 'OPERATION');
  const precurse = await observeForumEvidence({ measure: 'PRECURSE' });
  const precurseBrands = await observeForumEvidence({
    measure: 'PRECURSE',
    evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET',
    dimension: 'BRAND',
  });
  assert.equal(precurse.authority, 'P1_CERTIFIED');
  assert.equal(precurse.measure.id, 'PRECURSE');
  assert.ok(precurse.temporal.snapshot_date);
  assert.equal(precurseBrands.authority, 'P1_CERTIFIED');
  assert.equal(precurseBrands.temporal.snapshot_date, precurse.temporal.snapshot_date);
  assert.equal(precurseBrands.payload.dimension.id, 'BRAND');

  console.log(JSON.stringify({
    database: 'AZURE_POSTGRESQL',
    sales: {
      period,
      cutoff,
      daily_total: daily.payload.observed_value,
      brands: brands.payload.members,
      series: series.payload.observations,
    },
    forum_precurse: {
      contract_version: forumContract.version,
      snapshot_date: precurse.temporal.snapshot_date,
      operations: precurse.payload.value,
      brands: precurseBrands.payload.members,
    },
  }));
} finally {
  await closeAzurePool();
}
