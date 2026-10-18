import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const expectedTools = [
  'data_describe',
  'data_inspect',
  'data_fetch',
  'data_resolve',
  'data_observe',
  'crm_observe_many',
  'sales_observe_many',
  'sales_observe_windows',
  'p2_discover',
  'p2_describe',
  'p2_execute',
  'run_trace',
];

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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error('MCP process exited before becoming ready');
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('MCP process did not become ready');
}

let child;
let client;
try {
  let mcpUrl = process.env.MCP_SMOKE_URL;
  if (!mcpUrl) {
    const port = await unusedPort();
    const childEnv = { ...process.env, PORT: String(port) };
    for (const key of ['AZURE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL']) {
      delete childEnv[key];
    }
    child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
      env: childEnv,
      stdio: 'ignore',
    });
    mcpUrl = `http://127.0.0.1:${port}/api/mcp`;
  }

  const healthUrl = new URL('/healthz', mcpUrl);
  await waitForHealth(healthUrl, child);

  client = new Client({ name: 'motor-test-azure-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...expectedTools].sort());

  console.log(JSON.stringify({
    startup: 'PASS',
    http_transport: 'PASS',
    tool_count: names.length,
    registered_tools: 'PASS',
    database_credentials_supplied: false,
  }));
} finally {
  await client?.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(3000),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
