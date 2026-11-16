import http from 'node:http';
import { z } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';
import { createMcpServer } from '../lib/mcp/server.js';
import { observePrecurseSnapshotBundle } from '../lib/data-floor/forum/observations.js';
import { buildComoVamos } from './como-vamos.js';
import { runSalesSelectiveProbe } from '../scripts/diagnose-sales-first-cut.mjs';
import { listDataSources, describeDataSource } from '../lib/data-floor/registry.js';

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
  server.registerTool('semantic_catalog', {
    title: 'Commercial semantic catalog',
    description: 'Read-only domain-neutral semantic discovery. Returns existing source contracts without running P1 or querying RAW data.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const sources = listDataSources().map(source => describeDataSource(source));
    const out = { sources };
    return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
  });
  server.registerTool('semantic_plan', {
    title: 'Semantic query planner',
    description: 'Read-only declarative planning from existing source contracts. Returns supported filters and a logical plan; does not execute SQL or certify evidence.',
    inputSchema: {
      source: z.string(),
      filters: z.record(z.string(), z.any()).default({}),
      fields: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ source, filters, fields }) => {
    const contract = describeDataSource(source);
    const unsupportedFilters = Object.keys(filters).filter(key => !contract.filters.includes(key));
    const unsupportedFields = (fields || []).filter(key => !contract.fields.includes(key));
    if (unsupportedFilters.length || unsupportedFields.length) {
      throw new Error('UNSUPPORTED_SEMANTIC_IDENTIFIERS: ' + JSON.stringify({ unsupportedFilters, unsupportedFields }));
    }
    const out = {
      source: contract.source,
      grain: contract.grain,
      filters,
      fields: fields || contract.fields,
      boolean_logic: contract.boolean_logic,
      plan: [
        { operation: 'SOURCE', source: contract.source },
        { operation: 'FILTER', predicates: Object.entries(filters).map(([field, value]) => ({ field, operator: Array.isArray(value) ? 'IN' : 'EQ', value })) },
        { operation: 'PROJECT', fields: fields || contract.fields },
      ],
      status: 'LOGICAL_PLAN_ONLY',
      sql_executed: false,
      certified: false,
    };
    return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
  });
  server.registerTool('semantic_execute', {
    title: 'Selective semantic SQL execution',
    description: 'Read-only SALES candidate VIN retrieval using declared date and optional store filters. Returns raw candidates, never P1-certified sales.',
    inputSchema: {
      source: z.literal('SALES'),
      filters: z.object({
        date_from: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
        date_to: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
        store_id: z.number().int().positive().optional(),
        brand_id: z.number().int().positive().optional(),
        model_id: z.number().int().positive().optional(),
        version_id: z.number().int().positive().optional(),
        commercial_universe: z.enum(['COMPANY', 'OWN_STORES', 'DEALERS']).optional(),
      }).strict(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ source, filters }) => {
    if (filters.date_from > filters.date_to) throw new Error('INVALID_DATE_RANGE');
    const start = performance.now();
    const params = [filters.date_from, filters.date_to];
    const conditions = [
      "btrim(v.categoria_cliente) IN ('Cliente General','Concesionaria')",
      "nullif(btrim(v.nro_vin_chasis),'') IS NOT NULL",
      "CASE WHEN btrim(v.fecha_factura) ~ '^\\\\d{4}-\\\\d{2}-\\\\d{2}' THEN left(btrim(v.fecha_factura),10)::date WHEN btrim(v.fecha_factura) ~ '^\\\\d{1,2}/\\\\d{1,2}/\\\\d{4}' THEN to_date(split_part(btrim(v.fecha_factura),' ',1),'DD/MM/YYYY') ELSE NULL END BETWEEN $1::date AND $2::date",
    ];
    if (filters.store_id != null) {
      params.push(filters.store_id);
      conditions.push(`(EXISTS (SELECT 1 FROM sucursales_master s WHERE s.sucursal_id = ${params.length} AND btrim(s.id_sucursal_vta::text) = btrim(v.id_sucursal_vta::text)) OR EXISTS (SELECT 1 FROM vehiculo_canonico vc WHERE vc.vin = v.nro_vin_chasis AND vc.sucursal_venta_id = ${params.length}))`);
    }
    if (filters.brand_id != null || filters.model_id != null || filters.version_id != null) {
      const productConditions = [];
      if (filters.brand_id != null) {
        params.push(filters.brand_id);
        productConditions.push(`m.marca_id = ${params.length}`);
      }
      if (filters.model_id != null) {
        params.push(filters.model_id);
        productConditions.push(`m.modelo_id = ${params.length}`);
      }
      if (filters.version_id != null) {
        params.push(filters.version_id);
        productConditions.push(`vc.version_id = ${params.length}`);
      }
      const identityMatch = productConditions.join(' AND ');
      conditions.push(`EXISTS (
        SELECT 1 FROM vehiculo_canonico vc
        JOIN versiones_master_v01 ver ON ver.version_id = vc.version_id
        JOIN modelos_master_v01 m ON m.modelo_id = ver.modelo_id
        WHERE vc.vin = v.nro_vin_chasis AND ${identityMatch}
      )`);
    }
    if (filters.commercial_universe === 'OWN_STORES') conditions.push("btrim(v.categoria_cliente) = 'Cliente General'");
    if (filters.commercial_universe === 'DEALERS') conditions.push("btrim(v.categoria_cliente) = 'Concesionaria'");
    const sql = 'SELECT DISTINCT btrim(v.nro_vin_chasis) AS vin FROM ventas_raw v WHERE ' + conditions.join(' AND ') + ' ORDER BY vin';
    const result = await getAzurePool().query(sql, params);
    const out = { source, status: 'RAW_CANDIDATES_NOT_CERTIFIED', filters, candidate_vins: result.rowCount, vins: result.rows.map(row => row.vin), elapsed_ms: Math.round(performance.now() - start), sql_executed: true, certified: false };
    return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
  });
  server.registerTool('sales_selective_probe', {
    title: 'Experimental SALES selective SQL probe',
    description: 'Read-only experimental SALES benchmark. Requires OWN_STORES, brand_id, model_id, store_id, date_from (first day of month), date_to (same month). Compares semantic candidate selection against existing P1. NOT certified evidence.',
    inputSchema: {
      commercial_universe: z.literal('OWN_STORES'),
      brand_id: z.number().int().positive(),
      model_id: z.number().int().positive(),
      store_id: z.number().int().positive(),
      date_from: z.string(),
      date_to: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (filters) => {
    const out = await runSalesSelectiveProbe(filters);
    return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
  });
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

