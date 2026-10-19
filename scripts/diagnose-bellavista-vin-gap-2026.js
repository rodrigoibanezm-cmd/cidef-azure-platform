import { appendFile } from 'node:fs/promises';
import { queryDb } from '../lib/neon.js';
import { closeAzurePool } from '../lib/azure-postgres.js';

const AZURE_HOST = 'cidef-postgres-prod.postgres.database.azure.com';
const CUTOFF = '2026-10-18';
const MONTH_START = '2026-10-01';
const ADMIN_ENDPOINT = 'https://cidef-inteligencia-comercial.calmforest-1c67ab46.chilecentral.azurecontainerapps.io/api/weekly-projections/admin';
const DATE_SQL = `(CASE WHEN trim(v.fecha_factura::text) ~ '^[0-9]+$' THEN DATE '1899-12-30' + trim(v.fecha_factura::text)::integer ELSE nullif(trim(v.fecha_factura::text),'')::date END)`;

function clean(error) {
  let message = String(error?.message ?? error);
  const secret = process.env.AZURE_DATABASE_URL;
  if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]');
  return error?.code ? `${error.code}: ${message}` : message;
}

function norm(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function unique(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

async function fetchAdmin() {
  const url = new URL(ADMIN_ENDPOINT);
  url.searchParams.set('week_start', '2026-10-12');
  url.searchParams.set('cutoff_date', CUTOFF);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`/admin returned HTTP ${response.status}`);
    const json = await response.json();
    if (json?.ok !== true || !Array.isArray(json?.sales_mtd?.details)) {
      throw new Error('/admin response lacks sales_mtd.details');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function loadCreditNotes(vins, invoices, operations) {
  const metadata = await queryDb(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notas_credito_raw'
    ORDER BY ordinal_position
  `);
  const columnNames = metadata.map((row) => row.column_name);
  if (!columnNames.length) return { table_exists: false, matching_rows: [] };

  const safeColumns = columnNames.filter((name) =>
    /^(id|.*(vin|chasis|fecha|date|factura|folio|operacion|tipo|estado|motivo|referencia).*)$/i.test(name)
    && !/(cliente|rut|nombre|razon_social|email|telefono|direccion)/i.test(name));
  const vinColumns = columnNames.filter((name) => /vin|chasis/i.test(name));
  const invoiceColumns = columnNames.filter((name) => /factura|folio/i.test(name) && !/(cliente|rut)/i.test(name));
  const operationColumns = columnNames.filter((name) => /operacion/i.test(name) && !/(cliente|rut)/i.test(name));
  const clauses = [];
  const params = [];
  const add = (columns, values) => {
    const entries = unique(values);
    if (!columns.length || !entries.length) return;
    const slot = `$${params.push(entries)}`;
    for (const column of columns) {
      const ident = '"' + column.replaceAll('"', '""') + '"';
      clauses.push(`${ident}::text = ANY(${slot}::text[])`);
    }
  };
  add(vinColumns, vins);
  add(invoiceColumns, invoices);
  add(operationColumns, operations);
  if (!clauses.length || !safeColumns.length) return { table_exists: true, matching_rows: [], safe_columns: safeColumns };
  const ident = (name) => '"' + name.replaceAll('"', '""') + '"';
  const rows = await queryDb(`
    SELECT ${safeColumns.map(ident).join(', ')}
    FROM public.notas_credito_raw
    WHERE ${clauses.join(' OR ')}
    ORDER BY 1
    LIMIT 500
  `, params);
  return { table_exists: true, matching_rows: rows, matched_on_columns: [...new Set([...vinColumns, ...invoiceColumns, ...operationColumns])] };
}

async function main() {
  const connectionString = process.env.AZURE_DATABASE_URL;
  if (!connectionString) throw new Error('Missing AZURE_DATABASE_URL in the Production environment');
  const host = new URL(connectionString).hostname;
  if (host !== AZURE_HOST) throw new Error('AZURE_DATABASE_URL does not point to the approved CIDEF Azure PostgreSQL host');

  const dateExpr = DATE_SQL;
  const rawRows = await queryDb(`
    SELECT v.id::text AS raw_id,
      upper(trim(v.nro_vin_chasis::text)) AS vin,
      ${dateExpr}::text AS fecha_factura,
      coalesce(v.nro_factura::text, v.factura::text) AS numero_factura,
      v.factura::text AS factura,
      v.nro_factura::text AS nro_factura,
      v.nro_operacion::text AS nro_operacion,
      v.id_sucursal_vta::text AS id_sucursal_raw,
      v.desc_sucursal_vta AS sucursal_raw,
      sm.sucursal_id::text AS sucursal_id_canonica,
      sm.nombre_canonico AS sucursal_canonica,
      v.nombre_usuario AS vendedor_raw,
      pe.persona_id::text AS vendedor_persona_id,
      pe.nombre_canonico AS vendedor_canonico,
      pe.usuario_canonico AS usuario_canonico,
      coalesce(pe.match_count, 0) AS vendedor_login_match_count,
      v.categoria_cliente
    FROM public.ventas_raw v
    LEFT JOIN public.sucursales_master sm
      ON lower(trim(sm.nombre_canonico)) = lower(trim(regexp_replace(v.desc_sucursal_vta, '^Sucursal\\s+', '', 'i')))
      OR lower(trim(sm.nombre_canonico)) = lower(trim('CIDEF ' || regexp_replace(v.desc_sucursal_vta, '^Sucursal\\s+', '', 'i')))
      OR (lower(trim(v.desc_sucursal_vta))='sucursal plaza alameda' AND sm.sucursal_id=19)
      OR (lower(trim(v.desc_sucursal_vta))='sucursal plaza sur' AND sm.sucursal_id=9)
      OR (lower(trim(v.desc_sucursal_vta))='sucursal plaza egaña' AND sm.sucursal_id=11)
      OR (lower(trim(v.desc_sucursal_vta))='sucursal plaza norte' AND sm.sucursal_id=8)
      OR (lower(trim(v.desc_sucursal_vta))='sucursal plaza oeste' AND sm.sucursal_id=10)
      OR (lower(trim(v.desc_sucursal_vta))='sucursal quilin' AND sm.sucursal_id=21)
      OR (lower(trim(v.desc_sucursal_vta))='costanera' AND sm.sucursal_id=22)
    LEFT JOIN LATERAL (
      SELECT (array_agg(DISTINCT persona_id::text ORDER BY persona_id::text))[1] AS persona_id,
        (array_agg(DISTINCT nombre_canonico ORDER BY nombre_canonico))[1] AS nombre_canonico,
        (array_agg(DISTINCT usuario_canonico ORDER BY usuario_canonico))[1] AS usuario_canonico,
        count(DISTINCT persona_id)::int AS match_count
      FROM public.personas_master
      WHERE upper(trim(usuario_canonico))=upper(trim(v.nombre_usuario))
    ) pe ON true
    WHERE ${dateExpr} BETWEEN $1::date AND $2::date
      AND nullif(trim(v.nro_vin_chasis::text),'') IS NOT NULL
      AND (
        lower(trim(regexp_replace(coalesce(v.desc_sucursal_vta,''), '^Sucursal\\s+', '', 'i'))) LIKE '%bellavista%'
        OR lower(coalesce(sm.nombre_canonico,'')) LIKE '%bellavista%'
      )
    ORDER BY upper(trim(v.nro_vin_chasis::text)), ${dateExpr}, v.id
  `, [MONTH_START, CUTOFF]);

  const endpoint = await fetchAdmin();
  const endpointDetails = endpoint.sales_mtd.details;
  const bellavistaDetails = endpointDetails.filter((row) => norm(row.sucursal).includes('bellavista'));
  const rawVins = unique(rawRows.map((row) => row.vin));
  const eligibleRawRows = rawRows.filter((row) => String(row.categoria_cliente ?? '').trim() === 'Cliente General');
  const eligibleRawVins = unique(eligibleRawRows.map((row) => row.vin));
  const allEndpointByVin = new Map();
  for (const row of endpointDetails) {
    const vin = String(row.vin ?? '').trim().toUpperCase();
    if (!vin) continue;
    if (!allEndpointByVin.has(vin)) allEndpointByVin.set(vin, []);
    allEndpointByVin.get(vin).push(row);
  }
  const bellavistaByVin = new Map();
  for (const row of bellavistaDetails) {
    const vin = String(row.vin ?? '').trim().toUpperCase();
    if (!vin) continue;
    if (!bellavistaByVin.has(vin)) bellavistaByVin.set(vin, []);
    bellavistaByVin.get(vin).push(row);
  }

  const aliasRows = await queryDb(`
    SELECT a.valor_raw, a.tipo_alias, a.validated AS alias_validated,
      p.persona_id::text, p.nombre_canonico, p.usuario_canonico,
      p.validated AS persona_validated
    FROM public.persona_aliases a
    JOIN public.personas_master p ON p.persona_id=a.persona_id
    WHERE lower(trim(p.nombre_canonico))=lower($1)
    ORDER BY a.valor_raw
  `, ['Virginia Tampoa']);
  const virginiaAliasKeys = new Set(aliasRows.map((row) => norm(row.valor_raw)));
  const virginiaCanonNames = new Set(aliasRows.map((row) => norm(row.nombre_canonico)));
  const virginiaCanonicalRows = bellavistaDetails.filter((row) =>
    norm(row.vendedor_nombre) === norm('Virginia Tampoa'));
  const virginiaAliasRows = bellavistaDetails.filter((row) =>
    norm(row.vendedor_nombre) !== norm('Virginia Tampoa')
    && (virginiaAliasKeys.has(norm(row.vendedor)) || virginiaCanonNames.has(norm(row.vendedor))));
  const virginiaRows = [...new Map([...virginiaCanonicalRows, ...virginiaAliasRows]
    .map((row) => [String(row.vin ?? '').toUpperCase(), row])).values()];

  const rawSellers = unique(rawRows.map((row) => row.vendedor_raw));
  const rawAliasRows = rawSellers.length ? await queryDb(`
    SELECT a.valor_raw, a.tipo_alias, a.validated AS alias_validated,
      p.persona_id::text, p.nombre_canonico, p.usuario_canonico,
      p.validated AS persona_validated
    FROM public.persona_aliases a
    JOIN public.personas_master p ON p.persona_id=a.persona_id
    WHERE lower(trim(a.valor_raw)) = ANY($1::text[])
    ORDER BY lower(a.valor_raw), p.nombre_canonico
  `, [rawSellers.map(norm)]) : [];
  const aliasByRaw = new Map();
  for (const row of rawAliasRows) {
    const key = norm(row.valor_raw);
    if (!aliasByRaw.has(key)) aliasByRaw.set(key, []);
    aliasByRaw.get(key).push(row);
  }

  const invoices = rawRows.flatMap((row) => [row.numero_factura, row.factura, row.nro_factura]);
  const operations = rawRows.map((row) => row.nro_operacion);
  const creditNotes = await loadCreditNotes(rawVins, invoices, operations);

  const missingFromAdmin = eligibleRawVins.filter((vin) => !bellavistaByVin.has(vin));
  const assignedElsewhere = missingFromAdmin.map((vin) => ({
    vin,
    endpoint_rows: allEndpointByVin.get(vin) ?? [],
  })).filter((item) => item.endpoint_rows.length);
  const excludedFromAdmin = missingFromAdmin.filter((vin) => !allEndpointByVin.has(vin));
  const rawCounts = new Map();
  for (const row of rawRows) rawCounts.set(row.vin, (rawCounts.get(row.vin) ?? 0) + 1);
  const duplicateRaw = [...rawCounts.entries()].filter(([, count]) => count > 1).map(([vin]) => vin);
  const duplicateAdmin = [...bellavistaByVin.entries()].filter(([, rows]) => rows.length > 1).map(([vin, rows]) => ({ vin, row_count: rows.length }));
  const noSeller = rawRows.filter((row) => !String(row.vendedor_raw ?? '').trim() || !row.vendedor_canonico);
  const adminVirginiaCount = virginiaCanonicalRows.length;
  const report = {
    diagnostic: 'bellavista_vin_gap_2026-10-01_2026-10-18',
    database: 'Azure PostgreSQL',
    read_only: true,
    pii_policy: 'No customer RUT, customer name, or customer contact fields were queried or emitted.',
    endpoint: `${ADMIN_ENDPOINT}?week_start=2026-10-12&cutoff_date=${CUTOFF}`,
    period: { from: MONTH_START, through: CUTOFF },
    counts: {
      raw_bellavista_rows: rawRows.length,
      raw_bellavista_distinct_vins: rawVins.length,
      raw_cliente_general_rows: eligibleRawRows.length,
      raw_cliente_general_distinct_vins: eligibleRawVins.length,
      admin_company_rows: endpointDetails.length,
      admin_bellavista_rows: bellavistaDetails.length,
      admin_bellavista_distinct_vins: bellavistaByVin.size,
      admin_virginia_tampoa_rows: adminVirginiaCount,
      admin_rows_with_raw_seller_alias_for_virginia: virginiaAliasRows.length,
      raw_duplicate_vins: duplicateRaw.length,
      admin_duplicate_vins: duplicateAdmin.length,
      raw_rows_without_seller: noSeller.length,
      raw_vins_missing_from_admin_bellavista: missingFromAdmin.length,
      missing_vins_assigned_elsewhere_in_admin: assignedElsewhere.length,
      missing_vins_absent_from_admin_company: excludedFromAdmin.length,
      credit_note_match_rows: creditNotes.matching_rows.length,
    },
    raw_bellavista_records: rawRows.map((row) => ({
      vin: row.vin,
      fecha_factura: row.fecha_factura,
      numero_factura: row.numero_factura,
      sucursal_raw: row.sucursal_raw,
      sucursal_canonica: row.sucursal_canonica,
      sucursal_id_canonica: row.sucursal_id_canonica,
      vendedor_raw: row.vendedor_raw,
      vendedor_canonico: row.vendedor_canonico,
      vendedor_persona_id: row.vendedor_persona_id,
      vendedor_login_match_count: row.vendedor_login_match_count,
      aliases_for_raw_seller: aliasByRaw.get(norm(row.vendedor_raw)) ?? [],
      categoria_cliente: row.categoria_cliente,
      raw_row_id: row.raw_id,
    })),
    admin_bellavista_vins: bellavistaDetails.map((row) => ({
      vin: String(row.vin ?? '').toUpperCase(),
      fecha_factura: row.fecha_venta,
      numero_factura: row.factura,
      sucursal_id: row.sucursal_id,
      sucursal: row.sucursal,
      vendedor_raw: row.vendedor,
      vendedor_canonico: row.vendedor_nombre,
      vendedor_persona_id: row.persona_id,
    })),
    raw_vins_missing_from_admin_bellavista: missingFromAdmin.map((vin) => ({
      vin,
      raw_records: rawRows.filter((row) => row.vin === vin).map((row) => ({
        fecha_factura: row.fecha_factura,
        numero_factura: row.numero_factura,
        sucursal_raw: row.sucursal_raw,
        sucursal_canonica: row.sucursal_canonica,
        vendedor_raw: row.vendedor_raw,
        vendedor_canonico: row.vendedor_canonico,
        categoria_cliente: row.categoria_cliente,
      })),
      endpoint_company_rows: allEndpointByVin.get(vin) ?? [],
    })),
    duplicate_raw_vins: duplicateRaw,
    duplicate_admin_vins: duplicateAdmin,
    raw_rows_without_seller: noSeller.map((row) => ({ vin: row.vin, fecha_factura: row.fecha_factura, numero_factura: row.numero_factura, vendedor_raw: row.vendedor_raw, vendedor_canonico: row.vendedor_canonico, categoria_cliente: row.categoria_cliente })),
    virginia_tampoa_aliases: aliasRows,
    admin_virginia_tampoa_vins: virginiaRows.map((row) => ({ vin: row.vin, fecha_factura: row.fecha_venta, vendedor_raw: row.vendedor, vendedor_canonico: row.vendedor_nombre, persona_id: row.persona_id })),
    endpoint_rows_matching_virginia_alias_but_not_canonical_name: virginiaAliasRows.map((row) => ({ vin: row.vin, fecha_factura: row.fecha_venta, vendedor_raw: row.vendedor, vendedor_canonico: row.vendedor_nombre, persona_id: row.persona_id })),
    credit_notes: creditNotes,
    reconciliation: {
      powerbi_bellavista_reported: 24,
      admin_bellavista_observed: bellavistaByVin.size,
      powerbi_virginia_tampoa_reported: 14,
      admin_virginia_tampoa_observed: adminVirginiaCount,
      explanation: bellavistaByVin.size === 24 && adminVirginiaCount === 14 ? 'Azure /admin matches the reported counts; any remaining difference is outside this query.' : 'See missing, duplicate, seller, category, and credit-note details above; no business rules or records were changed.',
    },
  };
  const output = JSON.stringify(report, null, 2);
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '# Bellavista October VIN diagnostic', '',
      `- Azure raw: ${rawVins.length} distinct VIN / ${rawRows.length} rows`,
      `- Azure /admin: ${bellavistaByVin.size} Bellavista VIN; Virginia Tampoa: ${adminVirginiaCount}`,
      `- VINs absent from Azure /admin Bellavista: ${missingFromAdmin.length}`,
      `- Possible credit note matches: ${creditNotes.matching_rows.length}`,
      '', 'Full VIN-level evidence is in the job log JSON; no customer RUT or name was selected.',
    ].join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ diagnostic: 'bellavista_vin_gap_2026-10', status: 'BLOCKED', error: clean(error) }));
  process.exitCode = 1;
} finally {
  await closeAzurePool().catch((error) => {
    console.error(JSON.stringify({ cleanup: 'failed', error: clean(error) }));
    process.exitCode = 1;
  });
}
