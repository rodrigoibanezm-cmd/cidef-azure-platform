import { customGptDb } from '../custom-gpt/db.js';
import { buildVentasContext } from '../ventas/buildVentasContext.js';

export const COMMERCIAL_UNIVERSES = Object.freeze(['COMPANY', 'OWN_STORES', 'DEALERS']);
const UNIVERSE_SET = new Set(COMMERCIAL_UNIVERSES);

export function parseCommercialUniverse(value, fallback = 'COMPANY') {
  const normalized = String(value ?? fallback).trim().toUpperCase();
  if (!UNIVERSE_SET.has(normalized)) {
    const error = new Error(`INVALID_COMMERCIAL_UNIVERSE: ${value}`);
    error.code = 'INVALID_COMMERCIAL_UNIVERSE';
    throw error;
  }
  return normalized;
}

export async function loadCommercialIdentityMap(sql = customGptDb()) {
  const rows = await sql.query(`
    SELECT
      vc.vin,
      vc.canal_salida,
      vc.sucursal_venta_id,
      vc.dealer_id,
      vc.dealer_group_id,
      vc.resolution_status,
      sm.nombre_canonico AS sucursal_venta_nombre,
      dm.nombre_comercial AS dealer_nombre,
      dg.nombre_canonico AS dealer_group_nombre
    FROM vehiculo_canonico vc
    LEFT JOIN sucursales_master sm ON sm.sucursal_id = vc.sucursal_venta_id
    LEFT JOIN dealers_master dm ON dm.dealer_id = vc.dealer_id
    LEFT JOIN dealer_groups dg ON dg.dealer_group_id = vc.dealer_group_id
  `);
  return new Map(rows.map((row) => [String(row.vin), row]));
}

export async function loadHistoricalSalesChannelMap(sql = customGptDb()) {
  const rows = await sql.query(`
    SELECT id_sucursal_vta, sucursal_id, tipo_canal, nombre_canonico
    FROM sucursales_master
    WHERE id_sucursal_vta IS NOT NULL
  `);
  return new Map(rows.map((row) => [String(row.id_sucursal_vta).trim(), row]));
}

export async function loadDealerBuyerMap(sql = customGptDb()) {
  const rows = await sql.query(`
    SELECT
      d.dealer_id,
      d.rut_normalizado,
      d.nombre_comercial AS dealer_nombre,
      d.dealer_group_id,
      dg.nombre_canonico AS dealer_group_nombre
    FROM dealers_master d
    LEFT JOIN dealer_groups dg ON dg.dealer_group_id = d.dealer_group_id
    WHERE d.rut_normalizado IS NOT NULL
  `);
  return new Map(rows.map((row) => [String(row.rut_normalizado).replace(/[^0-9]/g, ''), row]));
}

function saleBuyerRut(sale) {
  const normalized = String(sale?.cliente ?? '').replace(/[^0-9]/g, '');
  return normalized || null;
}

function customerCategoryUniverse(sale) {
  const category = String(sale?.categoria_cliente ?? '').trim().toUpperCase();
  if (category === 'CLIENTE GENERAL') return 'OWN_STORES';
  if (category === 'CONCESIONARIA') return 'DEALERS';
  return null;
}

export function classifyHistoricalSale(sale, historicalSalesChannelMap, dealerBuyerMap = null) {
  const buyerRut = saleBuyerRut(sale);

  const sourceKey = sale.sucursal_source_key == null ? null : String(sale.sucursal_source_key).trim();
  const branch = historicalSalesChannelMap instanceof Map && sourceKey != null
    ? historicalSalesChannelMap.get(sourceKey) ?? null
    : null;
  const buyer = dealerBuyerMap instanceof Map ? dealerBuyerMap.get(buyerRut) ?? null : null;

  // Source customer category governs channel when recognized; buyer identity is fallback.
  const categoryUniverse = customerCategoryUniverse(sale);
  if (categoryUniverse != null) return { universe: categoryUniverse, branch, buyer: categoryUniverse === 'DEALERS' ? buyer : null };
  if (buyerRut == null) return null;

  // Fallback never derives channel from the operational source branch.
  // FORUM is the certified dealer intermediary; exact dealer-master buyers are DEALERS.
  // Every other recognized buyer belongs to OWN_STORES. Branch identity is destination metadata only.
  if (buyerRut === '96726670' || buyer != null) {
    return { universe: 'DEALERS', branch, buyer };
  }
  return { universe: 'OWN_STORES', branch, buyer: null };
}

export function classifyCommercialRow(row) {
  if (!row) return 'UNRESOLVED';
  if (row.canal_salida === 'TIENDA_PROPIA') return 'OWN_STORES';
  if (row.canal_salida === 'DEALER') return 'DEALERS';
  return 'UNRESOLVED';
}

export function certifyRecognizedSaleCommercially(
  sale,
  commercialMap,
  historicalSalesChannelMap = null,
  dealerBuyerMap = null,
) {
  const canonical = sale?.vin == null ? null : commercialMap.get(String(sale.vin));
  const historical = classifyHistoricalSale(sale, historicalSalesChannelMap, dealerBuyerMap);
  const classified = historical?.universe ?? classifyCommercialRow(canonical);
  const historicalResolved = historical != null && classified !== 'UNRESOLVED';

  return {
    ...sale,
    canonical_commercial_universe: classified,
    canal_salida: classified === 'OWN_STORES' ? 'TIENDA_PROPIA'
      : classified === 'DEALERS' ? 'DEALER' : null,
    sucursal_venta_id: classified === 'OWN_STORES'
      ? (historical?.branch?.sucursal_id ?? canonical?.sucursal_venta_id ?? null) : null,
    sucursal_venta_nombre: classified === 'OWN_STORES'
      ? (historical?.branch?.nombre_canonico ?? canonical?.sucursal_venta_nombre ?? null) : null,
    dealer_id: classified === 'DEALERS' ? (historical?.buyer?.dealer_id ?? canonical?.dealer_id ?? null) : null,
    dealer_nombre: classified === 'DEALERS' ? (historical?.buyer?.dealer_nombre ?? canonical?.dealer_nombre ?? null) : null,
    dealer_group_id: classified === 'DEALERS' ? (historical?.buyer?.dealer_group_id ?? canonical?.dealer_group_id ?? null) : null,
    dealer_group_nombre: classified === 'DEALERS' ? (historical?.buyer?.dealer_group_nombre ?? canonical?.dealer_group_nombre ?? null) : null,
    commercial_resolution_status: historical
      ? (historicalResolved ? 'RESOLVED_HISTORICAL_SALE' : 'UNRESOLVED_HISTORICAL_SALE')
      : (canonical?.resolution_status ?? 'UNRESOLVED'),
    commercial_channel_authority: customerCategoryUniverse(sale) != null
      ? 'ventas_raw.categoria_cliente'
      : historical ? 'recognized_sale.cliente+dealers_master.rut_normalizado'
      : 'vehiculo_canonico_fallback',
    commercial_destination_authority: classified === 'OWN_STORES' && historical?.branch?.sucursal_id != null
      ? 'recognized_sale.sucursal_source_key+sucursales_master'
      : classified === 'DEALERS' && historical?.buyer?.dealer_id != null
        ? 'recognized_sale.cliente+dealers_master.rut_normalizado'
        : canonical ? 'vehiculo_canonico_metadata' : null,
  };
}

function validateScopedSale(sale, universe) {
  if (universe === 'OWN_STORES') {
    if (sale.canal_salida !== 'TIENDA_PROPIA') return 'OWN_STORES_CONTAINS_NON_STORE';
    if (sale.dealer_id != null) return 'OWN_STORES_CONTAINS_DEALER_ID';
  }
  if (universe === 'DEALERS') {
    if (sale.canal_salida !== 'DEALER') return 'DEALERS_CONTAINS_NON_DEALER';
    if (sale.sucursal_venta_id != null) return 'DEALERS_CONTAINS_STORE_ID';
  }
  return null;
}

export function scopeRecognizedSalesToCommercialUniverse({ recognizedSales, commercialMap, historicalSalesChannelMap = null, dealerBuyerMap = null, universe }) {
  if (!Array.isArray(recognizedSales)) throw new Error('recognizedSales is required');
  if (!(commercialMap instanceof Map)) throw new Error('commercialMap is required');
  const commercialUniverse = parseCommercialUniverse(universe);

  const coverage = {
    recognized_sales: recognizedSales.length,
    included_sales: 0,
    excluded_other_universe: 0,
    unresolved_channel: 0,
    unresolved_destination: 0,
    null_vin_sales: 0,
  };
  const violations = [];
  const sales = [];

  for (const sale of recognizedSales) {
    const certified = certifyRecognizedSaleCommercially(
      sale, commercialMap, historicalSalesChannelMap, dealerBuyerMap,
    );
    const classified = certified.canonical_commercial_universe;
    if (sale.vin == null) coverage.null_vin_sales += 1;
    if (classified === 'UNRESOLVED') coverage.unresolved_channel += 1;

    const include = commercialUniverse === 'COMPANY' || classified === commercialUniverse;
    if (!include) {
      coverage.excluded_other_universe += 1;
      continue;
    }

    const scoped = {
      ...certified,
      commercial_universe: commercialUniverse,
    };

    if ((classified === 'OWN_STORES' && scoped.sucursal_venta_id == null)
      || (classified === 'DEALERS' && scoped.dealer_id == null)) {
      coverage.unresolved_destination += 1;
    }

    const violation = validateScopedSale(scoped, commercialUniverse);
    if (violation) violations.push({ vin: sale.vin ?? null, code: violation });
    sales.push(scoped);
  }

  coverage.included_sales = sales.length;
  const valid = violations.length === 0;
  return {
    commercial_scope: {
      universe: commercialUniverse,
      authority: 'certified_recognized_sale',
      valid,
      scope_id: 'ventas_commercial_context_v01',
    },
    sales,
    coverage,
    validation: { valid, violations },
  };
}

function sourceContext(ventasContext, cutoffDate, cutoffMonth, options) {
  return {
    motor: 'ventas_context_v01',
    cutoff_date: cutoffDate,
    cutoff_month: cutoffMonth,
    ...(options.includeSourceContextDetails === true ? {
      version: ventasContext.version,
      effective_cutoff_date: ventasContext.cutoff_date,
      effective_cutoff_month: ventasContext.cutoff_month,
      coverage: ventasContext.coverage,
      validation: ventasContext.validation,
      warnings: ventasContext.warnings,
      policy: ventasContext.policy,
    } : {}),
  };
}

export async function buildVentasCommercialContexts(input = {}, universes = [], options = {}) {
  const requestedUniverses = [...new Set(universes.map((universe) =>
    parseCommercialUniverse(universe)))];
  if (!requestedUniverses.length) throw new Error('at least one commercial universe is required');
  const cutoffDate = input.cutoff_date ?? input.date_to ?? input.cutoffDate ?? null;
  const cutoffMonth = input.cutoff_month ?? input.cutoffMonth ?? null;
  const sql = customGptDb();
  const [ventasContext, commercialMap, historicalSalesChannelMap, dealerBuyerMap] = await Promise.all([
    buildVentasContext({ cutoffDate, cutoffMonth }),
    loadCommercialIdentityMap(sql),
    loadHistoricalSalesChannelMap(sql),
    loadDealerBuyerMap(sql),
  ]);
  return new Map(requestedUniverses.map((universe) => [universe, {
    ...scopeRecognizedSalesToCommercialUniverse({
      recognizedSales: ventasContext.recognizedSales,
      commercialMap,
      historicalSalesChannelMap,
      dealerBuyerMap,
      universe,
    }),
    source_context: sourceContext(ventasContext, cutoffDate, cutoffMonth, options),
  }]));
}

export async function buildVentasCommercialContext(input = {}, options = {}) {
  const universe = parseCommercialUniverse(input.commercial_universe ?? input.universe);
  const contexts = await buildVentasCommercialContexts(input, [universe], options);
  return contexts.get(universe);
}
