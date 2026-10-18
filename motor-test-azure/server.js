import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../lib/mcp/server.js';

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = '/api/mcp';
const MAX_BODY_BYTES = 5 * 1024 * 1024;

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

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`motor-test Azure MCP listening on port ${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => httpServer.close(() => process.exit(0)));
}
