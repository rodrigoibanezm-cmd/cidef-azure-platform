import { queryDb } from '../lib/neon.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

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
FROM public.ventas_raw
WHERE upper(btrim(nro_vin_chasis::text)) = ANY($1::text[])
ORDER BY upper(btrim(nro_vin_chasis::text)), fecha_factura::text`;

function day(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  return /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(String(value ?? '').trim())?.[1] ?? null;
}

function safeError(error) {
  let message = String(error?.message ?? error);
  const secret = process.env.AZURE_DATABASE_URL;
  if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]');
  return error?.code ? `${error.code}: ${message}` : message;
}

async function main() {
  const connectionString = process.env.AZURE_DATABASE_URL;
  if (!connectionString) throw new Error('Missing AZURE_DATABASE_URL in the Production environment');
  let hostname;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    throw new Error('AZURE_DATABASE_URL is invalid');
  }
  if (hostname !== azureHost) throw new Error('AZURE_DATABASE_URL does not point to the approved CIDEF Azure PostgreSQL host');
  if (expected.size !== 52) throw new Error(`Certified override list count changed: ${expected.size}`);
  const augustCount = [...expected.values()].filter((date) => date === '2026-08-31').length;
  const septemberCount = [...expected.values()].filter((date) => date === '2026-09-01').length;
  if (augustCount !== 51 || septemberCount !== 1) throw new Error('Certified override date counts changed');

  const vins = [...expected.keys()];
  const rows = await queryDb(sql, [vins]);
  const byVin = new Map(vins.map((vin) => [vin, []]));
  for (const row of rows) {
    const vin = String(row.vin ?? '').trim().toUpperCase();
    if (byVin.has(vin)) byVin.get(vin).push(day(row.fecha_factura));
  }

  const results = [...expected].map(([vin, expectedDate]) => {
    const actualDates = byVin.get(vin);
    const missing = actualDates.length === 0;
    const duplicate = actualDates.length > 1;
    const dateMismatch = actualDates.some((date) => date !== expectedDate);
    const issues = [];
    if (missing) issues.push('MISSING');
    if (duplicate) issues.push('DUPLICATE');
    if (dateMismatch) issues.push('DATE_MISMATCH');
    return {
      vin,
      expected_date: expectedDate,
      actual_dates: actualDates,
      row_count: actualDates.length,
      status: issues.length ? issues.join('+') : 'PASS',
    };
  });
  const missing = results.filter((row) => row.row_count === 0);
  const duplicates = results.filter((row) => row.row_count > 1);
  const dateMismatches = results.filter((row) => row.actual_dates.some((date) => date !== row.expected_date));
  const report = {
    diagnostic: 'sales_2026_vin_dates_azure',
    database: 'Azure PostgreSQL',
    read_only: true,
    source_literals: { august_2026: 51, september_2026: 1, total: 52 },
    checked_vins: results.length,
    pass: results.filter((row) => row.status === 'PASS').length,
    missing_count: missing.length,
    duplicate_count: duplicates.length,
    date_mismatch_count: dateMismatches.length,
    missing_vins: missing.map(({ vin }) => vin),
    duplicate_vins: duplicates.map(({ vin, row_count }) => ({ vin, row_count })),
    date_mismatches: dateMismatches.map(({ vin, expected_date, actual_dates }) => ({ vin, expected_date, actual_dates })),
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## SALES VIN Azure validation\n\nChecked: ${report.checked_vins}; PASS: ${report.pass}; missing: ${report.missing_count}; duplicates: ${report.duplicate_count}; date mismatches: ${report.date_mismatch_count}.\n\n`);
  }
  if (missing.length || duplicates.length || dateMismatches.length) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ diagnostic: 'sales_2026_vin_dates_azure', status: 'BLOCKED', error: safeError(error) }));
  process.exitCode = 1;
} finally {
  await closeAzurePool().catch(() => {});
}
