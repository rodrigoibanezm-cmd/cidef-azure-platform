import { appendFile } from 'node:fs/promises';
import { queryDb } from '../lib/neon.js';
import { closeAzurePool } from '../lib/azure-postgres.js';
import { buildVentasCommercialContexts } from '../lib/ventas-commercial/buildVentasCommercialContext.js';

const PERIOD = '2022-10';
const STORE_ID = '15';
const EARLY_CUTOFF = '2022-10-21';
const CLOSE_CUTOFF = '2022-10-31';

function safeSale(row) {
  return {
    vin: row.vin ?? null,
    source_id: row.source_id ?? null,
    fecha_venta: row.fecha_venta ?? null,
    fecha_venta_iso: row.fecha_venta_iso ?? null,
    mes_venta: row.mes_venta ?? null,
    recognition_basis: row.recognition_basis ?? null,
    factura: row.factura ?? null,
    nro_factura: row.nro_factura ?? null,
    nro_operacion: row.nro_operacion ?? null,
    sucursal_source_key: row.sucursal_source_key ?? null,
    sucursal_venta_id: row.sucursal_venta_id ?? null,
    sucursal_venta_nombre: row.sucursal_venta_nombre ?? null,
    categoria_cliente: row.categoria_cliente ?? null,
    canal_salida: row.canal_salida ?? null,
    commercial_channel_authority: row.commercial_channel_authority ?? null,
    commercial_destination_authority: row.commercial_destination_authority ?? null,
  };
}

function storeSales(context) {
  return (context?.sales ?? []).filter((row) =>
    row.mes_venta === PERIOD
    && String(row.sucursal_venta_id ?? '') === STORE_ID
    && row.vin != null);
}

function qIdent(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

function clean(error) {
  let message = String(error?.message ?? error);
  const secret = process.env.AZURE_DATABASE_URL;
  if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"'\]}]+/gi, '[redacted connection string]');
  return error?.code ? error.code + ': ' + message : message;
}

async function loadCreditNotes(candidates) {
  const metadata = await queryDb(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notas_credito_raw'
    ORDER BY ordinal_position
  `);
  const columnNames = metadata.map((row) => row.column_name);
  if (!columnNames.length) return { table_exists: false, columns: [], matching_rows: [] };

  const vinColumns = columnNames.filter((name) => /vin|chasis/i.test(name));
  const operationColumns = columnNames.filter((name) => /operacion/i.test(name));
  const invoiceColumns = columnNames.filter((name) => /factura/i.test(name));
  const safeColumns = columnNames.filter((name) =>
    /^(id|.*(vin|chasis|fecha|date|factura|operacion|folio|nro_|numero|tipo|estado|motivo|referencia).*)$/i.test(name)
    && !/(cliente|rut|nombre|razon_social)/i.test(name));
  const clauses = [];
  const params = [];
  const addGroup = (columns, values) => {
    const valuesToMatch = [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
    if (!columns.length || !valuesToMatch.length) return;
    const placeholder = '$' + (params.push(valuesToMatch));
    for (const column of columns) clauses.push(`${qIdent(column)}::text = ANY(${placeholder}::text[])`);
  };
  addGroup(vinColumns, candidates.map((row) => row.vin));
  addGroup(operationColumns, candidates.map((row) => row.nro_operacion));
  addGroup(invoiceColumns, candidates.flatMap((row) => [row.factura, row.nro_factura]));
  if (!clauses.length || !safeColumns.length) {
    return { table_exists: true, columns: safeColumns, matching_rows: [], queryable_match_columns: [...vinColumns, ...operationColumns, ...invoiceColumns] };
  }

  const matchingRows = await queryDb(`
    SELECT ${safeColumns.map(qIdent).join(', ')}
    FROM public.notas_credito_raw
    WHERE ${clauses.join(' OR ')}
    LIMIT 100
  `, params);
  return {
    table_exists: true,
    columns: safeColumns,
    queryable_match_columns: [...new Set([...vinColumns, ...operationColumns, ...invoiceColumns])],
    matching_rows: matchingRows,
  };
}

async function main() {
  if (!process.env.AZURE_DATABASE_URL) {
    throw new Error('AZURE_DATABASE_URL is not configured in the Production environment.');
  }

  const early = (await buildVentasCommercialContexts(
    { cutoff_date: EARLY_CUTOFF }, ['OWN_STORES'],
  )).get('OWN_STORES');
  const close = (await buildVentasCommercialContexts(
    { cutoff_date: CLOSE_CUTOFF }, ['OWN_STORES'],
  )).get('OWN_STORES');

  const earlySales = storeSales(early);
  const closeSales = storeSales(close);
  const closeVins = new Set(closeSales.map((row) => String(row.vin)));
  const earlyVins = new Set(earlySales.map((row) => String(row.vin)));
  const earlyOnly = earlySales.filter((row) => !closeVins.has(String(row.vin)));
  const closeOnly = closeSales.filter((row) => !earlyVins.has(String(row.vin)));
  const candidates = [...new Map(earlyOnly.map((row) => [String(row.vin), row])).values()];

  const vinValues = candidates.map((row) => String(row.vin));
  const rawRows = vinValues.length ? await queryDb(`
    SELECT id, nro_vin_chasis, fecha_factura, id_sucursal_vta, desc_sucursal_vta,
           categoria_cliente, nro_operacion, factura, nro_factura, nro_propuesta
    FROM public.ventas_raw
    WHERE btrim(nro_vin_chasis::text) = ANY($1::text[])
    ORDER BY btrim(nro_vin_chasis::text), fecha_factura, id
  `, [vinValues]) : [];

  const sourceKeys = [...new Set(rawRows.map((row) => String(row.id_sucursal_vta ?? '').trim()).filter(Boolean))];
  const branchRows = sourceKeys.length ? await queryDb(`
    SELECT id_sucursal_vta, sucursal_id, tipo_canal, nombre_canonico
    FROM public.sucursales_master
    WHERE btrim(id_sucursal_vta::text) = ANY($1::text[])
       OR sucursal_id::text = $2
    ORDER BY id_sucursal_vta, sucursal_id
  `, [sourceKeys, STORE_ID]) : [];

  const canonicalRows = vinValues.length ? await queryDb(`
    SELECT vin, canal_salida, sucursal_venta_id, dealer_id, resolution_status
    FROM public.vehiculo_canonico
    WHERE vin::text = ANY($1::text[])
  `, [vinValues]) : [];
  const creditNotes = await loadCreditNotes(candidates);

  const report = {
    diagnostic: 'sales_oct_2022_store_15_vin',
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    neon_connection_or_fallback: 'NONE',
    read_only_queries: true,
    period: PERIOD,
    store_id: STORE_ID,
    cutoff_counts: {
      [EARLY_CUTOFF]: earlySales.length,
      [CLOSE_CUTOFF]: closeSales.length,
    },
    expected_counts_match_action: earlySales.length === 25 && closeSales.length === 24,
    early_only_vins: earlyOnly.map(safeSale),
    close_only_vins: closeOnly.map(safeSale),
    candidate_raw_sales_rows: rawRows,
    store_master_assignments: branchRows,
    vehicle_canonical_assignments: canonicalRows,
    credit_notes: creditNotes,
    interpretation: 'The certified SALES recognition rule selects one row per non-null VIN using the latest fecha_factura available by each cutoff. Notes-credit rows are inspected as evidence; they do not enter the original SALES row query.',
  };
  const output = JSON.stringify(report, null, 2);
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## SALES historical VIN diagnostic\n\n\`\`\`json\n${output}\n\`\`\`\n`);
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ diagnostic: 'sales_oct_2022_store_15_vin', status: 'BLOCKED', error: clean(error) }));
  process.exitCode = 1;
} finally {
  await closeAzurePool().catch((error) => {
    console.error(JSON.stringify({ cleanup: 'failed', error: clean(error) }));
    process.exitCode = 1;
  });
}
