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

function structured(result, toolName) {
  assert.notEqual(result.isError, true, toolName + ' returned an MCP error');
  assert.ok(result.structuredContent, toolName + ' returned no structured content');
  return result.structuredContent;
}

function assertExecuted(value, label) {
  assert.equal(
    value.status,
    'EXECUTED',
    label + ' was not executed: ' + JSON.stringify(value.error ?? value),
  );
  assert.ok(value.result && typeof value.result === 'object', label + ' returned no result');
  return value;
}

const runId = 'azure-sales-p2-p3-' + randomUUID();
const now = new Date();
const periodToDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const periodFromDate = new Date(Date.UTC(periodToDate.getUTCFullYear(), periodToDate.getUTCMonth() - 2, 1));
const periodFrom = periodFromDate.toISOString().slice(0, 7);
const periodTo = periodToDate.toISOString().slice(0, 7);
const port = await unusedPort();
const mcpUrl = 'http://127.0.0.1:' + port + '/api/mcp';
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../motor-test-azure/server.js', import.meta.url)),
], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
});
let client;
try {
  await waitForHealth(new URL('/healthz', mcpUrl), child);
  client = new Client({ name: 'motor-test-azure-p2-p3-validation', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ['data_describe', 'data_observe', 'p2_discover', 'p2_describe', 'p2_execute', 'run_trace']) {
    assert.ok(toolNames.has(name), 'Required MCP tool is missing: ' + name);
  }

  const salesDescriptionResult = await client.callTool({
    name: 'data_describe',
    arguments: { run_id: runId, source: 'SALES' },
  });
  const salesDescription = structured(salesDescriptionResult, 'data_describe');
  assert.ok(salesDescription.measures?.some((measure) => measure.id === 'VIN_SALES'));
  assert.ok(salesDescription.evidence_shapes?.includes('PERIOD_OBSERVATION_SERIES'));

  const discovery = structured(await client.callTool({
    name: 'p2_discover',
    arguments: { run_id: runId },
  }), 'p2_discover');
  assert.equal(discovery.protocol, 'P2_DISCOVERY_V0.1');
  const unit = discovery.units?.find((item) => item.unit_id === 'p2.observed_sequence');
  assert.ok(unit, 'Certified P2 unit p2.observed_sequence is not active');
  assert.equal(unit.status, 'ACTIVE');
  const unitId = unit.unit_id;
  const contractVersion = unit.contract_version;

  const detail = structured(await client.callTool({
    name: 'p2_describe',
    arguments: { run_id: runId, unit_id: unitId, contract_version: contractVersion },
  }), 'p2_describe');
  assert.equal(detail.unit_id, unitId);
  assert.equal(detail.contract_version, contractVersion);
  assert.ok(detail.deterministic_contract?.evidence_slots?.some((slot) =>
    slot.slot === 'sequence'
    && slot.authority === 'P1_CERTIFIED'
    && slot.shape === 'PERIOD_OBSERVATION_SERIES',
  ));
  assert.ok(detail.deterministic_contract?.output?.includes('movements'));

  const p1Evidence = structured(await client.callTool({
    name: 'data_observe',
    arguments: {
      run_id: runId,
      source: 'SALES',
      measure: 'VIN_SALES',
      evidence_shape: 'PERIOD_OBSERVATION_SERIES',
      period_from: periodFrom,
      period_to: periodTo,
      filters: { commercial_universe: 'COMPANY' },
    },
  }), 'data_observe');

  assert.equal(p1Evidence.authority, 'P1_CERTIFIED');
  assert.equal(p1Evidence.status, 'CERTIFIED');
  assert.equal(p1Evidence.source, 'SALES');
  assert.equal(p1Evidence.measure?.id, 'VIN_SALES');
  assert.equal(p1Evidence.universe?.commercial_universe, 'COMPANY');
  assert.equal(p1Evidence.evidence_contract, 'p1.period_observation_series');
  assert.equal(p1Evidence.temporal?.period_from, periodFrom);
  assert.equal(p1Evidence.temporal?.period_to, periodTo);
  const observations = p1Evidence.payload?.observations;
  assert.ok(Array.isArray(observations) && observations.length >= 2);
  assert.ok(observations.every((item) => Number.isSafeInteger(item.value) && item.value >= 0));
  assert.ok(observations.some((item) => item.value > 0), 'P1 returned no real SALES observations');
  assert.ok(p1Evidence.evidence_id);

  const executeArgs = {
    run_id: runId,
    unit_id: unitId,
    contract_version: contractVersion,
    evidence: { sequence: p1Evidence.evidence_id },
    parameters: {},
  };
  const firstExecution = assertExecuted(structured(await client.callTool({
    name: 'p2_execute',
    arguments: executeArgs,
  }), 'p2_execute'), 'First P2 execution');
  const secondExecution = assertExecuted(structured(await client.callTool({
    name: 'p2_execute',
    arguments: executeArgs,
  }), 'p2_execute'), 'Repeated P2 execution');

  assert.deepEqual(secondExecution.result, firstExecution.result, 'P2 result changed for identical certified inputs');
  assert.equal(firstExecution.lineage?.unit_id, unitId);
  assert.equal(firstExecution.lineage?.contract_version, contractVersion);
  assert.equal(firstExecution.result.coverage?.observation_count, observations.length);
  assert.equal(firstExecution.result.coverage?.first_period, periodFrom);
  assert.equal(firstExecution.result.coverage?.last_period, periodTo);
  assert.ok(Array.isArray(firstExecution.result.movements));
  assert.equal(firstExecution.result.movements.length, observations.length - 1);

  const trace = structured(await client.callTool({
    name: 'run_trace',
    arguments: { run_id: runId },
  }), 'run_trace');
  assert.equal(trace.run?.run_id, runId);
  assert.equal(trace.run?.floor, 'ROOT');
  const events = trace.events ?? [];
  const tracedP1 = events.find((item) =>
    item.floor === 'P1'
    && item.tool_name === 'data_observe'
    && item.status === 'SUCCESS'
    && item.input_json?.source === 'SALES'
    && item.input_json?.evidence_shape === 'PERIOD_OBSERVATION_SERIES'
    && item.output_json?.evidence_id === p1Evidence.evidence_id,
  );
  assert.ok(tracedP1, 'run_trace did not return the P1 SALES evidence');
  const tracedExecutions = events.filter((item) =>
    item.floor === 'P2'
    && item.tool_name === 'p2_execute'
    && item.status === 'SUCCESS'
    && item.input_json?.unit_id === unitId
    && item.input_json?.evidence?.sequence === p1Evidence.evidence_id
    && item.output_json?.status === 'EXECUTED'
    && item.output_json?.lineage?.unit_id === unitId,
  );
  assert.equal(tracedExecutions.length, 2, 'run_trace did not return both successful deterministic P2 executions');
  assert.deepEqual(
    tracedExecutions[0].output_json.result,
    tracedExecutions[1].output_json.result,
    'P3 trace contains different results for identical P2 inputs',
  );

  console.log(JSON.stringify({
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    neon_connection_or_fallback: 'NONE',
    mcp_http_transport: 'PASS',
    p2_discover: 'PASS',
    p2_describe: 'PASS',
    p1_sales_evidence: 'PASS',
    p2_unit: unitId,
    contract_version: contractVersion,
    period_from: periodFrom,
    period_to: periodTo,
    sales_observations: observations.map(({ period_identity, value }) => ({ period_identity, value })),
    p2_execute: 'PASS',
    deterministic_repeat: 'PASS',
    run_trace: 'PASS',
    p3_p1_event: 'PASS',
    p3_p2_events: tracedExecutions.length,
    run_id: runId,
  }));
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
