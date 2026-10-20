import { azureCompatibleSql, closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';
import {
  FORUM_FROM,
  fromForSellerIdentity,
  fromForStoreIdentity,
  normalizedFilters,
  where,
} from '../lib/data-floor/forum/query.js';

const pool = getAzurePool();
const output = {
  database: 'AZURE_POSTGRESQL',
  explain_mode: 'EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE TRUE); ANALYZE was not used.',
};

function queryForDimension(dimension, sourceFrom, filters = {}) {
  const f = normalizedFilters({ filters });
  const w = where(f);
  let idExpr;
  let labelExpr;
  if (dimension === 'STORE') {
    labelExpr = "coalesce(forum_store.nombre_canonico,nullif(btrim(sucursal::text),''),'UNRESOLVED')";
    idExpr = "coalesce(forum_store.sucursal_id::text,'UNRESOLVED:'||coalesce(nullif(btrim(sucursal::text),''),'EMPTY'))";
  } else {
    labelExpr = "coalesce(forum_seller.nombre_canonico,nullif(btrim(vendedor::text),''),'UNRESOLVED')";
    idExpr = "coalesce(forum_seller.persona_id::text,'UNRESOLVED:'||coalesce(nullif(btrim(vendedor::text),''),'EMPTY'))";
  }
  const predicate = "count(*) FILTER (WHERE etapa_certificada='PRECURSE')";
  return {
    sql: "SELECT " + idExpr + " member_id, " + labelExpr +
      " member_label, " + predicate + "::bigint value FROM " + sourceFrom + " " +
      w.sql + " GROUP BY 1,2 HAVING " + predicate + ">0 ORDER BY value DESC,member_label",
    params: w.params,
  };
}

function summarizePlan(plan) {
  const nodes = [];
  const visit = (node) => {
    if (!node) return;
    nodes.push({
      node: node['Node Type'],
      relation: node['Relation Name'],
      index: node['Index Name'],
      rows_estimate: node['Plan Rows'],
      startup_cost: node['Startup Cost'],
      total_cost: node['Total Cost'],
      filter: node['Filter'],
      index_condition: node['Index Cond'],
      join_filter: node['Join Filter'],
      sort_key: node['Sort Key'],
    });
    for (const child of node.Plans || []) visit(child);
  };
  visit(plan);
  return nodes;
}

async function explain(client, name, sql, params = []) {
  const started = Date.now();
  try {
    const result = await client.query({
      text: 'EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE TRUE) ' + azureCompatibleSql(sql),
      values: params,
    });
    const root = result.rows[0]['QUERY PLAN'][0].Plan;
    return {
      name,
      sql,
      parameters: params,
      planning_ms: Date.now() - started,
      root_cost: root['Total Cost'],
      root_rows_estimate: root['Plan Rows'],
      nodes: summarizePlan(root),
      plan_json: result.rows[0]['QUERY PLAN'],
    };
  } catch (error) {
    return { name, sql, parameters: params, planning_ms: Date.now() - started, error: error.message, code: error.code };
  }
}

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '120s'");

    const [sampleAlias] = (await client.query([
      "SELECT sa.sucursal_id::text AS store_id, sm.nombre_canonico AS store_name,",
      "  sa.valor_raw AS raw_alias",
      "FROM sucursal_aliases sa",
      "JOIN sucursales_master sm ON sm.sucursal_id=sa.sucursal_id",
      "WHERE sa.fuente='forum_raw' AND sa.validated=true",
      "  AND nullif(btrim(sa.valor_raw),'') IS NOT NULL",
      "ORDER BY sa.sucursal_alias_id",
      "LIMIT 1",
    ].join('\\n'))).rows;
    output.sample_store_filter = sampleAlias || null;

    const totalSql = "SELECT count(*) FILTER (WHERE etapa_certificada='PRECURSE')::bigint value FROM " + FORUM_FROM;
    const storeQuery = queryForDimension('STORE', fromForStoreIdentity());
    const sellerQuery = queryForDimension('SELLER', fromForSellerIdentity());
    const sellerByStoreQuery = queryForDimension(
      'SELLER',
      fromForSellerIdentity(),
      { store: [sampleAlias?.raw_alias || '__NO_CANONICAL_STORE_ALIAS__'] },
    );

    output.plans = [];
    output.plans.push(await explain(client, 'PRECURSE_COMPANY', totalSql));
    output.plans.push(await explain(client, 'PRECURSE_STORE', storeQuery.sql, storeQuery.params));
    output.plans.push(await explain(client, 'PRECURSE_SELLER_COMPANY', sellerQuery.sql, sellerQuery.params));
    output.plans.push(await explain(client, 'PRECURSE_SELLER_FILTERED_TO_ONE_STORE', sellerByStoreQuery.sql, sellerByStoreQuery.params));

    const relations = await client.query([
      "SELECT n.nspname AS schema_name, c.relname AS relation_name,",
      "  c.relkind, c.reltuples::bigint AS estimated_rows, c.relpages",
      "FROM pg_class c",
      "JOIN pg_namespace n ON n.oid=c.relnamespace",
      "WHERE n.nspname IN ('public','azure_forum_migration')",
      "  AND c.relname IN (",
      "    'forum_funnel_raw','forum_funnel_universe_v01','sucursal_aliases',",
      "    'sucursales_master','persona_aliases','personas_master',",
      "    'producto_aliases_v01','marcas_master_v01'",
      "  )",
      "ORDER BY n.nspname,c.relname",
    ].join('\\n'));
    output.relations = relations.rows;

    const stats = await client.query([
      "SELECT schemaname,relname,n_live_tup::bigint AS estimated_live_rows,",
      "  seq_scan,idx_scan,last_analyze,last_autoanalyze",
      "FROM pg_stat_user_tables",
      "WHERE schemaname IN ('public','azure_forum_migration')",
      "  AND relname IN (",
      "    'forum_funnel_raw','sucursal_aliases','sucursales_master',",
      "    'persona_aliases','personas_master','producto_aliases_v01','marcas_master_v01'",
      "  )",
      "ORDER BY schemaname,relname",
    ].join('\\n'));
    output.table_stats = stats.rows;

    const indexes = await client.query([
      "SELECT schemaname,tablename,indexname,indexdef",
      "FROM pg_indexes",
      "WHERE schemaname IN ('public','azure_forum_migration')",
      "  AND tablename IN (",
      "    'forum_funnel_raw','sucursal_aliases','sucursales_master',",
      "    'persona_aliases','personas_master','producto_aliases_v01','marcas_master_v01'",
      "  )",
      "ORDER BY schemaname,tablename,indexname",
    ].join('\\n'));
    output.indexes = indexes.rows;
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  const report = [
    '# EXPLAIN PRECURSE P1 — PostgreSQL Azure',
    '',
    '- Conexión: Azure PostgreSQL exclusivamente (AZURE_DATABASE_URL).',
    '- Solo lectura (BEGIN READ ONLY).',
    '- EXPLAIN FORMAT JSON, sin ANALYZE; volumen desde catálogos/estadísticas aproximadas.',
    '- P1 pool statement_timeout: 30 s. Este Action da hasta 120 s para planificar EXPLAIN; no ejecuta las consultas explicadas.',
    '',
    '## Filtro de tienda para vendedor por tienda',
    '',
    JSON.stringify(output.sample_store_filter, null, 2),
    '',
    '## Planes PRECURSE',
    '',
    ...output.plans.flatMap((plan) => [
      '### ' + plan.name,
      '',
      'SQL: ' + plan.sql,
      '',
      plan.error ? 'Error EXPLAIN: ' + plan.error : 'Plan resumido:',
      '',
      JSON.stringify(plan.error ? { error: plan.error, code: plan.code } : {
        planning_ms: plan.planning_ms,
        root_cost: plan.root_cost,
        root_rows_estimate: plan.root_rows_estimate,
        nodes: plan.nodes,
      }, null, 2),
      '',
      'Plan JSON completo:',
      '',
      JSON.stringify(plan.plan_json || null, null, 2),
      '',
    ]),
    '## Volumen estimado y estadísticas',
    '',
    JSON.stringify({ relations: output.relations, table_stats: output.table_stats }, null, 2),
    '',
    '## Índices actuales',
    '',
    JSON.stringify(output.indexes, null, 2),
    '',
    'PRECURSE_STORE corresponde a la consulta P1 que falló. Comparar con PRECURSE_SELLER_COMPANY y PRECURSE_SELLER_FILTERED_TO_ONE_STORE para ubicar el costo del universo/joins frente al agrupamiento.',
  ].join('\\n');

  console.log(JSON.stringify(output));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs/promises');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report + '\\n', 'utf8');
  }
} finally {
  await closeAzurePool();
}
