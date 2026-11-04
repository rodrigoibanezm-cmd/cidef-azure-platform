import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAzurePool } from "../lib/azure-postgres.js";

export function isReadOnlyRoute(path) {
  const secret = process.env.MCP_READONLY_TOKEN || "";
  if (secret.length < 32) return false;
  const actual = Buffer.from(path);
  return ["/readonly/" + secret + "/mcp", "/api/mcp/" + secret].some(route => {
    const expected = Buffer.from(route);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  });
}

export function makeReadOnlyServer() {
  const server = new McpServer({ name: "cidef-azure-data-readonly", version: "1.0.0" });
  server.registerTool("pg_query", {
    description: "Query Azure PostgreSQL in a read-only transaction. Results are raw and not P1-certified.",
    inputSchema: { sql: z.string().min(1).max(12000) },
  }, async ({ sql }) => {
    const query = sql.trim().replace(/;\s*$/, "");
    if (!/^(SELECT|WITH|VALUES|TABLE)\b/i.test(query) || query.includes(";")) {
      return { isError: true, content: [{ type: "text", text: "Only one read-only query is allowed" }] };
    }
    const client = await getAzurePool().connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      const result = await client.query(query);
      if (result.rows.length > 500) throw new Error("Result exceeds 500 rows; add LIMIT");
      const json = JSON.stringify({ rowCount: result.rowCount, fields: result.fields.map(f => f.name), rows: result.rows });
      if (Buffer.byteLength(json) > 800000) throw new Error("Result exceeds 800 KB; select fewer columns");
      await client.query("COMMIT");
      return { content: [{ type: "text", text: json }] };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return { isError: true, content: [{ type: "text", text: error.message }] };
    } finally { client.release(); }
  });
  server.registerTool("pg_tables", {
    description: "List accessible base tables and views in Azure PostgreSQL.",
    inputSchema: { schema: z.string().max(128).optional() },
  }, async ({ schema }) => {
    const result = await getAzurePool().query(
      "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND ($1::text IS NULL OR table_schema=$1) ORDER BY 1,2 LIMIT 500",
      [schema || null],
    );
    return { content: [{ type: "text", text: JSON.stringify(result.rows) }] };
  });
  return server;
}
