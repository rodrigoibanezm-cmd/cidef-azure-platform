import http from "node:http";
import crypto from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT || 3000);
const TENANT_ID = required("MCP_ENTRA_TENANT_ID");
const CLIENT_ID = required("MCP_ENTRA_CLIENT_ID");
const PUBLIC_URL = required("MCP_PUBLIC_URL").replace(/\/$/, "");
const DATABASE_URL = required("DATABASE_URL");
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const JWKS = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`));
const pool = new Pool({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 10000, statement_timeout: 30000 });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function audit(event) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), category: "security", ...event }));
}

function metadata() {
  return {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: [`api://${CLIENT_ID}/access_as_user`, "openid", "profile", "offline_access"],
    resource_documentation: "https://learn.microsoft.com/azure/container-apps/mcp-authentication"
  };
}

async function authorize(req, res) {
  const header = req.headers.authorization || "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (!token) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: [CLIENT_ID, `api://${CLIENT_ID}`]
    });
    const scopes = String(payload.scp || "").split(/\s+/).filter(Boolean);
    if (!payload.oid && !payload.sub) throw new Error("Token has no user or client identity");
    const roles = Array.isArray(payload.roles) ? payload.roles : [];
    const permissions = new Set([...scopes, ...roles].map(value => String(value).toLowerCase()));
    if (!scopes.includes("access_as_user") && !roles.some(role => /^pg[._](read|write|admin)$/i.test(role))) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "token lacks MCP access scope or role" }));
      return null;
    }
    const admin = ["pg.admin", "pg_admin"].some(role => permissions.has(role));
    const write = admin || ["pg.write", "pg_write"].some(role => permissions.has(role));
    const read = scopes.includes("access_as_user") || admin || write || ["pg.read", "pg_read"].some(role => permissions.has(role));
    return { subject: payload.oid || payload.sub, name: payload.name || payload.preferred_username || "service-principal", permissions: { read, write, admin } };
  } catch (error) {
    audit({ action: "auth.reject", reason: error.message });
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer error=\"invalid_token\"" });
    res.end(JSON.stringify({ error: "invalid_token" }));
    return null;
  }
}

function ensureSingleStatement(sql) {
  const statements = sql.trim().replace(/;\s*$/, "");
  if (!statements || statements.includes(";")) throw new Error("Only one SQL statement per call is allowed");
  return statements;
}

function rejectDangerousAdminSql(sql) {
  if (/\b(DROP\s+(DATABASE|ROLE|USER)|ALTER\s+(ROLE|USER)|CREATE\s+(ROLE|USER)|GRANT\s+|REVOKE\s+)\b/i.test(sql)) {
    throw new Error("Role, user, and database-level security changes are blocked");
  }
}

async function runSql(sql, mode) {
  const statement = ensureSingleStatement(sql);
  if (mode === "read" && !/^(SELECT|WITH|SHOW|EXPLAIN)\b/i.test(statement)) {
    throw new Error("pg_query accepts read-only SELECT, WITH, SHOW, and EXPLAIN statements");
  }
  if (mode === "write" && !/^(INSERT|UPDATE|DELETE|WITH)\b/i.test(statement)) {
    throw new Error("pg_execute accepts INSERT, UPDATE, DELETE, and write CTE statements");
  }
  if (mode === "admin") rejectDangerousAdminSql(statement);

  const client = await pool.connect();
  const started = Date.now();
  const hash = crypto.createHash("sha256").update(statement).digest("hex");
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    if (mode === "read") await client.query("SET TRANSACTION READ ONLY");
    const result = await client.query(statement);
    await client.query("COMMIT");
    audit({ action: `postgres.${mode}`, statement_sha256: hash, duration_ms: Date.now() - started, rows: result.rowCount ?? 0, status: "success" });
    return { command: result.command, rowCount: result.rowCount, fields: result.fields.map(f => f.name), rows: result.rows };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    audit({ action: `postgres.${mode}`, statement_sha256: hash, duration_ms: Date.now() - started, status: "error", sqlstate: error.code || "unknown" });
    throw error;
  } finally {
    client.release();
  }
}

function makeServer(principal) {
  const server = new McpServer({ name: "cidef-azure-postgres", version: "1.0.0" });
  for (const [name, mode, description] of [
    ["pg_query", "read", "Run one read-only SQL query against Azure PostgreSQL."],
    ["pg_execute", "write", "Run one INSERT, UPDATE, DELETE, or write CTE against Azure PostgreSQL."],
    ["pg_admin", "admin", "Run one schema administration statement against Azure PostgreSQL. Role and database security changes are blocked."]
  ]) {
    if (!principal.permissions[mode]) continue;
    server.registerTool(name, {
      description,
      inputSchema: { sql: z.string().min(1).max(100000) }
    }, async ({ sql }) => {
      try {
        const result = await runSql(sql, mode);
        audit({ action: "mcp.tool", tool: name, subject: principal.subject, status: "success" });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        audit({ action: "mcp.tool", tool: name, subject: principal.subject, status: "error" });
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    });
  }
  return server;
}

const httpServer = http.createServer(async (req, res) => {
  const path = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method === "GET" && path === "/readyz") {
    try {
      await pool.query("SELECT 1");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ready", database: "connected" }));
    } catch {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ status: "not_ready" }));
    }
    return;
  }
  if (req.method === "GET" && ["/.well-known/oauth-protected-resource", "/mcp/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(path)) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" }).end(JSON.stringify(metadata()));
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404).end("Not found");
    return;
  }

  const principal = await authorize(req, res);
  if (!principal) return;
  audit({ action: "mcp.request", subject: principal.subject, method: req.method });

  let body;
  if (req.method === "POST") {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw new Error("Request body too large");
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
  }
  const mcp = makeServer(principal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    audit({ action: "mcp.transport", subject: principal.subject, status: "error", message: error.message });
    if (!res.headersSent) res.writeHead(500).end("MCP request failed");
  } finally {
    await transport.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
});

httpServer.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ event: "startup", port: PORT, endpoint: "/mcp" })));
process.on("SIGTERM", async () => {
  await pool.end();
  httpServer.close(() => process.exit(0));
});
