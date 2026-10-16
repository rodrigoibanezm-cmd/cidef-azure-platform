import { buildMonthlySales } from '../ventas/buildMonthlySales.js';
import { buildVentasUniverse } from './buildVentasUniverse.js';

function parsePositiveId(value, name) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${name} must be a positive integer`);
  return id;
}

function parseScope(options = {}) {
  const commercialUniverse = String(
    options.commercialUniverse ?? options.commercial_universe ?? 'COMPANY',
  ).trim().toUpperCase();

  if (!['COMPANY', 'OWN_STORES'].includes(commercialUniverse)) {
    throw new Error('commercial_universe must be COMPANY or OWN_STORES');
  }

  if (commercialUniverse === 'COMPANY') {
    return { commercialUniverse, storeId: null, brandId: null };
  }

  return {
    commercialUniverse,
    storeId: parsePositiveId(options.storeId ?? options.store_id, 'store_id'),
    brandId: parsePositiveId(options.brandId ?? options.brand_id, 'brand_id'),
  };
}

function scopedAnalyticalEvents(universe, scope) {
  if (scope.commercialUniverse === 'COMPANY') return universe.analytical_events;

  return universe.analytical_events.filter((event) =>
    Number(event.certified_store_id) === scope.storeId
      && Number(event.marca_id) === scope.brandId);
}

function resolvedIdentity(events, idField, nameField, expectedId) {
  const matches = events.filter((event) => Number(event[idField]) === expectedId);
  const names = [...new Set(matches.map((event) => event[nameField]).filter(Boolean))].sort();
  return {
    id: expectedId,
    name: names.length === 1 ? names[0] : null,
    status: matches.length > 0 && names.length <= 1 ? 'RESOLVED' : 'UNRESOLVED',
    evidence_events: matches.length,
  };
}

export function ventasContextFromUniverse(universe, options = {}) {
  const scope = parseScope({
    ...options,
    commercialUniverse: options.commercialUniverse
      ?? options.commercial_universe
      ?? universe?.commercial_universe,
  });

  if (universe?.commercial_universe !== scope.commercialUniverse) {
    throw new Error(`${scope.commercialUniverse} ventas_universe_v01 is required`);
  }
  if (!Array.isArray(universe.analytical_events)) {
    throw new Error('ventas_universe_v01 analytical_events are required');
  }

  const recognizedSales = scopedAnalyticalEvents(universe, scope);
  const base = {
    context: 'ventas_context_v01',
    version: universe.recognition_version,
    policy: universe.recognition_policy,
    cutoff_month: universe.period?.cutoff_month ?? null,
    cutoff_date: universe.period?.cutoff_date ?? null,
    coverage: universe.coverage?.recognition ?? null,
    recognizedSales,
    monthlySales: buildMonthlySales(recognizedSales),
    validation: universe.source_validation,
    warnings: universe.warnings ?? [],
  };

  if (scope.commercialUniverse === 'COMPANY') return base;

  return {
    ...base,
    commercial_universe: 'OWN_STORES',
    grain: 'STORE_BRAND_MONTH',
    metric: 'VIN_SALES',
    store_id: scope.storeId,
    brand_id: scope.brandId,
    commercial_scope: universe.commercial_scope,
    commercial_coverage: universe.coverage?.commercial ?? null,
    identity_coverage: {
      store: universe.coverage?.resolution?.store ?? null,
      brand: universe.coverage?.resolution?.product_model ?? null,
    },
    scope_coverage: {
      analytical_events: recognizedSales.length,
      source_analytical_events: universe.analytical_events.length,
    },
    scope_identity: {
      store: resolvedIdentity(
        universe.analytical_events,
        'certified_store_id',
        'certified_store_name',
        scope.storeId,
      ),
      brand: resolvedIdentity(
        universe.analytical_events,
        'marca_id',
        'marca_nombre',
        scope.brandId,
      ),
    },
    lineage: {
      universe: 'ventas_universe_v01',
      source: 'ventas_universe_v01.analytical_events',
      store_identity: 'certified_store_id',
      brand_identity: 'marca_id',
      sale_month: 'mes_venta',
      recognition: 'inherited from ventas_universe_v01',
    },
  };
}

export async function buildVentasMonthlyAnalyticalContext(options = {}) {
  const scope = parseScope(options);
  const universe = await buildVentasUniverse({
    commercial_universe: scope.commercialUniverse,
    cutoff_month: options.cutoffMonth ?? options.cutoff_month ?? null,
    cutoff_date: options.cutoffDate ?? options.cutoff_date ?? null,
  });
  return ventasContextFromUniverse(universe, scope);
}
