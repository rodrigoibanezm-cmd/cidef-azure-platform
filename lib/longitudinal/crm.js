import { buildCrmUniverse } from '../crm-universe/buildCrmUniverse.js';
import {
  buildTemporalSemantics, comparisonPosition, coverageRow, enumeratePeriods, identityWarnings,
  normalizeEnum, outputEnvelope, parseCutoff, parseDateRange, parseFilterObject, parseTimeGrain,
  semanticError, temporalWarnings, withChanges,
} from './common.js';

export const ENGINE_NAME = 'crm_longitudinal_context_v01';
const METRICS = new Set(['LEADS_CREATED', 'LEADS_ASSIGNED', 'SOLD', 'NOT_SOLD', 'MANAGED', 'UNMANAGED',
  'MANAGEMENT_COVERAGE', 'MANAGEMENT_RATE', 'CONVERSION_ON_MANAGED', 'IN_MANAGEMENT', 'OPPORTUNITY',
  'CLOSED', 'DESISTED', 'CONVERSION_RATE']);
const GRAINS = new Set(['TOTAL', 'BRAND', 'PRODUCT_INTEREST', 'ORIGIN', 'SUBORIGIN',
  'STATUS', 'STORE', 'SELLER', 'INTEREST_LEVEL', 'DESIST_REASON']);
const DIMENSIONS = new Set(['brand', 'product_interest', 'origin', 'suborigin', 'status',
  'store_id', 'store', 'store_raw', 'seller_id', 'seller', 'seller_raw', 'interest_level',
  'desist_reason']);
const DATE_AXES = new Set(['CREATED_AT', 'ASSIGNED_AT', 'MANAGED_AT', 'DESISTED_AT']);
const MODES = new Set(['EVENT', 'COHORT']);
const SELLER_POPULATIONS = new Set(['AUTO', 'CURRENT_ROSTER', 'HISTORICAL']);
const COMMERCIAL_UNIVERSES = new Set(['COMPANY', 'OWN_STORES', 'DEALERS']);
const BREAKDOWNS = new Set([...GRAINS].filter((value) => value !== 'TOTAL'));
const RATIO_METRICS = new Set(['CONVERSION_RATE', 'MANAGEMENT_COVERAGE', 'MANAGEMENT_RATE', 'CONVERSION_ON_MANAGED']);
const AXIS_FIELD = Object.freeze({ CREATED_AT: 'created_date', ASSIGNED_AT: 'assigned_date', MANAGED_AT: 'managed_date', DESISTED_AT: 'desist_date' });

function assertDomainCompatibility(commercialUniverse, grain, breakdown, filters) {
  const grains = [grain, breakdown].filter(Boolean);
  const hasStoreOrSellerGrain = grains.some((value) => ['STORE', 'SELLER'].includes(value));
  const hasStoreOrSellerFilter = Object.keys(filters).some((key) => ['store_id', 'store', 'store_raw', 'seller_id', 'seller', 'seller_raw'].includes(key));
  if ((hasStoreOrSellerGrain || hasStoreOrSellerFilter) && commercialUniverse !== 'OWN_STORES') {
    throw semanticError('DOMAIN_MISMATCH', 'CRM STORE/SELLER analysis requires commercial_universe=OWN_STORES');
  }
}

export function parseCrmLongitudinalInput(input = {}) {
  if (input.commercial_universe == null) {
    throw semanticError('MISSING_COMMERCIAL_UNIVERSE', 'CRM longitudinal analysis requires an explicit commercial_universe');
  }
  const commercialUniverse = normalizeEnum(input.commercial_universe, COMMERCIAL_UNIVERSES, 'INVALID_COMMERCIAL_UNIVERSE');
  if (commercialUniverse === 'DEALERS') {
    throw semanticError('UNSUPPORTED_COMMERCIAL_UNIVERSE', 'CRM longitudinal DEALERS is not evaluable without certified dealer identity');
  }
  if ((input.mode && String(input.mode).toUpperCase() === 'SNAPSHOT') || input.as_of != null) {
    throw semanticError('UNSUPPORTED_TEMPORAL_RECONSTRUCTION', 'CRM snapshot reconstruction is not part of the current crm_longitudinal_context_v01 contract; versioned historical states are preserved by crm_universe_v01 for a future explicit snapshot semantic');
  }
  const metric = normalizeEnum(input.metric, METRICS, 'INVALID_METRIC');
  const grain = normalizeEnum(input.grain, GRAINS, 'INVALID_GRAIN', 'TOTAL');
  const mode = normalizeEnum(input.mode, MODES, 'INVALID_MODE', ['LEADS_CREATED', 'LEADS_ASSIGNED', 'MANAGED', 'DESISTED'].includes(metric) ? 'EVENT' : 'COHORT');
  const axisInput = mode === 'COHORT' ? input.cohort_axis ?? input.date_axis : input.date_axis;
  const dateAxis = normalizeEnum(axisInput, DATE_AXES, 'INVALID_DATE_AXIS');
  const eventAxis = { LEADS_CREATED: 'CREATED_AT', LEADS_ASSIGNED: 'ASSIGNED_AT', MANAGED: 'MANAGED_AT', DESISTED: 'DESISTED_AT' }[metric];
  if (mode === 'EVENT' && (!eventAxis || dateAxis !== eventAxis)) {
    if (!eventAxis) throw semanticError('UNSUPPORTED_TEMPORAL_RECONSTRUCTION', 'status outcomes require mode=COHORT');
    throw semanticError('SEMANTICALLY_IMPOSSIBLE_COMBINATION', `${metric} event requires ${eventAxis}`);
  }
  const filters = parseFilterObject(input.filters, DIMENSIONS);
  const sellerPopulation = normalizeEnum(input.seller_population, SELLER_POPULATIONS, 'INVALID_SELLER_POPULATION', 'AUTO');
  if (sellerPopulation === 'CURRENT_ROSTER' && commercialUniverse !== 'OWN_STORES') {
    throw semanticError('DOMAIN_MISMATCH', 'CURRENT_ROSTER seller population requires OWN_STORES');
  }
  const breakdown = input.breakdown == null ? null : normalizeEnum(input.breakdown, BREAKDOWNS, 'INVALID_BREAKDOWN');
  assertDomainCompatibility(commercialUniverse, grain, breakdown, filters);
  return {
    metric, grain, mode, dateAxis, timeGrain: parseTimeGrain(input.time_grain), filters,
    breakdown, commercialUniverse, sellerPopulation, ...parseCutoff(input), ...parseDateRange(input),
  };
}

function norm(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').trim() || null;
}

const FILTER_FIELD = Object.freeze({
  brand: ['brand', true], product_interest: ['product_interest_norm', false], origin: ['origin_norm', false],
  suborigin: ['suborigin_norm', false], status: ['status_norm', false], store_id: ['sucursal_id', true],
  store: ['sucursal_nombre', true], store_raw: ['store_raw_norm', false], seller_id: ['persona_id', true],
  seller: ['persona_nombre', true], seller_raw: ['seller_raw_norm', false], interest_level: ['interest_level_norm', false],
  desist_reason: ['desist_reason_norm', false],
});

function matchesFilters(event, filters) {
  return Object.entries(filters).every(([key, values]) => {
    const [field, normalizeEvent] = FILTER_FIELD[key];
    const current = key.endsWith('_id') ? String(event[field] ?? '') : (normalizeEvent ? norm(event[field]) : event[field]);
    return values.some((value) => key.endsWith('_id') ? String(value) === current : norm(value) === current);
  });
}

function metricPair(metric, row) {
  const sold = ['SI', 'S', 'YES', 'TRUE', '1'].includes(row.sold_norm);
  const notSold = ['NO', 'N', 'FALSE', '0'].includes(row.sold_norm);
  const managed = row.managed_date != null;
  const status = row.status_norm;
  const numerator = {
    LEADS_CREATED: true, LEADS_ASSIGNED: true, SOLD: sold, NOT_SOLD: notSold, MANAGED: managed, UNMANAGED: !managed,
    MANAGEMENT_COVERAGE: managed, MANAGEMENT_RATE: managed, CONVERSION_ON_MANAGED: sold && managed,
    IN_MANAGEMENT: status === 'EN GESTION', OPPORTUNITY: status === 'OPORTUNIDAD', CLOSED: status === 'CERRADO',
    DESISTED: status === 'DESISTIDO' || row.desist_date != null, CONVERSION_RATE: sold,
  }[metric];
  const denominator = metric === 'CONVERSION_ON_MANAGED' ? managed : true;
  return [numerator, denominator];
}

function identity(event, dimension) {
  if (dimension === 'BRAND') {
    if (event.product_interest_norm == null) return ['NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE', event.product_interest_raw];
    if (Number(event.brand_match_count || 0) > 1) return ['AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS', event.product_interest_raw];
    if (event.brand == null) return ['UNRESOLVED', 'UNRESOLVED', 'UNRESOLVED', event.product_interest_raw];
    return [String(event.brand), String(event.brand), 'RESOLVED', event.product_interest_raw];
  }
  if (dimension === 'STORE') {
    if (event.store_raw_norm == null) return ['NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE', event.store_raw];
    if (Number(event.store_match_count || 0) > 1) return ['AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS', event.store_raw];
    if (event.sucursal_id == null) return ['UNRESOLVED', 'UNRESOLVED', 'UNRESOLVED', event.store_raw];
    return [String(event.sucursal_id), event.sucursal_nombre, 'RESOLVED', event.store_raw];
  }
  if (dimension === 'SELLER') {
    if (event.seller_raw_norm == null) return ['NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE', event.seller_raw];
    if (Number(event.seller_match_count || 0) > 1) return ['AMBIGUOUS', 'AMBIGUOUS', 'AMBIGUOUS', event.seller_raw];
    if (event.persona_id == null) return ['UNRESOLVED', 'UNRESOLVED', 'UNRESOLVED', event.seller_raw];
    if (!event.eligible_vendedor_cidef) return ['NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE', event.seller_raw];
    return [String(event.persona_id), event.persona_nombre, 'RESOLVED', event.seller_raw];
  }
  const field = {
    PRODUCT_INTEREST: ['product_interest_norm','product_interest_raw'], ORIGIN: ['origin_norm','origin_raw'],
    SUBORIGIN: ['suborigin_norm','suborigin_raw'], STATUS: ['status_norm','estado_raw'],
    INTEREST_LEVEL: ['interest_level_norm','interest_level'], DESIST_REASON: ['desist_reason_norm','desist_reason'],
  }[dimension];
  const key = event[field[0]];
  return key == null ? ['UNRESOLVED','UNRESOLVED','UNRESOLVED',event[field[1]]] : [key, String(event[field[1]]).trim(), 'RAW', event[field[1]]];
}

function maxIso(values) {
  const valid = values.filter(Boolean);
  return valid.length ? valid.sort().at(-1) : null;
}

function buildRows(parsed, universe) {
  const axisField = AXIS_FIELD[parsed.dateAxis];
  // Current operational reporting uses the enabled projection roster. Closed
  // historical periods retain the certified role/store interval semantics.
  const today = new Date().toISOString().slice(0, 10);
  const population = parsed.sellerPopulation === 'AUTO'
    ? (parsed.commercialUniverse === 'OWN_STORES' && parsed.dateTo >= today ? 'CURRENT_ROSTER' : 'HISTORICAL')
    : parsed.sellerPopulation;
  const filtered = universe.analytical_events.filter((row) =>
    matchesFilters(row, parsed.filters) && (population !== 'CURRENT_ROSTER' || row.current_roster_member === true));
  const observed = filtered.filter((row) => row[axisField] && row[axisField] >= parsed.dateFrom && row[axisField] <= parsed.dateTo);
  const lastObservedDate = maxIso(observed.map((row) => row[axisField]));
  const temporal = buildTemporalSemantics(parsed, lastObservedDate);
  const effectiveDateTo = temporal.effectiveDateTo;
  const comparisonDay = temporal.comparisonDay ?? null;
  const scoped = filtered.filter((row) => {
    const date = row[axisField];
    if (!date || !effectiveDateTo || date < parsed.dateFrom || date > effectiveDateTo) return false;
    return parsed.cutoffMode !== 'SAME_DAY' || comparisonDay == null || comparisonPosition(date, parsed.timeGrain) <= comparisonDay;
  });
  const periods = enumeratePeriods(parsed.dateFrom, parsed.dateTo, parsed.timeGrain);
  const periodOf = (date) => parsed.timeGrain === 'YEAR' ? date.slice(0, 4) : date.slice(0, 7);
  const aggregate = (events) => {
    let numerator = 0; let denominator = 0;
    for (const row of events) { const pair = metricPair(parsed.metric, row); if (pair[0]) numerator += 1; if (pair[1]) denominator += 1; }
    return { numerator, denominator, value: RATIO_METRICS.has(parsed.metric) ? (denominator ? numerator / denominator : null) : numerator };
  };
  const totalRows = periods.map((period) => ({ period, row_type: 'TOTAL', ...aggregate(scoped.filter((row) => periodOf(row[axisField]) === period)) }));
  const rows = [...totalRows];
  if (parsed.breakdown) {
    const buckets = new Map();
    for (const row of scoped) {
      const [key,label,status,raw] = identity(row, parsed.breakdown);
      if (!buckets.has(key)) buckets.set(key, { key, label, status, rawValues: new Set() });
      if (raw != null && String(raw).trim()) buckets.get(key).rawValues.add(String(raw).trim());
    }
    for (const bucket of [...buckets.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
      for (const period of periods) {
        const events = scoped.filter((row) => periodOf(row[axisField]) === period && identity(row, parsed.breakdown)[0] === bucket.key);
        rows.push({ period, row_type: 'BREAKDOWN', bucket_key: bucket.key, bucket_label: bucket.label, identity_status: bucket.status, raw_values: [...bucket.rawValues], ...aggregate(events) });
      }
    }
  }
  const invalidManagedDateRecords = filtered.filter((row) => row.managed_raw != null && String(row.managed_raw).trim() !== '' && row.managed_date == null).length;
  const dimensionCounts = (dimension) => {
    const counts = { resolved: 0, unresolved: 0, ambiguous: 0, notApplicable: 0, total: scoped.length };
    for (const row of scoped) {
      const status = identity(row, dimension)[2];
      if (status === 'RESOLVED') counts.resolved += 1;
      else if (status === 'UNRESOLVED') counts.unresolved += 1;
      else if (status === 'AMBIGUOUS') counts.ambiguous += 1;
      else if (status === 'NOT_APPLICABLE') counts.notApplicable += 1;
    }
    return counts;
  };
  return { rows, temporal, filtered, scoped, invalidManagedDateRecords, dimensionCounts, sellerPopulationApplied: population };
}

export function assembleCrmLongitudinalFromUniverse(parsed, universe) {
  const built = buildRows(parsed, universe);
  const ratio = RATIO_METRICS.has(parsed.metric);
  const point = (row) => ({ period: row.period, ...(ratio ? { numerator: Number(row.numerator), denominator: Number(row.denominator) } : {}), value: row.value == null ? null : Number(row.value) });
  const totalRows = built.rows.filter((row) => row.row_type === 'TOTAL');
  const series = withChanges(totalRows.map(point));
  let seriesByBreakdown = null;
  if (parsed.breakdown) {
    const buckets = new Map();
    for (const row of built.rows.filter((item) => item.row_type === 'BREAKDOWN')) {
      if (!buckets.has(row.bucket_key)) buckets.set(row.bucket_key, { key: row.bucket_key, label: row.bucket_label, identityStatus: row.identity_status || (row.bucket_key === 'UNRESOLVED' ? 'UNRESOLVED' : 'RAW'), rawValues: row.raw_values || [], series: [] });
      buckets.get(row.bucket_key).series.push(point(row));
    }
    seriesByBreakdown = [...buckets.values()].map((bucket) => ({ ...bucket, series: withChanges(bucket.series) }));
  }
  const dimensionCoverage = ['BRAND','STORE','SELLER'].map((dimension) => coverageRow(dimension, built.dimensionCounts(dimension)));
  const axisField = AXIS_FIELD[parsed.dateAxis];
  const eventDateCoverage = {
    sourceRecords: built.filtered.length,
    validAxisRecords: built.filtered.filter((row) => row[axisField] != null).length,
    missingOrInvalidAxisRecords: built.filtered.filter((row) => row[axisField] == null).length,
    invalidManagedDateRecords: built.invalidManagedDateRecords,
  };
  const cc = universe.coverage?.commercial_universe || {};
  const store = universe.coverage?.store_identity || {};
  const history = universe.coverage?.historical_states || {};
  const commercialCoverage = {
    totalCrmRecordsConsidered: Number(cc.company_events || 0), includedInDomain: Number(cc.included_events || 0),
    excludedOtherUniverse: Number(cc.resolved_other_universe || 0),
    unresolved: Number(cc.unresolved ?? store.UNRESOLVED ?? 0), ambiguous: Number(cc.ambiguous ?? store.AMBIGUOUS ?? 0), notApplicable: Number(cc.not_applicable ?? store.NOT_APPLICABLE ?? 0),
  };
  const warnings = [...temporalWarnings(built.temporal), ...identityWarnings(dimensionCoverage), 'CRM_VERSIONED_HISTORY_AVAILABLE_CURRENT_CONTRACT_USES_CURRENT_STATE'];
  if (eventDateCoverage.missingOrInvalidAxisRecords > 0) warnings.push('CRM_MISSING_OR_INVALID_EVENT_DATE_PRESENT');
  if (eventDateCoverage.invalidManagedDateRecords > 0) warnings.push('CRM_INVALID_MANAGED_DATE_PRESENT');
  const result = outputEnvelope({ motor: ENGINE_NAME, domain: 'CRM', parsed, series, seriesByBreakdown, temporalSemantics: built.temporal, coverage: { dimensionCoverage, eventDateCoverage }, warnings, metadata: {
    mode: parsed.mode, dateAxis: parsed.dateAxis, cohortAxis: parsed.mode === 'COHORT' ? parsed.dateAxis : null,
    identity: { BRAND: 'PRODUCT_MASTER_EXACT_FROM_PRODUCT_INTEREST', PRODUCT_INTEREST: 'RAW', STORE: 'MASTER_EXACT', SELLER: 'MASTER_EXACT_AND_VENDEDOR_CIDEF' },
    recordPolicy: 'current_state from crm_universe_v01: latest loaded row per non-empty CRM ID ordered by loaded_at timestamp; null IDs remain separate',
    historicalStateAvailability: { available: Number(history.historical_extra_versions || 0) > 0, sourceVersions: Number(history.source_versions || 0), currentStates: Number(history.current_states || 0), historicalExtraVersions: Number(history.historical_extra_versions || 0), idsWithHistory: Number(history.ids_with_history || 0), contractUse: 'preserved by crm_universe_v01 but not mixed into EVENT/COHORT metrics to avoid duplicate lead/cohort counting' },
    managementDefinitions: { managed: 'Gestionado el parses to a valid date', unmanaged: 'Gestionado el does not parse to a valid date; includes missing or empty values and present but unparseable values', invalidManagedDate: 'Present but unparseable Gestionado el values remain UNMANAGED, are counted in coverage.eventDateCoverage.invalidManagedDateRecords, and emit CRM_INVALID_MANAGED_DATE_PRESENT', managementCoverage: 'MANAGED / (MANAGED + UNMANAGED)', conversionOnManaged: 'Vendido affirmative AND MANAGED / MANAGED' },
    eventDefinitions: { leadsCreated: 'lead counted by created_date when metric=LEADS_CREATED and dateAxis=CREATED_AT', leadsAssigned: 'lead counted by assigned_date when metric=LEADS_ASSIGNED and dateAxis=ASSIGNED_AT' },
    sellerPolicy: `Seller population ${built.sellerPopulationApplied}; CURRENT_ROSTER requires weekly_projection_sellers.habilitado=true for the same persona_id and sucursal_id; HISTORICAL retains CRM events and applies VENDEDOR_CIDEF role/store interval eligibility in SELLER identity at the selected ${parsed.dateAxis} event date`, limitation: 'Explicit SNAPSHOT/as_of reconstruction is not part of the current contract; certified historical states are preserved upstream',
    sellerPopulation: { requested: parsed.sellerPopulation, applied: built.sellerPopulationApplied, source: built.sellerPopulationApplied === 'CURRENT_ROSTER' ? 'weekly_projection_sellers' : 'persona_roles + persona_sucursal' },
    analyticalUniverse: { name: universe.universe, version: universe.version },
  } });
  return { ...result, commercial_scope: { universe: parsed.commercialUniverse, authority: 'Sucursal Asignada exact MASTER identity via sucursales_master.tipo_canal', valid: true, scope_id: 'crm_commercial_scope_v01' }, commercial_coverage: commercialCoverage };
}

export function buildCrmLongitudinalQuery(parsed) {
  return { universe: 'crm_universe_v01', version: '0.1', commercial_universe: parsed.commercialUniverse, eligibility_date_axis: parsed.dateAxis };
}

export function assembleCrmLongitudinal(parsed, universeOrRows) {
  if (!universeOrRows?.analytical_events) throw new Error('CRM_LONGITUDINAL_REQUIRES_CRM_UNIVERSE_V01');
  return assembleCrmLongitudinalFromUniverse(parsed, universeOrRows);
}

export async function buildCrmLongitudinal(input = {}) {
  const parsed = parseCrmLongitudinalInput(input);
  const universe = await buildCrmUniverse({ ...input, commercial_universe: parsed.commercialUniverse, eligibility_date_axis: parsed.dateAxis });
  return assembleCrmLongitudinalFromUniverse(parsed, universe);
}
