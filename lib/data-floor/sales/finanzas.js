import { customGptDb } from '../../custom-gpt/db.js';
import { calculateVentasContext } from '../../ventas/buildVentasContext.js';
import { recognizedSale } from '../../ventas/ventasContextUtils.js';
import { parseFechaFactura } from '../../ventas/parseFechaFactura.js';
import { scopeRecognizedSalesToCommercialUniverse } from '../../ventas-commercial/buildVentasCommercialContext.js';
import { assembleVentasUniverse } from '../../ventas-universe/buildVentasUniverse.js';

export const salesQuantity = row => row.finanzas_cantidad ?? 1;
export const salesTotal = rows => rows.reduce((sum, row) => sum + salesQuantity(row), 0);
const text = value => String(value ?? '').trim();
const key = (vin, invoice) => JSON.stringify([text(vin), text(invoice)]);
const BRANDS = { FOTON: 'FOTON', DFM: 'DONGFENG', DFLM: 'DONGFENG' };

export async function loadFinanzasRows(sql = customGptDb()) {
  const [exists] = await sql.query("SELECT to_regclass('public.finanzas_ventas') AS relation");
  if (!exists?.relation) return [];
  return sql.query(`SELECT f.*, to_char(f.fecha_documento,'YYYY-MM-DD') AS fecha_documento,
    a.sha256 AS cierre_sha256 FROM finanzas_ventas f
    JOIN finanzas_cierre_archivos a USING (periodo) ORDER BY f.periodo,f.fila_excel`);
}

// Replace only periods with an imported accounting close. Never run LAST-by-VIN
// on accounting movements: an invoice and its credit note remain separate rows.
export function applyFinanzasUniverse(u, input, cutoff = null) {
  const movements = (input.finanzas ?? []).filter(row => !cutoff || row.periodo <= cutoff.slice(0,7));
  if (!movements.length) return u;
  const periods = new Set(movements.map(row => row.periodo));
  const invoices = new Map();
  for (const row of input.rows) for (const invoice of new Set([row.nro_factura,row.factura].map(text).filter(Boolean))) {
    const k = key(row.nro_vin_chasis, invoice);
    if (!invoices.has(k)) invoices.set(k, []);
    invoices.get(k).push(row);
  }
  const sales = movements.filter(row => !cutoff || row.fecha_documento <= cutoff).map(row => {
    const parsed = parseFechaFactura(row.fecha_documento);
    if (!parsed || parsed.error || parsed.month !== row.periodo ||
      !BRANDS[row.marca] || row.cantidad !== (row.tipo_documento === 'FAC-EL' ? 1 : row.tipo_documento === 'N/C-EL' ? -1 : 0))
      throw new Error('INVALID_FINANZAS_MOVEMENT: ' + row.periodo + ':' + row.fila_excel);
    const invoice = row.tipo_documento === 'FAC-EL' ? row.numero_documento : row.factura;
    const candidates = invoice ? invoices.get(key(row.vin, invoice)) ?? [] : [];
    const original = calculateVentasContext(candidates, { cutoffDate: row.fecha_documento }).recognizedSales[0];
    // Missing source identity stays unresolved; never assign channels from the
    // accounting branch label, buyer RUT, or a similar model name.
    const sale = original ?? recognizedSale({}, parsed, 'FINANZAS_MOVEMENT', row.vin);
    return { ...sale, source_id: 'finanzas:' + row.periodo + ':' + row.fila_excel,
      sales_source_id: original?.source_id ?? null, finanzas_cantidad: row.cantidad,
      finanzas_marca: BRANDS[row.marca], finanzas_periodo: row.periodo,
      fecha_venta_iso: parsed.date.toISOString(), fecha_venta: row.fecha_documento,
      mes_venta: row.periodo, factura: row.numero_documento, nro_factura: row.numero_documento,
      recognition_basis: 'FINANZAS_SIGNED_MOVEMENT' };
  });
  const commercial = scopeRecognizedSalesToCommercialUniverse({ recognizedSales: sales,
    commercialMap: input.commercialMap, historicalSalesChannelMap: input.historicalSalesChannelMap,
    dealerBuyerMap: input.dealerBuyerMap, universe: u.commercial_universe });
  const finance = assembleVentasUniverse({ ...commercial, source_context: {
    cutoff_date: cutoff, validation: { ok: true }, version: 'finanzas.v1',
    policy: { recognition: 'one signed accounting movement; no VIN deduplication' },
  } }, input.resources);
  const events = finance.analytical_events.map(row => {
    const brand = input.resources.catalogs.brands.get(row.finanzas_marca);
    if (!brand) throw new Error('FINANZAS_BRAND_NOT_RESOLVED: ' + row.finanzas_marca);
    const sameBrand = String(row.marca_id) === String(brand.marca_id);
    return { ...row, marca_id: brand.marca_id, marca_nombre: brand.marca,
      ...(sameBrand ? {} : { modelo_id: null, modelo_nombre: null, version_id: null, version_nombre: null,
        product_identity_status: 'UNRESOLVED', brand_identity_status: 'RESOLVED' }) };
  });
  const retained = u.analytical_events.filter(row => !periods.has(row.mes_venta));
  const closes = [...new Map(movements.map(row => [row.periodo, row.cierre_sha256])).entries()];
  return { ...u, analytical_events: [...retained, ...events],
    validation: { ...u.validation, valid: u.validation.valid && finance.validation.valid },
    coverage: { legacy_sales: u.coverage, finanzas: { periods: [...periods], movements: events.length, net_units: salesTotal(events),
      unresolved_channel_movements: events.filter(row => row.canonical_commercial_universe === 'UNRESOLVED').length } },
    lineage: { ...u.lineage, finanzas: { source: 'finanzas_ventas', closes,
      aggregation: 'SUM(cantidad)', identity: 'periodo + fila_excel',
      metadata: 'exact VIN + invoice in SALES; existing canonical VIN fallback',
      period_rule: 'Finanzas when close exists; SALES otherwise' } } };
}
