import assert from 'node:assert/strict';
import { closeAzurePool } from '../lib/azure-postgres.js';
import { describeCrm, inspectCrm, observeCrmEvidence, observeCrmMany } from '../lib/data-floor/crmCertifier.js';

const period = '2026-09';
const cutoff = '2026-09-30';
const from = '2026-09-01';
const to = '2026-09-30';

try {
  const contract = describeCrm();
  assert.equal(contract.version, '0.1');
  assert.deepEqual(contract.operations, ['DESCRIBE', 'INSPECT', 'OBSERVE']);
  assert.equal(contract.lineage.engine, 'crm_longitudinal_context_v01');
  assert.equal(contract.lineage.source, 'CRM_Cidef_raw');
  assert.equal(contract.lineage.outcome_authority, 'CRM_DECLARED');
  assert.equal(contract.lineage.erp_bridge_used, false);

  const inspect = await inspectCrm({
    filters: {
      commercial_universe: 'COMPANY',
      date_axis: 'CREATED_AT',
      mode: 'EVENT',
      date_from: from,
      date_to: to,
    },
  });
  assert.equal(inspect.size.leads, 7172);
  assert.equal(inspect.quality.complete, true);
  assert.equal(inspect.shape.temporal.period_status, 'OBSERVED_PERIOD_COVERED');

  const cohort = await observeCrmMany({
    period,
    cutoff,
    filters: { mode: 'COHORT', cohort_axis: 'CREATED_AT' },
    operations: [
      ...['LEADS_CREATED', 'SOLD', 'CONVERSION_RATE', 'MANAGED', 'UNMANAGED', 'MANAGEMENT_RATE']
        .map(measure => ({ measure, commercial_universe: 'COMPANY', evidence_shape: 'QUANTITATIVE_OBSERVATION' })),
      { measure: 'LEADS_CREATED', commercial_universe: 'COMPANY', evidence_shape: 'PERIOD_OBSERVATION_SERIES' },
      { measure: 'LEADS_CREATED', commercial_universe: 'COMPANY', dimension: 'BRAND', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET' },
      { measure: 'LEADS_CREATED', commercial_universe: 'OWN_STORES', dimension: 'STORE', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET' },
    ],
  });
  assert.equal(cohort.execution.universe_loads, 1);
  assert.equal(cohort.execution.universes_built, 2);
  const evidence = new Map(cohort.results.map(({ operation, evidence: item }) => [
    `${operation.filters.commercial_universe}:${operation.measure}:${operation.dimension || 'TOTAL'}:${operation.evidence_shape}`,
    item,
  ]));
  const get = (key, shape = 'QUANTITATIVE_OBSERVATION') => {
    const item = evidence.get(`${key}:${shape}`);
    assert.ok(item, `Missing CRM evidence ${key}`);
    assert.equal(item.status, 'COMPLETE', `CRM evidence is not complete: ${key}`);
    assert.equal(item.temporal.historical_close_certified, false);
    return item;
  };

  const expectedValues = {
    'COMPANY:LEADS_CREATED:TOTAL': 7172,
    'COMPANY:SOLD:TOTAL': 279,
    'COMPANY:MANAGED:TOTAL': 3413,
    'COMPANY:UNMANAGED:TOTAL': 3759,
  };
  for (const [key, value] of Object.entries(expectedValues)) assert.equal(get(key).payload.value, value, key);

  const series = get('COMPANY:LEADS_CREATED:TOTAL', 'PERIOD_OBSERVATION_SERIES');
  assert.equal(series.evidence_contract, 'P1_PERIOD_OBSERVATION_SERIES');
  assert.equal(series.payload.series.length, 1);
  assert.equal(series.payload.series[0].period, period);
  assert.equal(series.payload.series[0].value, 7172);

  const conversion = get('COMPANY:CONVERSION_RATE:TOTAL').payload;
  assert.equal(conversion.numerator, 279);
  assert.equal(conversion.denominator, 7172);
  assert.ok(Math.abs(conversion.value - 279 / 7172) < 1e-12);

  const management = get('COMPANY:MANAGEMENT_RATE:TOTAL').payload;
  assert.equal(management.numerator, 3413);
  assert.equal(management.denominator, 7172);
  assert.ok(Math.abs(management.value - 3413 / 7172) < 1e-12);

  const dataValidation = get('COMPANY:LEADS_CREATED:TOTAL').coverage.universe_validation;
  assert.equal(dataValidation.source_rows, 71132);
  assert.equal(dataValidation.deduplicated_leads, 62894);
  assert.equal(dataValidation.duplicate_ids_removed, 8238);
  assert.equal(dataValidation.current_state_unique_ids, true);
  assert.equal(dataValidation.valid, true);

  const brands = get('COMPANY:LEADS_CREATED:BRAND', 'DIMENSIONAL_QUANTITATIVE_DATASET');
  const brandValues = Object.fromEntries(brands.payload.members.map(member => [member.member_id, member.value]));
  assert.equal(brands.payload.members.length, 5);
  assert.equal(brandValues.DONGFENG, 673);
  assert.equal(brandValues.FOTON, 527);
  assert.equal(brandValues.UNRESOLVED, 4773);
  assert.equal(brandValues.NOT_APPLICABLE, 1198);
  assert.equal(brandValues.AMBIGUOUS, 1);

  const stores = get('OWN_STORES:LEADS_CREATED:STORE', 'DIMENSIONAL_QUANTITATIVE_DATASET');
  const storeValues = Object.fromEntries(stores.payload.members.map(member => [member.member_label, member.value]));
  assert.equal(stores.payload.members.length, 12);
  assert.equal(stores.payload.series[0].value, 2985);
  assert.equal(storeValues['CIDEF Bellavista'], 410);

  const assigned = await observeCrmEvidence({
    measure: 'LEADS_ASSIGNED',
    evidence_shape: 'QUANTITATIVE_OBSERVATION',
    period,
    cutoff,
    filters: { commercial_universe: 'COMPANY', mode: 'EVENT', date_axis: 'ASSIGNED_AT' },
  });
  assert.equal(assigned.status, 'COMPLETE');
  assert.equal(assigned.temporal.date_axis, 'ASSIGNED_AT');
  assert.equal(assigned.payload.value, 7425);

  console.log(JSON.stringify({
    source: 'CRM',
    certifier_version: contract.version,
    engine: contract.lineage.engine,
    period,
    cutoff,
    inspect_leads: inspect.size.leads,
    created_leads: get('COMPANY:LEADS_CREATED:TOTAL').payload.value,
    assigned_leads: assigned.payload.value,
    crm_declared_sold: get('COMPANY:SOLD:TOTAL').payload.value,
    conversion_rate: conversion.value,
    managed: management.numerator,
    unmanaged: get('COMPANY:UNMANAGED:TOTAL').payload.value,
    management_rate: management.value,
    brand_members: brands.payload.members.length,
    foton_product_interest: brandValues.FOTON,
    dongfeng_product_interest: brandValues.DONGFENG,
    own_store_members: stores.payload.members.length,
    own_stores_created_leads: stores.payload.series[0].value,
    bellavista_created_leads: storeValues['CIDEF Bellavista'],
    source_rows: dataValidation.source_rows,
    deduplicated_leads: dataValidation.deduplicated_leads,
    neon_baseline_match: true,
  }));
} finally {
  await closeAzurePool();
}
