import { appendFile } from 'node:fs/promises';
import { queryDb } from '../lib/neon.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

// Source: certified cidef-data-loader import-estadisticas-venta.js.
// Its current override list has 51 August VINs and 1 September VIN.
const EXPECTED = new Map([
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

function cleanError(error) {
  let message = String(error?.message ?? error);
  const secret = process.env.AZURE_DATABASE_URL;
  if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]');
  return error?.code ? `${error.code}: ${message}` : message;
}

function dateOnly(value) {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(String(value ?? '').trim());
  return match ? match[1] : null;
}

async function main() {
  if (!process.env.AZURE_DATABASE_URL) throw new Error('AZURE_DATABASE_URL is not configured in the Production environment.');

  const vins = [...EXPECTED.keys()];
  const rows = await queryDb(`
    SELECT upper(btrim(nro_vin_chasis::text)) AS vin, fecha_factura::text AS fecha_factura
    FROM public.ventas_raw
    WHERE upper(btrim(nro_vin_chasis::text)) = ANY($1::text[])
    ORDER BY upper(btrim(nro_vin_chasis::text)), fecha_factura::text
  `, [vins]);

  const byVin = new Map(vins.map((vin) => [vin, []]));
  for (const row of rows) {
    const vin = String(row.vin ?? '').trim().toUpperCase();
    if (byVin.has(vin)) byVin.get(vin).push(row.fecha_factura);
  }

  const results = vins.map((vin) => {
    const dates = byVin.get(vin).map((value) => ({
      fecha_factura: value == null ? null : String(value),
      date: dateOnly(value),
    }));
    const missing = dates.length === 0;
    return {
      vin,
      expected_date: EXPECTED.get(vin),
      status: missing ? 'MISSING' : dates.some((item) => item.date !== EXPECTED.get(vin)) ? 'DATE_MISMATCH' : 'PASS',
      matching_rows: dates.length,
      rows: dates,
    };
  });
  const differences = results.filter((item) => item.status !== 'PASS');
  const report = {
    diagnostic: 'sales_2026_vin_operational_date_overrides',
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    database: 'PostgreSQL Azure via AZURE_DATABASE_URL',
    neon_connection_or_fallback: 'NONE',
    read_only: true,
    certified_source_counts: { august_2026: 51, september_2026: 1, total: 52 },
    checked_vins: results.length,
    pass: results.length - differences.length,
    differences: differences.length,
    status: differences.length ? 'DIFFERENCES_FOUND' : 'PASS',
    results,
  };
  const output = JSON.stringify(report, null, 2);
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## SALES VIN overrides 2026 Azure validation\n\nChecked: ${report.checked_vins}; PASS: ${report.pass}; differences: ${report.differences}.\n\n` +
      `\`\`json\n${output}\n\`\`\`\n`);
  }
  if (differences.length) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    diagnostic: 'sales_2026_vin_operational_date_overrides',
    status: 'BLOCKED',
    error: cleanError(error),
  }));
  process.exitCode = 1;
} finally {
  await closeAzurePool().catch((error) => {
    console.error(JSON.stringify({ cleanup: 'failed', error: cleanError(error) }));
    process.exitCode = 1;
  });
}
