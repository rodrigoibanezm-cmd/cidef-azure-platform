import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../lib/mcp/server.js';
import { listDataSources } from '../lib/data-floor/registry.js';

async function availableTools(mode) {
  const prior = process.env.CIDEF_MCP_TOOL_SURFACE;
  if (mode == null) delete process.env.CIDEF_MCP_TOOL_SURFACE;
  else process.env.CIDEF_MCP_TOOL_SURFACE = mode;
  const server = createMcpServer();
  const client = new Client({ name: 'surface-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
    if (prior === undefined) delete process.env.CIDEF_MCP_TOOL_SURFACE;
    else process.env.CIDEF_MCP_TOOL_SURFACE = prior;
  }
}

test('unified surface keeps one factual tool, P2 and the run trace', async () => {
  const tools = await availableTools();
  const names = tools.map(t => t.name);
  assert.deepEqual(names.sort(), [
    'data_query','p2_discover','p2_describe','p2_execute','run_trace',
  ].sort());
  const query = tools.find(t => t.name === 'data_query');
  for (const source of listDataSources()) {
    assert.ok(query.description.includes(source + ' — measures:'), source);
  }
  assert.deepEqual(query.inputSchema.required.sort(), ['run_id','source','request'].sort());
});

test('legacy compatibility restores existing MCP tool surface', async () => {
  const names = (await availableTools('legacy')).map(t => t.name);
  assert.ok(names.includes('data_observe'));
  assert.ok(names.includes('data_fetch'));
  assert.ok(names.includes('data_describe'));
  assert.ok(names.includes('research'));
  assert.ok(names.includes('data_query'));
  assert.ok(names.includes('p2_execute'));
});
