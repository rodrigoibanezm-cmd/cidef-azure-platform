import assert from 'node:assert/strict';
import { closeAzurePool } from '../lib/azure-postgres.js';
import { fetchRvm, inspectRvm, observeRvmEvidence } from '../lib/data-floor/rvmCertifier.js';

const period = '2026-09';
const dateFrom = '2026-09-01';
const dateTo = '2026-09-30';
const periodFilters = { date_from: dateFrom, date_to: dateTo };

try {
  const inspection = await inspectRvm({ filters: periodFilters });
  const total = await observeRvmEvidence({
    measure: 'RVM_UNITS',
    evidence_shape: 'QUANTITATIVE_OBSERVATION',
    period,
  });
  const brands = await observeRvmEvidence({
    measure: 'RVM_UNITS',
    evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET',
    dimension: 'BRAND',
    period,
  });
  const dfm = await fetchRvm({
    fields: ['registration_date', 'vin', 'brand', 'quantity'],
    filters: { ...periodFilters, brand: 'DFM' },
  });

  assert.equal(total.status, 'CERTIFIED');
  assert.equal(total.evidence_contract, 'p1.quantitative_observation');
  assert.deepEqual(total.universe, {
    data_status: 'CONSOLIDATED',
    snapshot_date: null,
    cutoff: dateTo,
  });
  assert.deepEqual(total.temporal, {
    period_identity: period,
    date_from: dateFrom,
    date_to: dateTo,
    cutoff: dateTo,
    date_semantics: 'rvm_raw.fecha',
  });
  assert.deepEqual(total.coverage, {
    source_n: 2006507,
    filtered_n: 30989,
    units: 30989,
  });
  assert.equal(total.payload.value, 30989);

  assert.equal(inspection.size.source_n, 2006507);
  assert.equal(inspection.size.filtered_n, 30989);
  assert.equal(inspection.size.units, 30989);
  assert.equal(brands.evidence_contract, 'p1.dimensional_quantitative_dataset');
  assert.equal(brands.coverage.member_count, 77);
  assert.equal(brands.coverage.units, 30989);

  const brandValues = Object.fromEntries(brands.payload.members.map((member) => [member.member_id, member.value]));
  for (const [brand, expected] of Object.entries({
    TOYOTA: 3290,
    FOTON: 787,
    DFM: 250,
    DONGFENG: 47,
    'DONG FENG': 3,
  })) {
    assert.equal(brandValues[brand], expected, `Unexpected September units for ${brand}`);
  }
  assert.equal(dfm.size.filtered_n, 250);
  assert.equal(dfm.size.units, 250);
  assert.equal(dfm.rows.length, 250);

  console.log(JSON.stringify({
    source: 'RVM',
    certifier_version: total.lineage.certifier_version,
    evidence_shape: total.evidence_contract,
    period,
    data_status: total.universe.data_status,
    snapshot_date: total.universe.snapshot_date,
    source_n: total.coverage.source_n,
    total_units: total.payload.value,
    brand_members: brands.coverage.member_count,
    brand_checks: Object.fromEntries(Object.entries({
      TOYOTA: brandValues.TOYOTA,
      FOTON: brandValues.FOTON,
      DFM: brandValues.DFM,
      DONGFENG: brandValues.DONGFENG,
      'DONG FENG': brandValues['DONG FENG'],
    })),
    dfm_fetch_rows: dfm.rows.length,
    neon_baseline_match: true,
  }));
} finally {
  await closeAzurePool();
}
