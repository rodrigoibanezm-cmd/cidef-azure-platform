import http from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';
import { createMcpServer } from '../lib/mcp/server.js';

const PORT = Number(process.env.PORT || 3000);
const MCP_PATH = '/api/mcp';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const AUTH_MODE = process.env.MCP_AUTH_MODE || 'entra';
const LOCAL_TEST_MODE = AUTH_MODE === 'local-test';

if (!['entra', 'local-test'].includes(AUTH_MODE)) {
  throw new Error('MCP_AUTH_MODE must be entra or local-test');
}
if (LOCAL_TEST_MODE && process.env.NODE_ENV === 'production') {
  throw new Error('local-test authentication mode is not permitted in production');
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Missing required environment variable: ' + name);
  return value;
}

const TENANT_ID = LOCAL_TEST_MODE ? null : required('MCP_ENTRA_TENANT_ID');
const CLIENT_ID = LOCAL_TEST_MODE ? null : required('MCP_ENTRA_CLIENT_ID');
const PUBLIC_URL = LOCAL_TEST_MODE ? null : required('MCP_PUBLIC_URL').replace(/\/$/, '');
const ISSUER = LOCAL_TEST_MODE ? null : `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const JWKS = LOCAL_TEST_MODE ? null : createRemoteJWKSet(
  new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`),
);
const BIND_ADDRESS = LOCAL_TEST_MODE ? '127.0.0.1' : '0.0.0.0';

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

function oauthMetadata() {
  return {
    resource: `${PUBLIC_URL}${MCP_PATH}`,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ['header'],
    scopes_supported: [`api://${CLIENT_ID}/access_as_user`, 'openid', 'profile', 'offline_access'],
  };
}

async function authorize(req, res) {
  if (LOCAL_TEST_MODE) return true;

  const header = req.headers.authorization || '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (!token) {
    sendJson(res, 401, { error: 'unauthorized' }, {
      'www-authenticate': `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    });
    return false;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: [CLIENT_ID, `api://${CLIENT_ID}`],
    }));
  } catch {
    sendJson(res, 401, { error: 'invalid_token' }, {
      'www-authenticate': 'Bearer error="invalid_token"',
    });
    return false;
  }

  const scopes = String(payload.scp || '').split(/\s+/).filter(Boolean);
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  if (!payload.oid && !payload.sub) {
    sendJson(res, 401, { error: 'invalid_token' });
    return false;
  }
  if (!scopes.includes('access_as_user')
    && !roles.some((role) => /^pg[._](read|write|admin)$/i.test(String(role)))) {
    sendJson(res, 403, { error: 'token lacks MCP access scope or role' });
    return false;
  }
  return true;
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
  if (req.method === 'GET' && [
    '/.well-known/oauth-protected-resource',
    `${MCP_PATH}/.well-known/oauth-protected-resource`,
    `/.well-known/oauth-protected-resource${MCP_PATH}`,
  ].includes(pathname)) {
    return sendJson(res, 200, oauthMetadata(), { 'cache-control': 'public, max-age=300' });
  }
  if (pathname !== MCP_PATH) {
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }
  if (!await authorize(req, res)) return;
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
  console.log(JSON.stringify({ event: 'startup', port: PORT, endpoint: MCP_PATH, auth: LOCAL_TEST_MODE ? 'loopback-test' : 'entra' }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    httpServer.close(async () => {
      await closeAzurePool().catch(() => {});
      process.exit(0);
    });
  });
}

