import assert from 'node:assert/strict';
import { closeAzurePool } from '../lib/azure-postgres.js';
import { describeForum, observeForumEvidence } from '../lib/data-floor/forumCertifier.js';

const period = '2026-09';
const cutoff = '2026-09-30';
const neonBaseline = {
  QUOTATIONS: 5890,
  APPLICATIONS: 4847,
  CURSES: 381,
  UFIS: 383,
  COHORT_CONVERTED: 348,
  COHORT_APPROVED: 1818,
  COHORT_EXPIRED: 868,
  COHORT_REJECTED: 1055,
};

try {
  const contract = describeForum();
  assert.equal(contract.version, '0.11');
  assert.deepEqual(contract.operations, ['DESCRIBE', 'INSPECT', 'FETCH', 'OBSERVE']);
  assert.equal(contract.measures.QUOTATIONS.rule, 'ALL_COTIZACION_RECORDS');
  assert.equal(contract.measures.APPLICATIONS.rule, 'TIPO_PROCESO_NOT_COTIZACION');
  assert.equal(contract.measures.CURSES.rule, 'CURSE_OPERATION_BY_FECHA_CURSE');
  assert.equal(contract.measures.UFIS.rule, 'CURSE_VEHICLE_UNITS_BY_FECHA_CURSE');

  const results = {};
  for (const [measure, expected] of Object.entries(neonBaseline)) {
    const evidence = await observeForumEvidence({ measure, period, cutoff });
    assert.equal(evidence.status, 'COMPLETE', `${measure} evidence is incomplete`);
    assert.equal(evidence.evidence_version, '0.11', `${measure} contract version differs`);
    assert.equal(evidence.temporal.from, '2026-09-01', `${measure} period start differs`);
    assert.equal(evidence.temporal.to, cutoff, `${measure} cutoff differs`);
    assert.equal(evidence.payload.value, expected, `${measure} differs from Neon`);
    results[measure] = evidence.payload.value;
  }

  console.log(JSON.stringify({
    source: 'FORUM',
    contract_version: contract.version,
    period,
    cutoff,
    azure: results,
    neon_baseline: neonBaseline,
    neon_baseline_match: true,
  }));
} finally {
  await closeAzurePool();
}
