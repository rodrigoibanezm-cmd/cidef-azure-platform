import { buildCrmUniverse, buildCrmUniverses } from '../crm-universe/buildCrmUniverse.js';
import { parseCrmLongitudinalInput, assembleCrmLongitudinalFromUniverse } from '../longitudinal/crm.js';
import { validDate, toIsoDate, endOfPeriod } from '../longitudinal/common.js';

export const DATA_SOURCE = 'CRM';
export const CERTIFIER_VERSION = '0.1';
const MEASURES = {
  LEADS_CREATED: { label: 'Leads creados', unit: 'LEAD', definition: 'One current CRM lead per ID, selected by CREATED_AT.' },
  LEADS_ASSIGNED: { label: 'Leads asignados', unit: 'LEAD', definition: 'One current CRM lead per ID, selected by ASSIGNED_AT.' },
  MANAGED: { label: 'Leads gestionados', unit: 'LEAD', definition: 'Gestionado el parses to a valid date. EVENT uses MANAGED_AT; COHORT evaluates current management state in the selected cohort.' },
  UNMANAGED: { label: 'Leads sin gestión válida', unit: 'LEAD', definition: 'Gestionado el has no valid parsed date, including missing, empty and present but unparseable values. Requires COHORT.' },
  MANAGEMENT_RATE: { label: 'Cobertura de gestión CRM', unit: 'RATIO',
    numerator: 'MANAGED leads in the selected cohort.', denominator: 'MANAGED + UNMANAGED in the same cohort.',
    definition: 'Existing longitudinal management coverage: MANAGED / (MANAGED + UNMANAGED). Zero denominator returns null; value is a fraction, not a percentage. Requires COHORT.' },
  SOLD: { label: 'venta declarada en CRM', unit: 'LEAD', definition: 'Current Vendido affirmative (SI, S, YES, TRUE, 1) within the selected cohort. Not an ERP-verified sale or a sale event date.' },
  CONVERSION_RATE: { label: 'Conversión CRM declarada de la cohorte', unit: 'RATIO',
    numerator: 'Leads with current Vendido affirmative in the selected cohort.',
    denominator: 'All leads in the selected cohort, including unknown Vendido outcomes.',
    definition: 'crm_longitudinal_context_v01: SOLD / all cohort leads. Zero denominator returns null; value is a fraction, not a percentage.' },
};
const DIMENSIONS = ['STORE', 'BRAND', 'PRODUCT_INTEREST', 'SELLER', 'ORIGIN'];
const SHAPES = ['QUANTITATIVE_OBSERVATION', 'PERIOD_OBSERVATION_SERIES', 'DIMENSIONAL_QUANTITATIVE_DATASET'];
const CONTROLS = new Set(['commercial_universe', 'date_axis', 'cohort_axis', 'mode', 'cutoff_mode', 'as_of', 'date_from', 'date_to']);
const IDENTITY_FILTERS = ['brand', 'product_interest', 'origin', 'suborigin', 'status', 'store_id', 'store', 'store_raw',
  'seller_id', 'seller', 'seller_raw', 'interest_level', 'desist_reason'];

function lineage(universe = null) {
  return { engine: 'crm_longitudinal_context_v01', universe: 'crm_universe_v01', version: '0.1',
    source: 'CRM_Cidef_raw', outcome_authority: 'CRM_DECLARED', erp_bridge_used: false,
    ...(universe?.lineage || {}) };
}

export function describeCrm() {
  return {
    source: DATA_SOURCE, version: CERTIFIER_VERSION,
    meaning: 'CRM leads and current declared outcomes, using the existing longitudinal CRM engine.',
    grain: 'CRM_LEAD_CURRENT_STATE',
    date_semantics: {
      required: ['commercial_universe', 'date_axis (or cohort_axis for COHORT)'],
      axes: ['CREATED_AT', 'ASSIGNED_AT', 'MANAGED_AT', 'DESISTED_AT'],
      modes: ['EVENT', 'COHORT'],
      event_metrics: { LEADS_CREATED: 'CREATED_AT', LEADS_ASSIGNED: 'ASSIGNED_AT', MANAGED: 'MANAGED_AT' },
      outcome_metrics: 'SOLD, CONVERSION_RATE, UNMANAGED and MANAGEMENT_RATE require COHORT; MANAGED also supports COHORT. They use current state, not the historical month-end state.',
      cutoff: 'Bounds event/cohort membership dates only. Does not reconstruct CRM outcomes as_of cutoff.',
      observation_freshness: 'Latest loaded_at from the existing universe; reported separately from the latest event/cohort date.',
      historical_close_certified: false,
      comparison: 'Past versus recent cohorts at their latest observed state. Different maturity and incomplete last period must remain explicit.',
    },
    measures: Object.entries(MEASURES).map(([id, measure]) => ({ id, ...measure })),
    dimensions: [...DIMENSIONS],
    filters: [...CONTROLS, ...IDENTITY_FILTERS], fields: [],
    operations: ['DESCRIBE', 'INSPECT', 'OBSERVE'], evidence_shapes: [...SHAPES],
    boolean_logic: 'AND between identity filters; OR within each filter array.',
    semantic_constraints: [
      'SOLD means venta declarada en CRM, never ERP-verified sale.',
      'CONVERSION_RATE uses the longitudinal denominator: all cohort leads, including unknown outcomes.',
      'MANAGED + UNMANAGED partitions the same selected cohort; MANAGEMENT_RATE uses that denominator and returns null when empty.',
      'crm_context_v01 uses SOLD / (SOLD + NOT_SOLD); that different definition is not used by this P1 source.',
      'Commercial universe must be explicit: COMPANY or OWN_STORES. DEALERS is unsupported.',
      'STORE/SELLER dimensions and filters require OWN_STORES; excluded/unresolved company records are reported in commercial coverage.',
      'BRAND is resolved from Producto de interes, not the brand of an ERP sale.',
      'Unknown and ambiguous identities remain explicit buckets and coverage, never silently redistributed.',
      'SNAPSHOT/as_of reconstruction and certified historical month-end outcomes are unsupported.',
      'Observation periods use period or period_from/period_to; inspection uses filters.date_from/date_to.',
      'date_axis/cohort_axis, commercial_universe, mode and cutoff_mode are supplied in filters.',
      'DIMENSIONAL_QUANTITATIVE_DATASET supports one dimension and can return monthly series per member.',
      'CRM data_fetch is unsupported; use aggregate observations.',
    ],
    lineage: lineage(),
  };
}

function bounds(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) throw new Error('INVALID_CRM_PERIOD: ' + period);
  return { from: period + '-01', to: endOfPeriod(period + '-01', 'MONTH') };
}

function plan(input, inspection = false) {
  const shape = input.evidence_shape || 'QUANTITATIVE_OBSERVATION';
  if (!inspection && !SHAPES.includes(shape)) throw new Error('UNSUPPORTED_CRM_EVIDENCE_SHAPE: ' + shape);
  const measure = inspection ? 'LEADS_CREATED' : String(input.measure || '').trim().toUpperCase();
  if (!MEASURES[measure]) throw new Error('UNSUPPORTED_CRM_MEASURE: ' + measure);
  const f = input.filters ?? {};
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('INVALID_FILTER');
  const controls = {}, filters = {};
  for (const [key, value] of Object.entries(f)) (CONTROLS.has(key) ? controls : filters)[key] = value;
  let from, to, periodFrom, periodTo;
  if (inspection) {
    from = controls.date_from; to = controls.date_to;
  } else {
    if (controls.date_from != null || controls.date_to != null) throw new Error('CRM_OBSERVE_USE_PERIOD_PARAMETERS');
    periodFrom = input.period_from || input.period; periodTo = input.period_to || input.period;
    if (!periodFrom || !periodTo) throw new Error('CRM_PERIOD_REQUIRED');
    from = bounds(periodFrom).from; to = bounds(periodTo).to;
    if (shape === 'QUANTITATIVE_OBSERVATION' && periodFrom !== periodTo) throw new Error('CRM_SCALAR_REQUIRES_SINGLE_PERIOD');
  }
  if (input.cutoff != null && (!validDate(input.cutoff) || input.cutoff < from || input.cutoff > to)) {
    throw new Error('INVALID_CRM_CUTOFF');
  }
  const dimension = input.dimension == null ? null : String(input.dimension).trim().toUpperCase();
  if (!inspection && shape === 'DIMENSIONAL_QUANTITATIVE_DATASET' && !DIMENSIONS.includes(dimension)) {
    throw new Error('UNSUPPORTED_CRM_DIMENSION: ' + dimension);
  }
  if (!inspection && dimension && shape !== 'DIMENSIONAL_QUANTITATIVE_DATASET') {
    throw new Error('CRM_DIMENSION_REQUIRES_DIMENSIONAL_SHAPE');
  }
  const parsed = parseCrmLongitudinalInput({
    ...controls, metric: measure, mode: inspection ? controls.mode || 'COHORT' : controls.mode,
    grain: 'TOTAL', breakdown: dimension, filters,
    date_from: from, date_to: to, cutoff_date: input.cutoff, time_grain: 'MONTH',
  });
  return { parsed, shape, dimension, periodFrom, periodTo };
}

function observationFreshness(universe) {
  const timestamps = (universe.historical_states || universe.analytical_events)
    .map(row => row.loaded_at).filter(Boolean).map(value => new Date(value))
    .filter(date => Number.isFinite(date.getTime())).map(date => date.toISOString()).sort();
  return timestamps.at(-1) ?? null;
}

function assembleObservation(input, request, universe, lastObservationAt = observationFreshness(universe)) {
  const parsed = request.parsed;
  if (universe.validation?.valid === false) throw new Error('CRM_UNIVERSE_VALIDATION_FAILED');
  const lastObservationDate = toIsoDate(lastObservationAt);
  // Keep the longitudinal calculation; freshness only caps the membership window.
  const cutoffDate = [parsed.cutoffDate, parsed.dateTo, lastObservationDate].filter(Boolean).sort()[0];
  const result = assembleCrmLongitudinalFromUniverse({ ...parsed, cutoffDate }, universe);
  const complete = Boolean(lastObservationDate && result.temporalSemantics.lastPeriodComplete
    && lastObservationDate >= endOfPeriod(parsed.dateTo, 'MONTH'));
  const warnings = [...new Set([
    ...result.warnings, 'CRM_SOLD_IS_DECLARED_NOT_ERP_VERIFIED',
    'CRM_PAST_COHORT_OUTCOMES_ARE_CURRENT_STATE_NOT_HISTORICAL_CLOSE',
    ...(!complete ? ['LAST_PERIOD_INCOMPLETE'] : []),
    ...(lastObservationDate && parsed.dateTo > lastObservationDate ? ['REQUESTED_DATE_TO_AFTER_LAST_OBSERVATION'] : []),
    ...(!lastObservationDate ? ['CRM_OBSERVATION_FRESHNESS_UNAVAILABLE'] : []),
    ...(request.periodFrom !== request.periodTo ? ['CRM_COHORT_COMPARISON_HAS_DIFFERENT_MATURITY'] : []),
  ])];
  const temporal = {
    ...result.temporalSemantics, lastPeriodComplete: complete,
    period: input.period ?? null, period_from: request.periodFrom ?? parsed.dateFrom.slice(0, 7),
    period_to: request.periodTo ?? parsed.dateTo.slice(0, 7),
    from: parsed.dateFrom, to: result.temporalSemantics.effectiveDateTo,
    date_axis: parsed.dateAxis, mode: parsed.mode,
    last_observation_at: lastObservationAt, last_observation_date: lastObservationDate,
    last_event_date: result.temporalSemantics.lastObservedDate,
    state_basis: 'CURRENT_STATE', historical_close_certified: false,
    cutoff_semantics: 'EVENT_OR_COHORT_MEMBERSHIP_BOUND_NOT_OUTCOME_AS_OF',
    period_status: complete ? 'OBSERVED_PERIOD_COVERED' : 'INCOMPLETE',
  };
  return { ...request, result, universe, temporal, warnings, complete };
}

async function observe(input, inspection = false) {
  const request = plan(input, inspection), parsed = request.parsed;
  const universe = await buildCrmUniverse({
    commercial_universe: parsed.commercialUniverse, eligibility_date_axis: parsed.dateAxis,
  });
  return assembleObservation(input, request, universe);
}

export async function inspectCrm(input = {}) {
  const out = await observe(input, true);
  return {
    source: DATA_SOURCE, operation: 'INSPECT', filters: input.filters || {},
    size: { leads: out.result.series.reduce((sum, point) => sum + point.value, 0) },
    shape: { grain: 'CRM_LEAD_CURRENT_STATE', dimensions: [...DIMENSIONS],
      temporal: out.temporal, commercial_universe: out.parsed.commercialUniverse },
    quality: { ...out.result.coverage, commercial_coverage: out.result.commercial_coverage,
      complete: out.complete, warnings: out.warnings },
    lineage: lineage(out.universe),
  };
}

function certifyObservation(out) {
  const { parsed, shape, dimension, result } = out;
  const dimensional = shape === 'DIMENSIONAL_QUANTITATIVE_DATASET';
  const payload = {
    series: result.series,
    ...(shape === 'QUANTITATIVE_OBSERVATION' ? result.series[0] : {}),
    ...(dimensional ? {
      dimension: { id: dimension, identity_contract: result.metadata.identity[dimension] || 'RAW',
        unresolved_member_policy: 'EXPLICIT_UNRESOLVED_AMBIGUOUS_NOT_APPLICABLE_BUCKETS' },
      members: (result.seriesByBreakdown || []).map(bucket => ({
        member_id: bucket.key, member_label: bucket.label, identity_status: bucket.identityStatus,
        raw_values: bucket.rawValues, series: bucket.series,
        ...(bucket.series.length === 1 ? bucket.series[0] : {}),
      })),
    } : {}),
    warnings: out.warnings,
  };
  return {
    evidence_id: 'CRM:' + parsed.metric + ':' + (dimension || 'TOTAL') + ':' + parsed.commercialUniverse + ':' + parsed.dateAxis + ':' + out.temporal.period_from + ':' + out.temporal.period_to + ':' + Date.now(),
    evidence_contract: dimensional ? (result.series.length > 1 ? 'p1.crm_dimensional_cohort_series' : 'P1_DIMENSIONAL_QUANTITATIVE_DATASET')
      : shape === 'PERIOD_OBSERVATION_SERIES' ? 'P1_PERIOD_OBSERVATION_SERIES' : 'P1_FACTUAL_OBSERVATION',
    evidence_version: CERTIFIER_VERSION, authority: 'P1_CERTIFIED',
    status: out.complete ? 'COMPLETE' : 'PARTIAL', source: DATA_SOURCE, operation: 'OBSERVE',
    grain: 'CRM_LEAD_CURRENT_STATE', measure: { id: parsed.metric, ...MEASURES[parsed.metric] },
    universe: { commercial_universe: parsed.commercialUniverse, filters: parsed.filters,
      date_axis: parsed.dateAxis, mode: parsed.mode },
    dimensions: dimensional ? { group_by: dimension } : {},
    temporal: out.temporal,
    coverage: { ...result.coverage, commercial_coverage: result.commercial_coverage,
      complete: out.complete, universe_validation: out.universe.validation, warnings: out.warnings },
    payload, lineage: { ...lineage(out.universe), definitions: result.metadata },
  };
}

export async function observeCrmEvidence(input = {}) {
  return certifyObservation(await observe(input));
}

export async function observeCrmMany(input = {}) {
  const started = Date.now();
  if (!Array.isArray(input.operations) || !input.operations.length) throw new Error('CRM_OPERATIONS_REQUIRED');
  if (input.filters?.commercial_universe != null) throw new Error('CRM_BATCH_UNIVERSE_BELONGS_TO_OPERATION');
  const requests = input.operations.map(operation => {
    const evidence_shape = operation.evidence_shape || (operation.dimension
      ? 'DIMENSIONAL_QUANTITATIVE_DATASET' : 'PERIOD_OBSERVATION_SERIES');
    const observation = {
      measure: operation.measure, dimension: operation.dimension, evidence_shape,
      period: input.period, period_from: input.period_from, period_to: input.period_to, cutoff: input.cutoff,
      filters: { ...input.filters, commercial_universe: operation.commercial_universe },
    };
    return { observation, request: plan(observation) };
  });
  // Validate every operation before any query. Eligibility of sellers depends on the date axis.
  const compatibility = ({ parsed }) => JSON.stringify([
    parsed.dateAxis, parsed.mode, parsed.dateFrom, parsed.dateTo, parsed.timeGrain,
    parsed.cutoffMode, parsed.cutoffDate, parsed.filters,
  ]);
  const first = requests[0].request;
  if (requests.some(({ request }) => compatibility(request) !== compatibility(first))) {
    throw new Error('INCOMPATIBLE_CRM_BATCH_CONTEXT');
  }
  const seen = new Set();
  for (const { request } of requests) {
    const key = JSON.stringify([request.parsed.commercialUniverse, request.parsed.metric, request.shape, request.dimension]);
    if (seen.has(key)) throw new Error('DUPLICATE_CRM_OPERATION');
    seen.add(key);
  }
  const scopes = [...new Set(requests.map(({ request }) => request.parsed.commercialUniverse))];
  const universes = await buildCrmUniverses({ eligibility_date_axis: first.parsed.dateAxis }, scopes);
  const freshness = new Map(scopes.map(scope => [scope, observationFreshness(universes.get(scope))]));
  const results = requests.map(({ observation, request }) => {
    const operationStarted = Date.now();
    const scope = request.parsed.commercialUniverse;
    const evidence = certifyObservation(assembleObservation(observation, request, universes.get(scope), freshness.get(scope)));
    return { operation: observation, evidence, duration_ms: Date.now() - operationStarted };
  });
  return {
    source: DATA_SOURCE, results,
    execution: {
      duration_ms: Date.now() - started, universe_loads: 1, universes_built: scopes.length,
      operations: results.length,
      contexts: scopes.map(commercial_universe => ({ commercial_universe, date_axis: first.parsed.dateAxis,
        mode: first.parsed.mode, date_from: first.parsed.dateFrom, date_to: first.parsed.dateTo,
        cutoff_mode: first.parsed.cutoffMode, cutoff: first.parsed.cutoffDate, filters: first.parsed.filters })),
      evidence_ids: results.map(result => result.evidence.evidence_id),
    },
  };
}
