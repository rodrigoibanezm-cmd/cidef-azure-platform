// One-off read-only validation: production PostgreSQL, isolated Node process.
import assert from 'node:assert/strict';
import { resolveDataObservation } from '../lib/data-floor/registry.js';

const request = {
  measure: 'VIN_SALES',
  time: {period:'2026-08', cutoff:'2026-08-31'},
  filters: {commercial_universe:'OWN_STORES', brand_id:89, model_id:28, store_id:4},
};
const observe = async (enabled) => {
  process.env.SALES_SQL_FIRST_ENABLED = enabled ? 'true' : 'false';
  const started = performance.now();
  const evidence = await resolveDataObservation(
    'sales-optin-validation-'+(enabled?'selective':'full'),
    'SALES', {request},
    {measureExecution: execute => execute(), onReuse:()=>{}},
  );
  return {evidence, elapsed_ms:Math.round(performance.now()-started)};
};

try {
  const full = await observe(false);
  assert.equal(full.evidence.authority,'P1_CERTIFIED');
  assert.equal(full.evidence.status,'CERTIFIED');
  assert.equal(full.evidence.payload.observed_value,4);
  assert.ok(full.evidence.coverage.source_n>4);
  const selective = await observe(true);
  assert.equal(selective.evidence.authority,'P1_PARTIAL_SOURCE');
  assert.equal(selective.evidence.status,'PARTIAL_SOURCE');
  assert.match(selective.evidence.evidence_contract,/^p1\.sql_first_partial_/);
  assert.equal(selective.evidence.payload.observed_value,full.evidence.payload.observed_value);
  assert.equal(selective.evidence.coverage.source_n,4);
  assert.equal(selective.evidence.coverage.source_scope,'PARTIAL_SOURCE');
  assert.equal(selective.evidence.temporal_fingerprint,undefined);
  assert.notEqual(selective.evidence.evidence_id,full.evidence.evidence_id);
  console.log(JSON.stringify({
    status:'PASS', full:{status:full.evidence.status,source_n:full.evidence.coverage.source_n,
      vin:full.evidence.payload.observed_value,elapsed_ms:full.elapsed_ms},
    selective:{status:selective.evidence.status,source_n:selective.evidence.coverage.source_n,
      vin:selective.evidence.payload.observed_value,elapsed_ms:selective.elapsed_ms},
  }));
} finally {
  process.env.SALES_SQL_FIRST_ENABLED = 'false';
}
