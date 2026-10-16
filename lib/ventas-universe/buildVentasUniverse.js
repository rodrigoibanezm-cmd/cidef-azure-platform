import { customGptDb } from '../custom-gpt/db.js';
import { buildProductModelResolutionMap } from '../product-model-resolution/buildResolutionMap.js';
import { loadSkuEvidence } from '../product-model-resolution/loadSkuEvidence.js';
import { resolveSalesModels } from '../product-model-resolution/resolveSalesModels.js';
import { normalizeProductKey } from '../product-model-resolution/normalize.js';
import {
  buildVentasCommercialContexts,
  parseCommercialUniverse,
} from '../ventas-commercial/buildVentasCommercialContext.js';
import { loadOrganizationalIdentityMaps } from '../ventas-org/loadOrganizationalIdentityMaps.js';
import { enrichRecognizedSales } from '../ventas-org/enrichRecognizedSales.js';
import { loadProductIdentityMap } from '../ventas-product/loadProductIdentityMap.js';
import { resolveSalesProducts } from '../ventas-product/resolveSaleProduct.js';

export const UNIVERSE_NAME = 'ventas_universe_v01';
export const UNIVERSE_VERSION = '0.1';

export async function loadVentasUniverseCatalogs(sql = customGptDb()) {
  const [models, versions] = await Promise.all([
    sql.query(`
      SELECT m.modelo_id,m.marca_id,m.nombre_canonico modelo,ma.nombre_canonico marca
      FROM modelos_master_v01 m
      JOIN marcas_master_v01 ma USING(marca_id)
    `),
    sql.query(`
      SELECT v.version_id,v.modelo_id,v.nombre_canonico version
      FROM versiones_master_v01 v
    `),
  ]);
  const brands = new Map();
  for (const row of models) {
    const key = normalizeProductKey(row.marca);
    if (key && !brands.has(key)) brands.set(key, { marca_id: row.marca_id, marca: row.marca });
  }
  return {
    models: new Map(models.map((row) => [String(row.modelo_id), row])),
    versions: new Map(versions.map((row) => [String(row.version_id), row])),
    brands,
  };
}

export async function loadVentasUniverseResources(sql = customGptDb()) {
  const [organization, productAliases, skuEvidence, catalogs] = await Promise.all([
    loadOrganizationalIdentityMaps(sql),
    loadProductIdentityMap(sql),
    loadSkuEvidence(sql),
    loadVentasUniverseCatalogs(sql),
  ]);
  return { organization, productAliases, skuEvidence, catalogs };
}

function resolutionCounts(events, field) {
  const counts = { resolved: 0, unresolved: 0, ambiguous: 0, not_applicable: 0 };
  for (const event of events) {
    const value = String(event[field] ?? 'UNRESOLVED').toUpperCase();
    const key = ['RESUELTA', 'RESOLVED'].includes(value) ? 'resolved'
      : ['NO_RESUELTA', 'UNRESOLVED'].includes(value) ? 'unresolved'
        : ['AMBIGUA', 'AMBIGUOUS'].includes(value) ? 'ambiguous'
          : ['NO_APLICA', 'NOT_APPLICABLE'].includes(value) ? 'not_applicable'
            : null;
    if (Object.hasOwn(counts, key)) counts[key] += 1;
  }
  counts.total = events.length;
  return counts;
}

export function enrichVentasUniverseEvents(commercialContext, resources) {
  const recognizedSales = commercialContext.sales;
  const resolutionMap = buildProductModelResolutionMap(
    resources.skuEvidence,
    resources.productAliases,
  );
  const exactProducts = resolveSalesModels(recognizedSales, resolutionMap);
  const aliasProducts = resolveSalesProducts(recognizedSales, resources.productAliases);
  const organization = enrichRecognizedSales(recognizedSales, resources.organization);

  const analyticalEvents = exactProducts.map((sale, index) => {
    const alias = aliasProducts[index];
    const org = organization[index];
    const model = sale.modelo_id == null
      ? null
      : resources.catalogs.models.get(String(sale.modelo_id));
    const resolution = resolutionMap.get(normalizeProductKey(sale.producto_sku)) ?? null;
    const candidateModels = (resolution?.candidate_model_ids ?? [])
      .map((id) => resources.catalogs.models.get(String(id)))
      .filter(Boolean);
    const candidateBrandIds = [...new Set(candidateModels.map((candidate) => String(candidate.marca_id)))];
    const candidateBrand = model ?? (candidateBrandIds.length === 1 ? candidateModels[0] : null);
    const rawBrand = resources.catalogs.brands?.get(normalizeProductKey(sale.marca ?? sale.marca_raw)) ?? null;
    const hierarchicalBrand = candidateBrand ?? rawBrand;
    const brandIdentityStatus = hierarchicalBrand
      ? 'RESOLVED'
      : sale.product_identity_status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNRESOLVED';
    const versionId = sale.version_id ?? null;
    const version = versionId == null
      ? null
      : resources.catalogs.versions.get(String(versionId));
    const certifiedCommercialChannel = sale.canonical_commercial_universe === 'OWN_STORES'
      ? 'CIDEF'
      : sale.canonical_commercial_universe === 'DEALERS' ? 'DEALER' : null;

    return {
      ...sale,
      ...org,
      certified_commercial_channel: certifiedCommercialChannel,
      certified_store_id: sale.sucursal_venta_id ?? null,
      certified_store_name: sale.sucursal_venta_nombre ?? null,
      certified_dealer_id: sale.dealer_id ?? null,
      certified_dealer_name: sale.dealer_nombre ?? null,
      certified_dealer_group_id: sale.dealer_group_id ?? null,
      certified_dealer_group_name: sale.dealer_group_nombre ?? null,
      version_id: versionId,
      version_nombre: version?.version ?? null,
      marca_id: hierarchicalBrand?.marca_id ?? null,
      marca_nombre: hierarchicalBrand?.marca ?? null,
      brand_identity_status: brandIdentityStatus,
      modelo_nombre: model?.modelo ?? null,
      alias_product_identity_status: alias?.product_identity_status ?? 'UNRESOLVED',
      alias_modelo_id: alias?.modelo_id ?? null,
      alias_version_id: alias?.version_id ?? null,
    };
  });

  return { analyticalEvents, resolutionMap };
}

function buildCoverage(commercialContext, events) {
  return {
    recognition: commercialContext.source_context?.coverage ?? null,
    commercial: commercialContext.coverage,
    resolution: {
      commercial_channel: {
        resolved: events.filter((row) => row.canonical_commercial_universe !== 'UNRESOLVED').length,
        unresolved: events.filter((row) => row.canonical_commercial_universe === 'UNRESOLVED').length,
        total: events.length,
      },
      store: resolutionCounts(events, 'store_identity_status'),
      seller: resolutionCounts(events, 'seller_identity_status'),
      vendedor_cidef: {
        eligible: events.filter((row) => row.eligible_vendedor_cidef === true).length,
        not_eligible: events.filter((row) => row.eligible_vendedor_cidef !== true).length,
        total: events.length,
      },
      product_model: resolutionCounts(events, 'product_identity_status'),
      product_version: {
        resolved: events.filter((row) => row.version_id != null).length,
        unresolved: events.filter((row) => row.version_id == null).length,
        total: events.length,
      },
    },
  };
}

export function assembleVentasUniverse(commercialContext, resources) {
  if (!commercialContext?.commercial_scope?.universe) {
    throw new Error('ventas commercial context is required');
  }
  const { analyticalEvents, resolutionMap } = enrichVentasUniverseEvents(
    commercialContext,
    resources,
  );
  const sourceValid = commercialContext.source_context?.validation?.ok === true;
  const commercialValid = commercialContext.validation?.valid === true;
  const eventCountReconciles = analyticalEvents.length === commercialContext.sales.length;
  const commercialCountsReconcile = commercialContext.coverage.included_sales
    + commercialContext.coverage.excluded_other_universe
    === commercialContext.coverage.recognized_sales;
  const resolutionCoverage = buildCoverage(commercialContext, analyticalEvents);
  const resolutionCountsReconcile = resolutionCoverage.resolution.product_model.resolved
    + resolutionCoverage.resolution.product_model.unresolved
    + resolutionCoverage.resolution.product_model.ambiguous
    + resolutionCoverage.resolution.product_model.not_applicable
    === analyticalEvents.length;
  const validation = {
    source_recognition_valid: sourceValid,
    commercial_scope_valid: commercialValid,
    commercial_counts_reconcile: commercialCountsReconcile,
    analytical_event_count_reconciles: eventCountReconciles,
    resolution_counts_reconcile: resolutionCountsReconcile,
    valid: sourceValid && commercialValid && commercialCountsReconcile
      && eventCountReconciles && resolutionCountsReconcile,
    violations: commercialContext.validation?.violations ?? [],
  };

  return {
    universe: UNIVERSE_NAME,
    version: UNIVERSE_VERSION,
    commercial_universe: commercialContext.commercial_scope.universe,
    commercial_scope: commercialContext.commercial_scope,
    period: {
      requested_cutoff_date: commercialContext.source_context?.cutoff_date ?? null,
      requested_cutoff_month: commercialContext.source_context?.cutoff_month ?? null,
      cutoff_date: commercialContext.source_context?.effective_cutoff_date
        ?? commercialContext.source_context?.cutoff_date ?? null,
      cutoff_month: commercialContext.source_context?.effective_cutoff_month
        ?? commercialContext.source_context?.cutoff_month ?? null,
    },
    analytical_events: analyticalEvents,
    recognition_version: commercialContext.source_context?.version ?? null,
    source_validation: commercialContext.source_context?.validation ?? null,
    recognition_policy: commercialContext.source_context?.policy ?? null,
    coverage: resolutionCoverage,
    validation,
    warnings: [
      ...(commercialContext.source_context?.warnings ?? []),
      ...(commercialValid ? [] : ['COMMERCIAL_SCOPE_VALIDATION_FAILED']),
    ],
    resolution_resources: {
      product_aliases: resources.productAliases,
      product_model_resolution_map: resolutionMap,
      model_catalog: [...resources.catalogs.models.values()],
    },
    lineage: {
      recognition: 'ventas_context_v01',
      commercial_scope: 'ventas_commercial_context_v01',
      commercial_authority: 'certified_recognized_sale',
      product_identity: 'certified ventas_raw SKU aliases; unresolved version never excludes the sale',
      organizational_identity: 'existing MASTER organizational resolvers',
      seller_membership: 'existing date-effective VENDEDOR_CIDEF resolver',
    },
  };
}

export async function buildVentasUniverses(input = {}, universes = []) {
  const commercialUniverses = [...new Set(universes.map((universe) =>
    parseCommercialUniverse(universe)))];
  if (!commercialUniverses.length) throw new Error('at least one commercial universe is required');
  const cutoffDate = input.cutoff_date ?? input.date_to ?? input.cutoffDate ?? null;
  const cutoffMonth = input.cutoff_month ?? input.cutoffMonth ?? null;
  const sql = customGptDb();
  const [commercialContexts, resources] = await Promise.all([
    buildVentasCommercialContexts({
      cutoff_date: cutoffDate,
      cutoff_month: cutoffMonth,
    }, commercialUniverses, { includeSourceContextDetails: true }),
    loadVentasUniverseResources(sql),
  ]);
  return new Map(commercialUniverses.map((universe) => [
    universe,
    assembleVentasUniverse(commercialContexts.get(universe), resources),
  ]));
}

export async function buildVentasUniverse(input = {}) {
  const commercialUniverse = parseCommercialUniverse(
    input.commercial_universe ?? input.universe,
  );
  const universes = await buildVentasUniverses(input, [commercialUniverse]);
  return universes.get(commercialUniverse);
}
