import pg from 'pg';
const { Client } = pg;
const neonUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
const azureUrl = process.env.AZURE_DATABASE_URL;
const expected = new Map([
  ['LVAV2MAB2TU485673', '2026-08-31'],
  ['LGJE5EE01TM514771', '2026-08-31'],
  ['LVAV2MAB9TU488506', '2026-08-31'],
  ['LGJE5EE09TM529146', '2026-08-31'],
  ['LVAV2JVBXTE321994', '2026-08-31'],
  ['LGJE5EE06TM521408', '2026-08-31'],
  ['LVAV2JVB3TE322341', '2026-08-31'],
  ['LVAV2JVB6TE322656', '2026-08-31'],
  ['LMXA14AG6VZ352968', '2026-08-31'],
  ['LVAV2MAB9TU490143', '2026-08-31'],
  ['LVAV2MAB3TU485424', '2026-08-31'],
  ['LVAV2MAB8TU490148', '2026-08-31'],
  ['LGJE1EE24TM534185', '2026-08-31'],
  ['LVAV2AVB3TE354755', '2026-08-31'],
  ['LVAV2MAB7TU460042', '2026-08-31'],
  ['LVAV2MAB9TU486237', '2026-08-31'],
  ['LVAV2AVB2TE222571', '2026-08-31'],
  ['LVAV2AVB5TE355163', '2026-08-31'],
  ['LVAV2AVB9TE322327', '2026-08-31'],
  ['LMXA14AG6VZ352954', '2026-08-31'],
  ['LVAV2MAB8TU485435', '2026-08-31'],
  ['LVAV2MAB2TU485429', '2026-08-31'],
  ['LMXA14AG9VZ357825', '2026-08-31'],
  ['LVAV2MAB3TU451953', '2026-08-31'],
  ['LGJE1EE22TM553981', '2026-08-31'],
  ['LVAV2MAB1TU486734', '2026-08-31'],
  ['LGJE1EE26TM554003', '2026-08-31'],
  ['LVAV2JVB4TE321229', '2026-08-31'],
  ['LMXA14AG7VZ357726', '2026-08-31'],
  ['LVAV2MAB2TU475726', '2026-08-31'],
  ['LVAV2AVBXTE322188', '2026-08-31'],
  ['LVAV2MAB6TU486230', '2026-08-31'],
  ['LVAV2MAB0TU490144', '2026-08-31'],
  ['LVAV2JVBXTE353649', '2026-08-31'],
  ['LVAV2MAB1TU486703', '2026-08-31'],
  ['LGJE5EE09TM429810', '2026-08-31'],
  ['LMXA14AF4VZ354807', '2026-08-31'],
  ['LGJE5EE09TM521404', '2026-08-31'],
  ['LVAV2JVB2TE321231', '2026-08-31'],
  ['LMXA14AG1VZ352943', '2026-08-31'],
  ['LMXA14AG7VZ352977', '2026-08-31'],
  ['LMXA14AF2VZ354806', '2026-08-31'],
  ['LMXA14AG5VZ352931', '2026-08-31'],
  ['LGJE1EE22TM554001', '2026-08-31'],
  ['LVAV2JVB9TE321906', '2026-08-31'],
  ['LVAV2MAB8TU480610', '2026-08-31'],
  ['LVAV2AVB4TE321408', '2026-08-31'],
  ['LMXA14AF0TZ350217', '2026-08-31'],
  ['LGJE5EE00TM529147', '2026-08-31'],
  ['LVAV2JVB8TE321413', '2026-08-31'],
  ['LVAV2MAB5TU484422', '2026-08-31'],
  ['LGJE5EE06TM529038', '2026-09-01'],
]);
const azureHost = 'cidef-postgres-prod.postgres.database.azure.com';
const sql = `SELECT upper(btrim(nro_vin_chasis::text)) AS vin, fecha_factura::text AS fecha_factura
FROM public.ventas_raw WHERE upper(btrim(nro_vin_chasis::text)) = ANY($1::text[])
ORDER BY upper(btrim(nro_vin_chasis::text)), fecha_factura::text`;

function safeError(error) {
  let message = String(error?.message ?? error);
  for (const secret of [neonUrl, azureUrl].filter(Boolean)) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]');
  return error?.code ? `${error.code}: ${message}` : message;
}
function host(url, label) {
  try { return new URL(url).hostname; } catch { throw new Error(`${label} connection URL is invalid`); }
}
function day(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  return /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(String(value ?? '').trim())?.[1] ?? null;
}
function canonical(rows) {
  const map = new Map([...expected.keys()].map(v => [v, []]));
  for (const row of rows) {
    const vin = String(row.vin ?? '').trim().toUpperCase();
    if (map.has(vin)) map.get(vin).push(day(row.fecha_factura));
  }
  for (const dates of map.values()) dates.sort((a,b)=>String(a).localeCompare(String(b)));
  return map;
}
async function readOnlySnapshot(url) {
  const client = new Client({ connectionString:url, ssl:{rejectUnauthorized:false}, connectionTimeoutMillis:15000, statement_timeout:30000 });
  let inTx = false;
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTx = true;
    const result = await client.query(sql, [[...expected.keys()]]);
    await client.query('ROLLBACK');
    inTx = false;
    return result.rows;
  } finally {
    if (inTx) await client.query('ROLLBACK').catch(()=>{});
    await client.end().catch(()=>{});
  }
}
function same(left,right) {
  const a=canonical(left),b=canonical(right);
  return [...expected.keys()].every(v=>JSON.stringify(a.get(v))===JSON.stringify(b.get(v)));
}
async function main() {
  if (!neonUrl) throw new Error('Missing Neon source secret: configure NEON_DATABASE_URL, DATABASE_URL or POSTGRES_URL in Production.');
  if (!azureUrl) throw new Error('Missing AZURE_DATABASE_URL in Production.');
  if (!host(neonUrl,'Neon').endsWith('.neon.tech')) throw new Error('Configured source is not a Neon host.');
  if (host(azureUrl,'Azure')!==azureHost) throw new Error('AZURE_DATABASE_URL does not point to the approved CIDEF Azure PostgreSQL host.');
  if (expected.size!==52) throw new Error(`Certified override list count changed: ${expected.size}`);

  const neon1=await readOnlySnapshot(neonUrl), azure1=await readOnlySnapshot(azureUrl);
  const neon2=await readOnlySnapshot(neonUrl), azure2=await readOnlySnapshot(azureUrl);
  const n=canonical(neon1), a=canonical(azure1);
  const repeatable=same(neon1,neon2)&&same(azure1,azure2);
  const results=[...expected].map(([vin,date])=>{
    const nd=n.get(vin), ad=a.get(vin);
    const status=!nd.length?'MISSING_IN_NEON':!ad.length?'MISSING_IN_AZURE':
      JSON.stringify(nd)!==JSON.stringify(ad)?'NEON_AZURE_DIFFERENCE':
      !nd.every(x=>x===date)?'NEON_EXPECTED_DATE_MISMATCH':
      !ad.every(x=>x===date)?'AZURE_EXPECTED_DATE_MISMATCH':'PASS';
    return {vin,expected_date:date,neon_dates:nd,azure_dates:ad,status};
  });
  const differences=results.filter(x=>x.status!=='PASS');
  const report={diagnostic:'sales_2026_vin_neon_azure_parity',read_only:true,
    source_override_counts:{august_2026:51,september_2026:1,total:52},
    checked_vins:results.length,repeatable_read_results:repeatable,
    pass:results.length-differences.length,differences:differences.length,
    status:differences.length||!repeatable?'DIFFERENCES_FOUND':'PASS',results};
  const output=JSON.stringify(report,null,2);
  console.log(output);
  if(process.env.GITHUB_STEP_SUMMARY) {
    const {appendFile}=await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## SALES VIN Neon/Azure parity\n\nVIN: ${report.checked_vins}; PASS: ${report.pass}; differences: ${report.differences}; repeatable reads: ${report.repeatable_read_results}.\n\n`);
  }
  if(differences.length||!repeatable) process.exitCode=1;
}
try { await main(); }
catch(error) {
  console.error(JSON.stringify({diagnostic:'sales_2026_vin_neon_azure_parity',status:'BLOCKED',error:safeError(error)}));
  process.exitCode=1;
}
