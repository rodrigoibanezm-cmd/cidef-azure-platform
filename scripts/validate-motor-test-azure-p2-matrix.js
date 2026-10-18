import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (!process.env.AZURE_DATABASE_URL) {
  throw new Error('Missing required secret: AZURE_DATABASE_URL in GitHub Environment Production.');
}

const [adapterSource, postgresSource] = await Promise.all([
  readFile(new URL('../lib/neon.js', import.meta.url), 'utf8'),
  readFile(new URL('../lib/azure-postgres.js', import.meta.url), 'utf8'),
]);
assert.match(adapterSource, /from ['"]\.\/azure-postgres\.js['"]/);
assert.match(postgresSource, /process\.env\.AZURE_DATABASE_URL/);
for (const source of [adapterSource, postgresSource]) {
  assert.doesNotMatch(source, /NEON_DATABASE_URL|@neondatabase\/serverless|neon\.tech/i);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const month = (date) => date.toISOString().slice(0, 7);
const shiftMonth = (value, offset) => {
  const [year, monthNumber] = value.split('-').map(Number);
  return month(new Date(Date.UTC(year, monthNumber - 1 + offset, 1)));
};
const currentPeriod = month(new Date());
const lastClosedPeriod = shiftMonth(currentPeriod, -1);
const seriesFrom = shiftMonth(lastClosedPeriod, -2);
const periodEnd = (period) => new Date(Date.UTC(
  Number(period.slice(0, 4)),
  Number(period.slice(5, 7)),
  0,
)).toISOString().slice(0, 10);

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('MCP process exited before becoming ready');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('MCP process did not become ready');
}

function errorText(error) {
  const message = String(error?.message ?? error)
    .replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]')
    .replace(/AZURE_DATABASE_URL[^\n]*/gi, 'AZURE_DATABASE_URL [redacted]');
  return error?.code ? error.code + ': ' + message : message;
}

function classifyError(error) {
  const message = String(error?.message ?? error);
  if (/^REQUIRES_DATA:/.test(message)
    || /(?:FORUM_SNAPSHOT_NOT_FOUND|TARGET_REFERENCE_NOT_FOUND|INSUFFICIENT_EVIDENCE|NO_EVALUABLE|NO_CERTIFIED_DATA|NOT_CERTIFIED|NO_RESOLVED|_NOT_FOUND)/i.test(message)) {
    return 'REQUIRES_DATA';
  }
  if (/UNSUPPORTED_(?:EVIDENCE_SHAPE|MEASURE|DIMENSION|SALES_IDENTIFIER)/i.test(message)) {
    return 'BLOCKED';
  }
  return 'FAIL';
}

function resultContent(result, toolName) {
  if (result?.isError) {
    const text = result.content?.find((part) => part.type === 'text')?.text;
    throw new Error(toolName + ' failed: ' + String(text ?? 'MCP tool error'));
  }
  assert.ok(result?.structuredContent, toolName + ' returned no structured content');
  return result.structuredContent;
}

const runId = 'azure-p2-matrix-' + randomUUID();
const port = await unusedPort();
const mcpUrl = 'http://127.0.0.1:' + port + '/api/mcp';
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../motor-test-azure/server.js', import.meta.url)),
], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
});
let client;
const statuses = new Map();
const evidenceCache = new Map();
const successfulEvidence = new Map();
let storeId;

async function call(name, args) {
  return resultContent(await client.callTool({ name, arguments: { run_id: runId, ...args } }), name);
}

async function observe(args) {
  const key = JSON.stringify(args);
  if (!evidenceCache.has(key)) {
    evidenceCache.set(key, (async () => {
      const evidence = await call('data_observe', args);
      assert.equal(evidence.authority, 'P1_CERTIFIED', 'P1 evidence is not certified');
      assert.ok(evidence.evidence_id, 'P1 evidence has no evidence_id');
      successfulEvidence.set(evidence.evidence_id, args);
      return evidence;
    })());
  }
  return evidenceCache.get(key);
}

async function storeForPeriod(period) {
  if (storeId) return storeId;
  const stores = await observe({
    source: 'SALES',
    measure: 'VIN_SALES',
    evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET',
    period,
    dimension: 'STORE',
    filters: { commercial_universe: 'OWN_STORES' },
  });
  const member = stores.payload?.members?.find((row) =>
    row.member_id != null && String(row.member_id) !== 'UNRESOLVED' && Number(row.value) > 0,
  );
  if (!member) throw new Error('REQUIRES_DATA: SALES P1 returned no resolved OWN_STORES member.');
  storeId = String(member.member_id);
  return storeId;
}

async function describeUnit(unitId, units) {
  const discovered = units.find((item) => item.unit_id === unitId && item.status === 'ACTIVE');
  if (!discovered) throw new Error('P2 unit is missing or inactive in p2_discover: ' + unitId);
  const detail = await call('p2_describe', {
    unit_id: unitId,
    contract_version: discovered.contract_version,
  });
  assert.equal(detail.unit_id, unitId);
  assert.equal(detail.contract_version, discovered.contract_version);
  assert.equal(detail.status, 'ACTIVE');
  return detail;
}

async function executeDeterministically(unitId, detail, evidence, parameters = {}) {
  const args = {
    unit_id: unitId,
    contract_version: detail.contract_version,
    evidence: Object.fromEntries(Object.entries(evidence).map(([slot, item]) => [slot, item.evidence_id])),
    parameters,
  };
  const first = await call('p2_execute', args);
  if (first.status !== 'EXECUTED') {
    throw new Error((first.error?.code ?? 'P2_EXECUTION_FAILED') + ': ' + (first.error?.message ?? JSON.stringify(first.error ?? first)));
  }
  assert.ok(first.result && typeof first.result === 'object', 'P2 returned no result');
  for (const field of detail.deterministic_contract?.output ?? []) {
    assert.ok(Object.hasOwn(first.result, field), 'P2 output is missing contract field: ' + field);
  }
  const second = await call('p2_execute', args);
  if (second.status !== 'EXECUTED') {
    throw new Error((second.error?.code ?? 'P2_REPEAT_FAILED') + ': ' + (second.error?.message ?? JSON.stringify(second.error ?? second)));
  }
  assert.deepEqual(second.result, first.result, 'Repeated P2 execution changed its result.');
  return { evidenceIds: Object.values(evidence).map((item) => item.evidence_id), result: first.result };
}

function periodObservation(period, filters = {}) {
  return observe({
    source: 'SALES',
    measure: 'VIN_SALES',
    evidence_shape: 'QUANTITATIVE_OBSERVATION',
    period,
    filters: { commercial_universe: 'COMPANY', ...filters },
  });
}

function series(period_from, period_to, filters = {}) {
  return observe({
    source: 'SALES',
    measure: 'VIN_SALES',
    evidence_shape: 'PERIOD_OBSERVATION_SERIES',
    period_from,
    period_to,
    filters: { commercial_universe: 'OWN_STORES', ...filters },
  });
}

async function runUnit(unitId, units, buildEvidence) {
  try {
    const detail = await describeUnit(unitId, units);
    const evidence = await buildEvidence();
    const execution = await executeDeterministically(unitId, detail, evidence.evidence, evidence.parameters);
    statuses.set(unitId, { status: 'PASS', ...execution });
  } catch (error) {
    statuses.set(unitId, {
      status: classifyError(error),
      error: errorText(error),
    });
  }
}

try {
  await waitForHealth(new URL('/healthz', mcpUrl), child);
  client = new Client({ name: 'motor-test-azure-p2-matrix-validation', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ['data_observe', 'sales_observe_windows', 'p2_discover', 'p2_describe', 'p2_execute', 'run_trace']) {
    assert.ok(names.has(name), 'Required MCP tool is missing: ' + name);
  }

  const discovery = await call('p2_discover', {});
  assert.equal(discovery.protocol, 'P2_DISCOVERY_V0.1');
  const units = discovery.units ?? [];
  const expectedPending = [
    'p2.pricing_window_sales',
    'p2.forum_snapshot_transitions',
    'p2.open_period_deterioration_risk',
    'p2.forum_funnel_performance',
    'p2.target_attainment_probability',
    'p2.reconciled_seller_target_contribution',
    'p2.reference_deviation',
    'p2.proportion_across_periods',
    'p2.observed_pair_delta',
    'p2.part_to_universe_ratio',
    'p2.period_close_estimate',
    'p2.reconciled_dimension_delta',
  ];
  assert.equal(units.length, 13, 'Expected 13 original active P2 units.');
  assert.ok(units.some((item) => item.unit_id === 'p2.observed_sequence'), 'Previously validated P2 unit is absent.');

  await runUnit('p2.pricing_window_sales', units, async () => {
    const pricing = await observe({
      source: 'PRICING',
      measure: 'PRICE_EPISODES',
      evidence_shape: 'COMMERCIAL_CONDITION_WINDOWS',
      period_from: seriesFrom,
      period_to: lastClosedPeriod,
    });
    const sales = await call('sales_observe_windows', {
      pricing_evidence_id: pricing.evidence_id,
      cutoff: periodEnd(lastClosedPeriod),
      metrics_scope: 'INTERSECTION',
      commercial_universe: 'COMPANY',
    });
    assert.ok(sales.evidence_id, 'SALES window observation returned no evidence_id');
    successfulEvidence.set(sales.evidence_id, { source: 'SALES', tool: 'sales_observe_windows' });
    return { evidence: { pricing, sales }, parameters: { metrics_scope: 'INTERSECTION' } };
  });

  await runUnit('p2.forum_snapshot_transitions', units, async () => {
    const snapshots = [];
    const today = new Date();
    for (let offset = 0; offset < 30 && snapshots.length < 2; offset += 1) {
      const cutoff = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset))
        .toISOString().slice(0, 10);
      try {
        const item = await observe({
          source: 'FORUM',
          measure: 'OPERATION_STATES',
          evidence_shape: 'OPERATION_STATE_SNAPSHOT',
          cutoff,
          filters: {},
        });
        snapshots.push(item);
      } catch (error) {
        if (!String(error?.message ?? error).includes('FORUM_SNAPSHOT_NOT_FOUND')) throw error;
      }
    }
    snapshots.sort((a, b) => String(a.temporal?.snapshot_date).localeCompare(String(b.temporal?.snapshot_date)));
    if (snapshots.length < 2) throw new Error('REQUIRES_DATA: Fewer than two certified FORUM daily snapshots found in the last 30 days.');
    return { evidence: { baseline: snapshots.at(-2), comparison: snapshots.at(-1) } };
  });

  await runUnit('p2.open_period_deterioration_risk', units, async () => {
    const store = await storeForPeriod(currentPeriod);
    const filters = { commercial_universe: 'OWN_STORES', store_id: store };
    const observed_to_cutoff = await observe({
      source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION',
      period: currentPeriod, filters,
    });
    const model_history = await observe({
      source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'HISTORICAL_PERIOD_SERIES',
      period: currentPeriod, filters,
    });
    return { evidence: { observed_to_cutoff, model_history } };
  });

  await runUnit('p2.forum_funnel_performance', units, async () => {
    const common = {
      source: 'FORUM',
      evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET',
      period: lastClosedPeriod,
      dimension: 'NETWORK',
      filters: {},
    };
    const [converted, approved, expired, rejected] = await Promise.all([
      observe({ ...common, measure: 'COHORT_CONVERTED' }),
      observe({ ...common, measure: 'COHORT_APPROVED' }),
      observe({ ...common, measure: 'COHORT_EXPIRED' }),
      observe({ ...common, measure: 'COHORT_REJECTED' }),
    ]);
    return { evidence: { converted, approved, expired, rejected } };
  });

  await runUnit('p2.target_attainment_probability', units, async () => {
    const store = await storeForPeriod(currentPeriod);
    const filters = { commercial_universe: 'OWN_STORES', store_id: store };
    const [observed_to_cutoff, target, model_history] = await Promise.all([
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION', period: currentPeriod, filters }),
      observe({ source: 'TARGETS', measure: 'VIN_TARGET', evidence_shape: 'REFERENCE_OBSERVATION', period: currentPeriod, filters: { store_id: store } }),
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'HISTORICAL_PERIOD_SERIES', period: currentPeriod, filters }),
    ]);
    return { evidence: { observed_to_cutoff, target, model_history } };
  });

  await runUnit('p2.reconciled_seller_target_contribution', units, async () => {
    const store = await storeForPeriod(currentPeriod);
    const filters = { commercial_universe: 'OWN_STORES', store_id: store };
    const [seller_observed_to_cutoff, seller_history, store_target, store_completion_history] = await Promise.all([
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', period: currentPeriod, dimension: 'SELLER', filters }),
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'SELLER_CONTRIBUTION_HISTORY', period: currentPeriod, filters }),
      observe({ source: 'TARGETS', measure: 'VIN_TARGET', evidence_shape: 'REFERENCE_OBSERVATION', period: currentPeriod, filters: { store_id: store } }),
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'HISTORICAL_PERIOD_SERIES', period: currentPeriod, filters }),
    ]);
    return { evidence: { seller_observed_to_cutoff, seller_history, store_target, store_completion_history } };
  });

  await runUnit('p2.reference_deviation', units, async () => {
    const store = await storeForPeriod(currentPeriod);
    const observed = await observe({
      source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION',
      period: currentPeriod, filters: { commercial_universe: 'OWN_STORES', store_id: store },
    });
    const reference = await observe({
      source: 'TARGETS', measure: 'VIN_TARGET', evidence_shape: 'REFERENCE_OBSERVATION',
      period: currentPeriod, filters: { store_id: store },
    });
    return { evidence: { observed, reference } };
  });

  await runUnit('p2.proportion_across_periods', units, async () => {
    const store = await storeForPeriod(lastClosedPeriod);
    const [part_series, universe_series] = await Promise.all([
      series(seriesFrom, lastClosedPeriod, { store_id: store }),
      series(seriesFrom, lastClosedPeriod),
    ]);
    return { evidence: { part_series, universe_series } };
  });

  await runUnit('p2.observed_pair_delta', units, async () => {
    const [baseline, comparison] = await Promise.all([
      periodObservation(shiftMonth(lastClosedPeriod, -1)),
      periodObservation(lastClosedPeriod),
    ]);
    return { evidence: { baseline, comparison } };
  });

  await runUnit('p2.part_to_universe_ratio', units, async () => {
    const store = await storeForPeriod(lastClosedPeriod);
    const [part, universe] = await Promise.all([
      periodObservation(lastClosedPeriod, { commercial_universe: 'OWN_STORES', store_id: store }),
      periodObservation(lastClosedPeriod, { commercial_universe: 'OWN_STORES' }),
    ]);
    return { evidence: { part, universe } };
  });

  await runUnit('p2.period_close_estimate', units, async () => {
    const store = await storeForPeriod(currentPeriod);
    const filters = { commercial_universe: 'OWN_STORES', store_id: store };
    const [observed_to_cutoff, period_calendar, model_history] = await Promise.all([
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION', period: currentPeriod, filters }),
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'PERIOD_CALENDAR', period: currentPeriod, filters }),
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'HISTORICAL_PERIOD_SERIES', period: currentPeriod, filters }),
    ]);
    return { evidence: { observed_to_cutoff, period_calendar, model_history } };
  });

  await runUnit('p2.reconciled_dimension_delta', units, async () => {
    const [baseline_by_member, comparison_by_member] = await Promise.all([
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', period: shiftMonth(lastClosedPeriod, -1), dimension: 'STORE', filters: { commercial_universe: 'OWN_STORES' } }),
      observe({ source: 'SALES', measure: 'VIN_SALES', evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET', period: lastClosedPeriod, dimension: 'STORE', filters: { commercial_universe: 'OWN_STORES' } }),
    ]);
    return { evidence: { baseline_by_member, comparison_by_member } };
  });

  const missing = expectedPending.filter((unitId) => !statuses.has(unitId));
  assert.deepEqual(missing, [], 'The test plan omitted pending P2 units.');
  let trace = null;
  let traceError = null;
  try {
    trace = await call('run_trace', {});
    assert.equal(trace.run?.run_id, runId, 'run_trace returned the wrong run.');
  } catch (error) {
    traceError = errorText(error);
  }

  const events = trace?.events ?? [];
  for (const [unitId, status] of statuses.entries()) {
    if (status.status !== 'PASS') continue;
    try {
      if (traceError) throw new Error('run_trace failed: ' + traceError);
      const executions = events.filter((item) =>
        item.floor === 'P2'
        && item.tool_name === 'p2_execute'
        && item.status === 'SUCCESS'
        && item.input_json?.unit_id === unitId
        && item.output_json?.status === 'EXECUTED',
      );
      assert.equal(executions.length, 2, 'run_trace does not contain both successful executions.');
      assert.deepEqual(executions[0].output_json.result, executions[1].output_json.result,
        'run_trace contains nondeterministic executions.');
      for (const id of status.evidenceIds) {
        assert.ok(successfulEvidence.has(id), 'P2 used evidence not recorded as certified P1 in this run: ' + id);
      }
      status.p3_events = executions.length;
    } catch (error) {
      status.status = 'FAIL';
      status.error = errorText(error);
    }
    delete status.evidenceIds;
    delete status.result;
  }

  const summary = expectedPending.map((unitId) => ({
    unit_id: unitId,
    contract_version: units.find((unit) => unit.unit_id === unitId)?.contract_version ?? null,
    ...(statuses.get(unitId) ?? { status: 'FAIL', error: 'No status recorded.' }),
  }));
  console.log(JSON.stringify({
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    neon_connection_or_fallback: 'NONE',
    p2_discover: 'PASS',
    run_trace: 'PASS',
    units: summary,
    run_id: runId,
  }));

  const incomplete = summary.filter((item) => item.status !== 'PASS');
  if (incomplete.length) {
    process.exitCode = 1;
  }
} finally {
  await client?.close().catch(() => {});
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(3000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
