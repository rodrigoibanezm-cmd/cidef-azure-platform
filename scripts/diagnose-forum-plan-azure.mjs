// Read-only FORUM plan diagnosis. Session-local planner test; no persistent changes.
import pg from 'pg';

const {Client}=pg;
const client=new Client({
  connectionString:process.env.AZURE_DATABASE_URL,
  ssl:{rejectUnauthorized:false},
  connectionTimeoutMillis:10000,
  statement_timeout:90000,
});
const sql=`SELECT count(*)::bigint AS value
FROM forum_funnel_universe_v01
WHERE (CASE WHEN upper(btrim(distribuidor::text))='CIDEF'
  THEN 'OWN_STORES' ELSE 'DEALERS' END) = 'OWN_STORES'
AND fecha_cotizacion BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'`;

function summarize(plan){
  const nodes=[];
  const visit=(node,depth=0)=>{
    nodes.push({
      depth,node:node['Node Type'],relation:node['Relation Name'],
      join:node['Join Type'],index:node['Index Name'],
      actual_ms:node['Actual Total Time'],loops:node['Actual Loops'],
      rows:node['Actual Rows'],removed_join:node['Rows Removed by Join Filter'],
      removed_filter:node['Rows Removed by Filter'],
      join_filter:node['Join Filter'],
      hash_batches:node['Hash Batches'],
    });
    for(const item of node.Plans??[])visit(item,depth+1);
  };
  visit(plan.Plan);
  return {execution_ms:plan['Execution Time'],planning_ms:plan['Planning Time'],
    result_rows:plan.Plan['Actual Rows'],nodes};
}
async function explain(tag){
  const {rows}=await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql);
  const result=summarize(rows[0]['QUERY PLAN'][0]);
  console.log(JSON.stringify({tag,...result}));
}
try{
  await client.connect();
  const metadata=await client.query(`SELECT
    (SELECT count(*)::bigint FROM forum_funnel_raw) AS raw_rows,
    (SELECT count(DISTINCT numero_operacion)::bigint FROM forum_funnel_raw) AS operations,
    (SELECT count(*)::bigint FROM forum_funnel_universe_v01) AS view_rows,
    pg_get_viewdef('forum_funnel_universe_v01'::regclass,true) AS view_definition`);
  const info=metadata.rows[0];
  console.log(JSON.stringify({tag:'metadata',raw_rows:info.raw_rows,operations:info.operations,
    view_rows:info.view_rows,view_definition:info.view_definition}));
  await explain('default_plan');
  await client.query('BEGIN READ ONLY');
  try{
    await client.query('SET LOCAL enable_nestloop = off');
    await explain('nestloop_disabled_transaction_only');
  }finally{
    await client.query('ROLLBACK');
  }
}finally{
  await client.end();
}
