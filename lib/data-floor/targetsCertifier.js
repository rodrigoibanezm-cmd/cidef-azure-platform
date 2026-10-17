import { queryDb } from '../neon.js';

export const DATA_SOURCE = 'TARGETS';
export const CERTIFIER_VERSION = '0.1';

function parseMonth(value) {
  const month = String(value ?? '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('INVALID_TARGET_MONTH');
  return month;
}

function normalizeFilters(input = {}) {
  const filters = { ...(input.filters || {}) };
  const allowed = new Set(['month', 'store_id']);
  const bad = Object.keys(filters).find((key) => !allowed.has(key));
  if (bad) throw new Error('UNSUPPORTED_TARGET_FILTER: ' + bad);
  return filters;
}

function lineage() {
  return {
    authority_table: 'ventas_metas_mensuales',
    identity: 'sucursales_master.sucursal_id',
    source_semantics: 'explicit monthly CIDEF sales target; not a statistical expectation',
    certifier_version: CERTIFIER_VERSION,
  };
}

async function loadRows(filters = {}) {
  const params = [];
  const clauses = [];
  if (filters.month != null) {
    params.push(parseMonth(filters.month) + '-01');
    clauses.push('m.mes = $' + params.length + '::date');
  }
  if (filters.store_id != null) {
    params.push(String(filters.store_id));
    clauses.push('m.sucursal_id = $' + params.length);
  }
  return queryDb(
    `SELECT m.mes::text AS mes, m.sucursal_id, s.nombre_canonico AS store_label, m.meta_vin, m.source
     FROM ventas_metas_mensuales m
     LEFT JOIN sucursales_master s ON s.sucursal_id::text = m.sucursal_id
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY m.mes, m.sucursal_id::bigint`,
    params,
  );
}

export function describeTargets() {
  return {
    source: DATA_SOURCE,
    version: CERTIFIER_VERSION,
    meaning: 'Certified explicit monthly CIDEF VIN sales targets by own store.',
    grain: 'one monthly target per CIDEF own store',
    date_semantics: { month: 'calendar month identity' },
    filters: ['month', 'store_id'],
    fields: ['month', 'store_id', 'store_label', 'target_vin', 'source'],
    measures: [{ id: 'VIN_TARGET', unit: 'VIN', aggregation: 'EXPLICIT_TARGET', meaning: 'Official explicit CIDEF monthly VIN target.' }],
    operations: ['DESCRIBE', 'INSPECT', 'FETCH', 'OBSERVE'],
    evidence_shapes: ['REFERENCE_OBSERVATION'],
    boolean_logic: 'AND between filters',
    lineage: lineage(),
  };
}

export async function inspectTargets(input = {}) {
  const filters = normalizeFilters(input);
  const rows = await loadRows(filters);
  const allRows = await loadRows();
  return {
    source: DATA_SOURCE,
    operation: 'INSPECT',
    filters,
    size: { source_n: allRows.length, filtered_n: rows.length },
    shape: {
      months: new Set(rows.map((row) => String(row.mes).slice(0, 7))).size,
      stores: new Set(rows.map((row) => row.sucursal_id)).size,
    },
    quality: {
      coverage: {
        source_present: rows.filter((row) => row.source).length,
        store_identity_present: rows.filter((row) => row.store_label).length,
      },
      validation: {
        unique_month_store: new Set(rows.map((row) => String(row.mes).slice(0, 7) + '|' + row.sucursal_id)).size === rows.length,
      },
      warnings: [],
    },
    lineage: lineage(),
  };
}

export async function fetchTargets(input = {}) {
  const filters = normalizeFilters(input);
  const rows = await loadRows(filters);
  return {
    source: DATA_SOURCE,
    operation: 'FETCH',
    dataset: 'TARGETS_WORK',
    version: CERTIFIER_VERSION,
    filters,
    grain: 'MONTH_X_STORE',
    size: { source_n: (await loadRows()).length, filtered_n: rows.length },
    rows: rows.map((row) => ({
      month: String(row.mes).slice(0, 7),
      store_id: String(row.sucursal_id),
      store_label: row.store_label,
      target_vin: Number(row.meta_vin),
      source: row.source,
    })),
    quality: { coverage: { complete: true }, validation: { unique_month_store: true }, warnings: [] },
    lineage: lineage(),
  };
}

export async function observeTargetsEvidence(input = {}) {
  if (input.measure !== 'VIN_TARGET') throw new Error('UNSUPPORTED_TARGET_MEASURE: ' + input.measure);
  if (input.evidence_shape !== 'REFERENCE_OBSERVATION') throw new Error('UNSUPPORTED_TARGET_EVIDENCE_SHAPE: ' + input.evidence_shape);
  const period = parseMonth(input.period);
  const filters = normalizeFilters({ filters: { ...(input.filters || {}), month: period } });
  if (filters.store_id == null) throw new Error('TARGET_STORE_REQUIRED');
  const rows = await loadRows(filters);
  if (rows.length === 0) throw new Error('TARGET_REFERENCE_NOT_FOUND');
  if (rows.length !== 1) throw new Error('AMBIGUOUS_TARGET_REFERENCE');
  const row = rows[0];
  const value = Number(row.meta_vin);
  if (!Number.isFinite(value)) throw new Error('INVALID_TARGET_VALUE');
  return {
    evidence_id: 'p1.targets.' + period.replace('-', '') + '.store.' + row.sucursal_id,
    evidence_contract: 'p1.reference_observation',
    evidence_version: '0.1.0',
    authority: 'P1_CERTIFIED',
    status: 'CERTIFIED',
    source: DATA_SOURCE,
    operation: 'OBSERVE',
    grain: 'STORE_MONTH',
    measure: { id: 'VIN_TARGET', unit: 'VIN', aggregation: 'EXPLICIT_TARGET' },
    universe: { commercial_universe: 'OWN_STORES' },
    dimensions: { store_id: String(row.sucursal_id) },
    temporal: { period_identity: period },
    coverage: { complete: true, rows: 1 },
    payload: { value, reference_type: 'OFFICIAL_TARGET', source: row.source, store_label: row.store_label },
    lineage: lineage(),
  };
}
