import { randomUUID } from 'node:crypto';
import { queryDb } from '../neon.js';
import { validDate, toIsoDate, endOfPeriod } from '../longitudinal/common.js';

export const DATA_SOURCE = 'PRICING';
export const CERTIFIER_VERSION = '0.1';
const SHAPE = 'COMMERCIAL_CONDITION_WINDOWS';
const DIMENSIONS = ['BRAND', 'MODEL', 'VERSION', 'MODEL_VERSION'];
const PRICES = ['precio_neto', 'precio_lista', 'precio_con_iva', 'bono_cidef', 'bono_forum', 'bono_mes',
  'precio_efectivo_pre_mes_sin_iva', 'precio_efectivo_pre_mes_con_iva',
  'precio_efectivo_final_sin_iva', 'precio_efectivo_final_con_iva'];
const NUMBERS = ['price_episode_id', 'price_version_id', 'version_id', 'brand_id', 'model_id',
  ...PRICES, ...PRICES.map(key => 'delta_' + key), 'source_rows', 'source_variant_count'];
const FILTER_COLUMNS = {
  brand: 'ma.nombre_canonico', brand_id: 'ma.marca_id',
  model: 'mo.nombre_canonico', model_id: 'mo.modelo_id',
  version: 'v.nombre_canonico', version_id: 'e.version_id',
  commercial_condition_id: 'e.commercial_condition_id', price_episode_id: 'e.price_episode_id',
};
const FILTERS = [...Object.keys(FILTER_COLUMNS), 'date_from', 'date_to'];
const FIELDS = [...NUMBERS, 'brand', 'model', 'version', 'commercial_condition_id',
  'vigencia_desde', 'vigencia_hasta', 'days_active', 'intersection_from', 'intersection_to',
  'tipo_cambio', 'quality_flags', 'source_status', 'source_files', 'canonicalized_at', 'lineage'];
const LINEAGE = {
  episode_authority: 'price_episode_canonico_v01', historical_authority: 'price_history',
  product_identity_authority: 'MASTER V0.1',
  product_identity_tables: ['versiones_master_v01', 'modelos_master_v01', 'marcas_master_v01'],
  semantic_contract: 'docs/canonical/PRICING_PISO_1_V0.1.md',
  date_filter_semantics: 'EPISODE_OVERLAP', metrics_scope: 'FULL_EPISODE',
  commercial_condition_semantics: 'PUBLISHED_COMMERCIAL_CONDITION',
  price_realized_available: false, sales_bridge_used: false,
};

export function describePricing() {
  return {
    source: DATA_SOURCE, version: CERTIFIER_VERSION,
    meaning: 'Certified published commercial-condition validity windows, across canonical products.',
    grain: 'product/version_id × commercial_condition_id × vigencia_desde × vigencia_hasta; price_episode_id identifies each canonical episode',
    date_semantics: {
      date_filter_semantics: 'EPISODE_OVERLAP', metrics_scope: 'FULL_EPISODE',
      bounds: 'Inclusive dates. Observe uses period/period_from/period_to (YYYY-MM) or filters.date_from/date_to (YYYY-MM-DD), not both.',
      duration: 'days_active is the full inclusive window duration; null for an open window. Intersection dates are auxiliary.',
      open_end: 'vigencia_hasta=null is an open canonical window; no end date is invented.',
      freshness: 'canonicalized_at is materialization time, not proof that all later source files were ingested.',
    },
    measures: [{ id: 'PRICE_EPISODES', label: 'Ventanas de condición comercial publicada', unit: 'EPISODE' }],
    dimensions: [...DIMENSIONS], filters: FILTERS, fields: FIELDS,
    operations: ['DESCRIBE', 'INSPECT', 'OBSERVE'], evidence_shapes: [SHAPE],
    boolean_logic: 'AND between filters; OR within array values. Names match exact canonical MASTER labels, case-insensitively; IDs use canonical identity.',
    semantic_constraints: [
      'Every window preserves BRAND, MODEL and VERSION identity; MODEL_VERSION displays both without querying each version separately.',
      'Distinct coexisting commercial conditions remain separate episodes; no winner is selected.',
      'A month selects intersecting windows; it never defines or truncates an episode.',
      'NULL means not published/not applicable as certified by the authority; it is never coerced to zero.',
      'PRE and FINAL are published source values only; FINAL is never reconstructed from bonuses.',
      'Existing deltas, source_status and quality_flags are preserved without corrections or recomputation.',
      'Coverage describes selected canonical episodes, not completeness of the catalog or all source files.',
      'No SALES attribution, VIN bridge, realized price, elasticity, causality or estimated effect is included.',
      'For SALES and VIN/day across all selected windows, pass this complete evidence_id directly to sales_observe_windows once, then p2.pricing_window_sales. The server resolves every model/version/episode; do not copy windows, split by model, repeat PRICING observations or use data_fetch for this question.',
      'For a question explicitly bounded to the requested period use metrics_scope=INTERSECTION (the SALES window default). FULL_EPISODE must be explicitly requested. P2 computes the same-version previous-window comparison deterministically within the selected scope; absence or coexistence is an explicit limitation.',
      'Use measure=PRICE_EPISODES and evidence_shape=COMMERCIAL_CONDITION_WINDOWS; scalar/quantitative shapes are unsupported.',
    ],
    lineage: { ...LINEAGE },
  };
}

function monthBounds(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) throw new Error('INVALID_PRICING_PERIOD');
  return { from: period + '-01', to: endOfPeriod(period + '-01', 'MONTH') };
}

function plan(input, inspection = false) {
  const filters = input.filters ?? {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('INVALID_PRICING_FILTER');
  for (const key of Object.keys(filters)) if (!FILTERS.includes(key)) throw new Error('UNSUPPORTED_PRICING_FILTER: ' + key);
  if (input.cutoff != null) throw new Error('PRICING_USE_PERIOD_OR_DATE_RANGE_NOT_CUTOFF');
  if (!inspection && input.measure !== 'PRICE_EPISODES') throw new Error('UNSUPPORTED_PRICING_MEASURE: ' + input.measure);
  if (!inspection && input.evidence_shape != null && input.evidence_shape !== SHAPE) throw new Error('UNSUPPORTED_PRICING_EVIDENCE_SHAPE: ' + input.evidence_shape);
  if (input.dimension != null && !DIMENSIONS.includes(input.dimension)) throw new Error('UNSUPPORTED_PRICING_DIMENSION: ' + input.dimension);
  const hasPeriod = [input.period, input.period_from, input.period_to].some(v => v != null);
  let from = filters.date_from ?? null, to = filters.date_to ?? null;
  if (hasPeriod) {
    if (from != null || to != null || (input.period != null && (input.period_from != null || input.period_to != null))) {
      throw new Error('AMBIGUOUS_PRICING_DATE_RANGE');
    }
    from = monthBounds(input.period_from ?? input.period).from;
    to = monthBounds(input.period_to ?? input.period).to;
  }
  if ((from != null && !validDate(from)) || (to != null && !validDate(to)) || (from && to && from > to)) {
    throw new Error('INVALID_PRICING_DATE_RANGE');
  }
  if (!inspection && (!from || !to)) throw new Error('PRICING_DATE_RANGE_REQUIRED');
  const params = [], clauses = [];
  const add = (clause, value) => { params.push(value); clauses.push(clause.replaceAll('?', '$' + params.length)); };
  if (from) add('(e.vigencia_hasta IS NULL OR e.vigencia_hasta >= ?::date)', from);
  if (to) add('e.vigencia_desde <= ?::date', to);
  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    if (filters[key] == null) continue;
    const values = Array.isArray(filters[key]) ? filters[key] : [filters[key]];
    if (!values.length || values.some(v => !['string', 'number'].includes(typeof v) || !String(v).trim())) {
      throw new Error('INVALID_PRICING_FILTER: ' + key);
    }
    if (key.endsWith('_id') && key !== 'commercial_condition_id') {
      if (values.some(v => !/^[1-9]\d*$/.test(String(v)) || !Number.isSafeInteger(Number(v)))) throw new Error('INVALID_PRICING_FILTER: ' + key);
      add(column + ' = ANY(?::bigint[])', values.map(String));
    } else if (key === 'commercial_condition_id') add(column + ' = ANY(?::text[])', values.map(String));
    else add('upper(trim(' + column + ')) = ANY(?::text[])', values.map(v => String(v).trim().toUpperCase()));
  }
  return { filters, from, to, dimension: input.dimension || 'MODEL_VERSION', params,
    sql: `SELECT e.*, ma.marca_id AS brand_id, ma.nombre_canonico AS brand,
      mo.modelo_id AS model_id, mo.nombre_canonico AS model, v.nombre_canonico AS version
      FROM price_episode_canonico_v01 e
      LEFT JOIN versiones_master_v01 v ON v.version_id=e.version_id
      LEFT JOIN modelos_master_v01 mo ON mo.modelo_id=v.modelo_id
      LEFT JOIN marcas_master_v01 ma ON ma.marca_id=mo.marca_id
      ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
      ORDER BY ma.nombre_canonico, mo.nombre_canonico, v.nombre_canonico,
        e.version_id, e.vigencia_desde, e.commercial_condition_id, e.price_episode_id` };
}

function integer(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('INVALID_PRICING_AUTHORITY_INTEGER');
  return n;
}

async function dataset(input, inspection = false) {
  const request = plan(input, inspection);
  const rows = await queryDb(request.sql, request.params);
  const seen = new Set();
  const windows = rows.map(row => {
    if (seen.has(String(row.price_episode_id))) throw new Error('DUPLICATE_PRICE_EPISODE: ' + row.price_episode_id);
    seen.add(String(row.price_episode_id));
    const from = toIsoDate(row.vigencia_desde), to = toIsoDate(row.vigencia_hasta);
    if (row.price_episode_id == null || !row.commercial_condition_id || !from
      || (row.vigencia_hasta != null && !to) || (to && to < from)) throw new Error('INVALID_PRICING_AUTHORITY_WINDOW');
    const window = {
      ...Object.fromEntries(NUMBERS.map(key => [key, integer(row[key])])),
      brand: row.brand ?? null, model: row.model ?? null, version: row.version ?? null,
      commercial_condition_id: row.commercial_condition_id,
      vigencia_desde: from, vigencia_hasta: to,
      days_active: to ? (Date.parse(to) - Date.parse(from)) / 86400000 + 1 : null,
      intersection_from: request.from && request.from > from ? request.from : from,
      intersection_to: request.to && (!to || request.to < to) ? request.to : to,
      tipo_cambio: row.tipo_cambio, quality_flags: row.quality_flags ?? [],
      source_status: row.source_status, source_files: row.source_files ?? [],
      canonicalized_at: row.canonicalized_at instanceof Date ? row.canonicalized_at.toISOString() : row.canonicalized_at ?? null,
    };
    window.lineage = { episode_authority: LINEAGE.episode_authority, price_version_id: window.price_version_id,
      source_rows: window.source_rows, source_variant_count: window.source_variant_count,
      source_files: window.source_files, canonicalized_at: window.canonicalized_at };
    return window;
  });
  const unresolved = windows.filter(w => [w.brand_id, w.model_id, w.version_id, w.brand, w.model, w.version].some(v => v == null)).length;
  const sourceStatuses = {};
  for (const w of windows) sourceStatuses[w.source_status] = (sourceStatuses[w.source_status] || 0) + 1;
  const warnings = [...new Set(windows.flatMap(w => w.quality_flags))];
  if (unresolved) warnings.push('PRICING_PRODUCT_IDENTITY_UNRESOLVED');
  if (windows.some(w => w.source_status !== 'OK')) warnings.push('PRICING_SOURCE_STATUS_NOT_OK');
  const coverage = { scope: 'SELECTED_CANONICAL_EPISODES', episodes: windows.length,
    versions: new Set(windows.map(w => w.version_id)).size,
    models: new Set(windows.map(w => w.model_id).filter(v => v != null)).size,
    identity: { resolved: windows.length - unresolved, unresolved }, source_status: sourceStatuses,
    episodes_with_quality_flags: windows.filter(w => w.quality_flags.length).length,
    complete: unresolved === 0 && windows.every(w => w.source_status === 'OK'), warnings };
  return { request, windows, coverage };
}

export async function inspectPricing(input = {}) {
  const { request, windows, coverage } = await dataset(input, true);
  return { source: DATA_SOURCE, operation: 'INSPECT', filters: request.filters,
    size: { episodes: windows.length, versions: coverage.versions, models: coverage.models },
    shape: { grain: describePricing().grain, dimensions: DIMENSIONS,
      date_from: request.from, date_to: request.to, date_filter_semantics: 'EPISODE_OVERLAP' },
    quality: coverage, lineage: { ...LINEAGE } };
}

export async function observePricingEvidence(input = {}) {
  const { request, windows, coverage } = await dataset(input);
  return {
    evidence_id: 'PRICING:' + randomUUID(), evidence_contract: 'P1_COMMERCIAL_CONDITION_WINDOWS',
    evidence_version: CERTIFIER_VERSION, authority: 'P1_CERTIFIED', status: coverage.complete ? 'COMPLETE' : 'PARTIAL',
    source: DATA_SOURCE, operation: 'OBSERVE', grain: describePricing().grain,
    measure: describePricing().measures[0], universe: { filters: request.filters },
    dimensions: { group_by: request.dimension, identity_contract: 'MASTER V0.1' },
    temporal: { from: request.from, to: request.to, date_filter_semantics: 'EPISODE_OVERLAP',
      metrics_scope: 'FULL_EPISODE', window_bounds: 'INCLUSIVE', open_end: 'NULL' },
    coverage, payload: { count: windows.length, windows, warnings: coverage.warnings }, lineage: { ...LINEAGE },
  };
}
