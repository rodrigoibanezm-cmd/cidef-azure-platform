import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const period = '2026-09';
const runId = 'azure-p2-reference-deviation-' + randomUUID();
const timeoutMs = 30_000;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Azure motor-test process exited before health check');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('Azure motor-test process did not become ready');
}
function content(result, name) {
  if (result?.isError) {
    const message = result.content?.find((part) => part.type === 'text')?.text;
    throw new Error(name + ' failed: ' + String(message ?? 'MCP tool error'));
  }
  assert.ok(result?.structuredContent, name + ' returned no structured content');
  return result.structuredContent;
}
const port = await unusedPort();
const endpoint = new URL('/api/mcp', 'http://127.0.0.1:' + port);
const child = spawn(process.execPath, [fileURLToPath(new URL('../motor-test-azure/server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
});
let client;
try {
  await waitForHealth(new URL('/healthz', endpoint), child);
  client = new Client({ name: 'validate-azure-p2-reference-deviation', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ['data_observe', 'p2_execute', 'run_trace']) {
    assert.ok(toolNames.has(name), 'Required MCP tool is missing: ' + name);
  }
  const call = async (name, args) => content(
    await client.callTool({ name, arguments: { run_id: runId, ...args } }),
    name,
  );

  const storeEvidence = await call('data_observe', {
    source: 'SALES',
    measure: 'VIN_SALES',
    evidence_shape: 'DIMENSIONAL_QUANTITATIVE_DATASET',
    period,
    dimension: 'STORE',
    filters: { commercial_universe: 'OWN_STORES' },
  });
  assert.equal(storeEvidence.authority, 'P1_CERTIFIED');
  const store = storeEvidence.payload?.members?.find((member) =>
    member.member_id != null && String(member.member_id) !== 'UNRESOLVED' && Number(member.value) > 0,
  );
  if (!store) throw new Error('No certified resolved OWN_STORES member with SALES in ' + period);

  const [observed, reference] = await Promise.all([
    call('data_observe', {
      source: 'SALES',
      measure: 'VIN_SALES',
      evidence_shape: 'CUMULATIVE_PERIOD_OBSERVATION',
      period,
      filters: { commercial_universe: 'OWN_STORES', store_id: String(store.member_id) },
    }),
    call('data_observe', {
      source: 'TARGETS',
      measure: 'VIN_TARGET',
      evidence_shape: 'REFERENCE_OBSERVATION',
      period,
      filters: { store_id: String(store.member_id) },
    }),
  ]);
  assert.equal(observed.authority, 'P1_CERTIFIED');
  assert.equal(reference.authority, 'P1_CERTIFIED');
  assert.equal(reference.temporal?.period_identity, period);
  assert.equal(reference.dimensions?.store_id, String(store.member_id));

  const executeArgs = {
    unit_id: 'p2.reference_deviation',
    contract_version: '0.1.0',
    evidence: { observed: observed.evidence_id, reference: reference.evidence_id },
    parameters: {},
  };
  const first = await call('p2_execute', executeArgs);
  assert.equal(first.status, 'EXECUTED', JSON.stringify(first.error ?? first));
  assert.ok(Number.isFinite(first.result?.absolute_deviation), 'P2 absolute deviation is not finite');
  const second = await call('p2_execute', executeArgs);
  assert.equal(second.status, 'EXECUTED', JSON.stringify(second.error ?? second));
  assert.deepEqual(second.result, first.result, 'Repeated p2.reference_deviation result differs');

  const trace = await call('run_trace', {});
  assert.equal(trace.run?.run_id, runId);
  const events = trace.events ?? [];
  const p2Events = events.filter((event) =>
    event.floor === 'P2'
    && event.tool_name === 'p2_execute'
    && event.status === 'SUCCESS'
    && event.input_json?.unit_id === 'p2.reference_deviation'
    && event.output_json?.status === 'EXECUTED',
  );
  assert.equal(p2Events.length, 2, 'run_trace must contain both P2 executions');
  const tracedEvidence = new Set(events
    .filter((event) => event.floor === 'P1' && event.status === 'SUCCESS')
    .map((event) => event.output_json?.evidence_id)
    .filter(Boolean));
  assert.ok(tracedEvidence.has(observed.evidence_id), 'run_trace is missing SALES P1 evidence');
  assert.ok(tracedEvidence.has(reference.evidence_id), 'run_trace is missing TARGETS P1 evidence');

  console.log(JSON.stringify({
    status: 'PASS',
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    neon_connection_or_fallback: 'NONE',
    unit: 'p2.reference_deviation',
    contract_version: '0.1.0',
    period,
    store_id: String(store.member_id),
    p1_sales: 'P1_CERTIFIED',
    p1_target: 'P1_CERTIFIED',
    deterministic: true,
    run_trace_p1_events: 2,
    run_trace_p2_events: p2Events.length,
    result: first.result,
    run_id: runId,
  }));
} finally {
  await client?.close().catch(() => {});
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
