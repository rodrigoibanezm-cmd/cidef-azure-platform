import pg from 'pg';
const { Pool } = pg;
const azureUrl = process.env.AZURE_DATABASE_URL;
const neonUrl = process.env.NEON_DATABASE_URL;
const sourceFile = process.env.PRICE_SOURCE_FILE;
if (!azureUrl) throw new Error('Missing AZURE_DATABASE_URL');
if (!neonUrl) throw new Error('Missing NEON_DATABASE_URL for read-only parity check');
if (!sourceFile) throw new Error('Missing PRICE_SOURCE_FILE');

const options = { max: 2, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } };
const azure = new Pool({ ...options, connectionString: azureUrl });
const neon = new Pool({ ...options, connectionString: neonUrl, options: '-c default_transaction_read_only=on' });
const fields = [
  'precio_neto','precio_lista','precio_con_iva','bono_cidef','bono_forum','bono_mes',
  'precio_efectivo_pre_mes_sin_iva','precio_efectivo_pre_mes_con_iva',
  'precio_efectivo_final_sin_iva','precio_efectivo_final_con_iva'
];
const sql = `SELECT pv.marca,pv.modelo,COALESCE(pv.version_raw,pv.version) AS version,
  ph.vigencia_desde::text AS vigencia_desde,ph.source_sheet,ph.source_row,
  ${fields.map((f) => `ph.${f}::text AS ${f}`).join(',')}
 FROM price_history ph JOIN price_versions pv USING(price_version_id)
 WHERE ph.vigencia_desde=DATE '2026-10-14' AND ph.source_file=$1`;
const key = (r) => [r.marca,r.modelo,r.version,r.vigencia_desde,r.source_sheet,r.source_row].join('|');
const stable = (r) => Object.fromEntries(fields.map((f) => [f,r[f] == null ? null : String(r[f])]));
try {
  const [azureResult, neonResult] = await Promise.all([
    azure.query(sql,[sourceFile]),
    neon.query(sql,[sourceFile]),
  ]);
  const azureRows = new Map(azureResult.rows.map((row) => [key(row),row]));
  const neonRows = new Map(neonResult.rows.map((row) => [key(row),row]));
  const missing = [...neonRows.keys()].filter((k) => !azureRows.has(k));
  const extra = [...azureRows.keys()].filter((k) => !neonRows.has(k));
  const changed = [...neonRows.keys()].filter((k) => azureRows.has(k) &&
    JSON.stringify(stable(azureRows.get(k))) !== JSON.stringify(stable(neonRows.get(k))));
  const result = {
    source_file:sourceFile,
    vigencia_desde:'2026-10-14',
    neon_rows:neonRows.size,
    azure_rows:azureRows.size,
    missing_in_azure:missing.slice(0,20),
    extra_in_azure:extra.slice(0,20),
    different_values:changed.slice(0,20),
    dongfeng_007_008:azureResult.rows.filter((r)=>r.marca==='DONGFENG'&&['007','008'].includes(r.modelo))
      .map((r)=>({modelo:r.modelo,version:r.version,precio_lista:r.precio_lista,bono_forum:r.bono_forum,precio_efectivo_final_sin_iva:r.precio_efectivo_final_sin_iva}))
  };
  console.log(JSON.stringify(result,null,2));
  if (missing.length || extra.length || changed.length || neonRows.size !== azureRows.size) {
    throw new Error('PRICING_NEON_AZURE_PARITY_FAILED');
  }
} finally {
  await Promise.all([azure.end(),neon.end()]);
}
