import assert from 'node:assert/strict';
import { azureQuery, closeAzurePool } from '../lib/azure-postgres.js';
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
  const objects = await azureQuery(`
    WITH expected(name) AS (VALUES
      ('forum_funnel_universe_v01'), ('forum_funnel_raw'),
      ('forum_cotizacion_raw'), ('forum_curse_raw'), ('forum_raw'),
      ('producto_aliases_v01'), ('marcas_master_v01'),
      ('dealer_aliases'), ('dealers_master'), ('dealer_groups'),
      ('sucursal_aliases'), ('sucursales_master'), ('persona_aliases'), ('personas_master')
    )
    SELECT e.name, n.nspname AS schema_name,
      CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
        WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE c.relkind::text END AS object_type
    FROM expected e
    LEFT JOIN pg_class c ON c.relname=e.name
    LEFT JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname IN ('public','azure_forum_migration')
    ORDER BY e.name,n.nspname
  `);
  const rawCounts = {};
  for (const schema of ['public', 'azure_forum_migration']) {
    const relation = `${schema}.forum_funnel_raw`;
    if (objects.some(row => row.schema_name === schema && row.name === 'forum_funnel_raw')) {
      const [count] = await azureQuery(`SELECT count(*)::bigint AS rows FROM ${relation}`);
      rawCounts[relation] = Number(count.rows);
    }
  }
  console.log(JSON.stringify({ source: 'FORUM_AZURE_SCHEMA_INVENTORY', objects, raw_counts: rawCounts }));

  const contract = describeForum();
  assert.equal(contract.version, '0.12');
  assert.deepEqual(contract.operations, ['DESCRIBE', 'INSPECT', 'FETCH', 'OBSERVE']);
  assert.equal(contract.measures.QUOTATIONS.rule, 'ALL_COTIZACION_RECORDS');
  assert.equal(contract.measures.APPLICATIONS.rule, 'TIPO_PROCESO_NOT_COTIZACION');
  assert.equal(contract.measures.CURSES.rule, 'CURSE_OPERATION_BY_FECHA_CURSE');
  assert.equal(contract.measures.UFIS.rule, 'CURSE_VEHICLE_UNITS_BY_FECHA_CURSE');

  const results = {};
  const mismatches = {};
  for (const [measure, expected] of Object.entries(neonBaseline)) {
    const evidence = await observeForumEvidence({ measure, period, cutoff });
    assert.equal(evidence.status, 'COMPLETE', `${measure} evidence is incomplete`);
    assert.equal(evidence.evidence_version, '0.12', `${measure} contract version differs`);
    assert.equal(evidence.temporal.from, '2026-09-01', `${measure} period start differs`);
    assert.equal(evidence.temporal.to, cutoff, `${measure} cutoff differs`);
    results[measure] = evidence.payload.value;
    if (evidence.payload.value !== expected) {
      mismatches[measure] = { neon: expected, azure: evidence.payload.value };
    }
  }

  const neonBaselineMatch = Object.keys(mismatches).length === 0;
  console.log(JSON.stringify({
    source: 'FORUM',
    contract_version: contract.version,
    period,
    cutoff,
    azure: results,
    neon_baseline: neonBaseline,
    mismatches,
    neon_baseline_match: neonBaselineMatch,
  }));
  assert.deepEqual(mismatches, {}, 'FORUM P1 differs from Neon September baseline');
} finally {
  await closeAzurePool();
}
