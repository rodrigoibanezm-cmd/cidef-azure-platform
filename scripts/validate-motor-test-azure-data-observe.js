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

const runId = 'azure-sales-p3-' + randomUUID();
const now = new Date();
const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const period = previousMonth.toISOString().slice(0, 7);
const port = await unusedPort();
const mcpUrl = 'http://127.0.0.1:' + port + '/api/mcp';
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../motor-test-azure/server.js', import.meta.url)),
], {
  env: { ...process.env, PORT: String(port), NODE_ENV: 'test', MCP_AUTH_MODE: 'local-test' },
  stdio: 'ignore',
});
let client;
try {
  await waitForHealth(new URL('/healthz', mcpUrl), child);
  client = new Client({ name: 'motor-test-azure-data-observe-validation', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const name of ['data_describe', 'data_observe', 'run_trace']) {
    assert.ok(toolNames.has(name), 'Required MCP tool is missing: ' + name);
  }

  const description = structured(await client.callTool({
    name: 'data_describe',
    arguments: { run_id: runId, source: 'SALES' },
  }), 'data_describe');
  assert.equal(description.source, 'SALES');
  assert.ok(description.measures?.some((measure) => measure.id === 'VIN_SALES'));

  const evidence = structured(await client.callTool({
    name: 'data_observe',
    arguments: {
      run_id: runId,
      source: 'SALES',
      measure: 'VIN_SALES',
      evidence_shape: 'QUANTITATIVE_OBSERVATION',
      period,
      filters: { commercial_universe: 'COMPANY' },
    },
  }), 'data_observe');

  assert.equal(evidence.authority, 'P1_CERTIFIED');
  assert.equal(evidence.status, 'CERTIFIED');
  assert.equal(evidence.source, 'SALES');
  assert.equal(evidence.operation, 'OBSERVE');
  assert.equal(evidence.measure?.id, 'VIN_SALES');
  assert.equal(evidence.universe?.commercial_universe, 'COMPANY');
  assert.ok(Number.isSafeInteger(evidence.payload?.value) && evidence.payload.value > 0);
  assert.ok(evidence.evidence_id);
  const periodStart = period + '-01';
  const periodEnd = new Date(Date.UTC(
    previousMonth.getUTCFullYear(),
    previousMonth.getUTCMonth() + 1,
    0,
  )).toISOString().slice(0, 10);
  assert.equal(evidence.temporal?.date_from, periodStart);
  assert.equal(evidence.temporal?.date_to, periodEnd);

  const trace = structured(await client.callTool({
    name: 'run_trace',
    arguments: { run_id: runId },
  }), 'run_trace');
  assert.equal(trace.run?.run_id, runId);
  assert.equal(trace.run?.floor, 'ROOT');
  const event = trace.events?.find((item) =>
    item.run_id === runId
    && item.floor === 'P1'
    && item.tool_name === 'data_observe'
    && item.status === 'SUCCESS'
    && item.input_json?.source === 'SALES'
    && item.input_json?.measure === 'VIN_SALES'
    && item.output_json?.evidence_id === evidence.evidence_id,
  );
  assert.ok(event, 'run_trace did not return the successful P1 SALES evidence event');

  console.log(JSON.stringify({
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    neon_connection_or_fallback: 'NONE',
    mcp_http_transport: 'PASS',
    required_tools: 'PASS',
    data_describe: 'PASS',
    data_observe: 'PASS',
    p1_authority: evidence.authority,
    period,
    sales_value: evidence.payload.value,
    p3_journal_event: 'PASS',
    run_trace: 'PASS',
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
