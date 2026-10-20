import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';
import { createMcpServer } from '../lib/mcp/server.js';
import { observePrecurseSnapshotBundle } from '../lib/data-floor/forum/observations.js';
import { buildComoVamos } from './como-vamos.js';

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = '/api/mcp';
const COMO_VAMOS_PATH = '/api/como-vamos';
const PRECURSE_SNAPSHOT_PATH = '/api/precurse-snapshot';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const BIND_ADDRESS = '0.0.0.0';

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('REQUEST_BODY_TOO_LARGE'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, statusCode, value, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}

const httpServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (req.method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok' });
  }
  if (req.method === 'GET' && pathname === '/readyz') {
    try {
      await getAzurePool().query('SELECT 1');
      return sendJson(res, 200, { status: 'ready', database: 'connected' });
    } catch {
      return sendJson(res, 503, { status: 'not_ready' });
    }
  }
  if (pathname === PRECURSE_SNAPSHOT_PATH) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
    try {
      const bundle = await observePrecurseSnapshotBundle({ filters: { network: ['OWN_STORES'] } });
      return sendJson(res, 200, { ok: true, ...bundle }, { 'cache-control': 'no-store, max-age=0' });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error?.message || 'PRECURSE_SNAPSHOT_FAILED' }, { 'cache-control': 'no-store, max-age=0' });
    }
  }
  if (pathname === COMO_VAMOS_PATH) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET' });
    const url = new URL(req.url || '/', 'http://localhost');
    const requested = url.searchParams.get('period');
    const period = requested || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }).slice(0, 7);
    try {
      const result = await buildComoVamos(period);
      return sendJson(res, 200, result, { 'cache-control': 'no-store, max-age=0' });
    } catch (error) {
      const status = error?.message === 'INVALID_PERIOD' ? 400 : 500;
      return sendJson(res, status, { error: error?.message || 'COMO_VAMOS_FAILED' }, { 'cache-control': 'no-store, max-age=0' });
    }
  }
  if (pathname !== MCP_PATH) {
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error: error.statusCode === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'INVALID_JSON',
    });
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: 'MCP_REQUEST_FAILED' });
    else res.destroy();
  }
});

httpServer.listen(PORT, BIND_ADDRESS, () => {
  console.log(JSON.stringify({ event: 'startup', port: PORT, endpoint: MCP_PATH }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    httpServer.close(async () => {
      await closeAzurePool().catch(() => {});
      process.exit(0);
    });
  });
}

