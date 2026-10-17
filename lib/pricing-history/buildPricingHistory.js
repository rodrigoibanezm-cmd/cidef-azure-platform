const CHANGE_TYPES = new Set(['INITIAL','NO_CHANGE','PRECIO','BONO','PRECIO_Y_BONO','SOURCE_CONFLICT']);

function isoDate(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function integerOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`INVALID_INTEGER_VALUE: ${value}`);
  return n;
}
function daysInclusive(from, to) {
  if (!from || !to) return null;
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}
function overlaps(row, dateFrom, dateTo) {
  const from = isoDate(row.vigencia_desde); const to = isoDate(row.vigencia_hasta);
  if (dateFrom && to && to < dateFrom) return false;
  if (dateTo && from > dateTo) return false;
  return true;
}
function sameNullableDate(a, b) { return isoDate(a) === isoDate(b); }
function maxDate(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }
function minDate(a, b) { if (!a) return b; if (!b) return a; return a < b ? a : b; }

export function parsePricingHistoryInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_PRICING_HISTORY_INPUT');
  const allowed = new Set(['brand','model','version','version_id','date_from','date_to','include_conflicts','price_episode_id']);
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`UNSUPPORTED_PRICING_HISTORY_FIELD: ${unsupported}`);
  const versionId = input.version_id == null ? null : integerOrNull(input.version_id);
  const priceEpisodeId = input.price_episode_id == null ? null : integerOrNull(input.price_episode_id);
  const brand = input.brand == null ? null : String(input.brand).trim();
  const model = input.model == null ? null : String(input.model).trim();
  const version = input.version == null ? null : String(input.version).trim();
  if (versionId == null && !(brand && model && version)) throw new Error('VERSION_ID_OR_BRAND_MODEL_VERSION_REQUIRED');
  const dateFrom = input.date_from == null ? null : isoDate(input.date_from);
  const dateTo = input.date_to == null ? null : isoDate(input.date_to);
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('INVALID_DATE_RANGE');
  return { brand, model, version, versionId, dateFrom, dateTo, includeConflicts: input.include_conflicts === true, priceEpisodeId };
}

function aggregateVinRows(vinRows) {
  const byEpisode = new Map();
  for (const row of vinRows) {
    const key = String(row.price_episode_id);
    if (!byEpisode.has(key)) byEpisode.set(key, []);
    byEpisode.get(key).push({ ...row, fecha_factura: isoDate(row.fecha_factura) });
  }
  return byEpisode;
}

export function buildPricingHistory({ identity, episodeRows = [], vinRows = [] }, parsed) {
  if (!identity) throw new Error('PRICING_VERSION_NOT_FOUND');
  const versionId = integerOrNull(identity.version_id);
  const seen = new Set();
  const vinByEpisode = aggregateVinRows(vinRows);

  const scoped = episodeRows
    .filter((row) => integerOrNull(row.version_id) === versionId)
    .filter((row) => parsed.priceEpisodeId == null || integerOrNull(row.price_episode_id) === parsed.priceEpisodeId)
    .filter((row) => overlaps(row, parsed.dateFrom, parsed.dateTo))
    .sort((a, b) => isoDate(a.vigencia_desde).localeCompare(isoDate(b.vigencia_desde)) || Number(a.price_episode_id) - Number(b.price_episode_id));

  for (const row of scoped) {
    const key = String(row.price_episode_id);
    if (seen.has(key)) throw new Error(`DUPLICATE_PRICE_EPISODE: ${key}`);
    seen.add(key);
    if (!CHANGE_TYPES.has(row.tipo_cambio)) throw new Error(`INVALID_TIPO_CAMBIO: ${row.tipo_cambio}`);
    const fullVin = vinByEpisode.get(key) ?? [];
    const canonicalCount = integerOrNull(row.vin_facturados_en_vigencia) ?? 0;
    const firstFull = fullVin.length ? fullVin.map(v => v.fecha_factura).sort()[0] : null;
    const lastFull = fullVin.length ? fullVin.map(v => v.fecha_factura).sort().at(-1) : null;
    if (canonicalCount !== fullVin.length || !sameNullableDate(row.primer_vin_fecha, firstFull) || !sameNullableDate(row.ultimo_vin_fecha, lastFull)) {
      throw new Error(`VIN_RECONCILIATION_FAILED: ${key}`);
    }
    if (row.source_status === 'SOURCE_CONFLICT' && fullVin.length !== 0) throw new Error(`SOURCE_CONFLICT_HAS_VIN: ${key}`);
  }

  const coverage = {
    episodes_total: scoped.length,
    episodes_ok: scoped.filter((row) => row.source_status !== 'SOURCE_CONFLICT').length,
    episodes_conflict: scoped.filter((row) => row.source_status === 'SOURCE_CONFLICT').length,
    vin_assigned: scoped.reduce((sum, row) => sum + (integerOrNull(row.vin_facturados_en_vigencia) ?? 0), 0),
    vin_before_first_episode: null, vin_in_conflict_window: null, coverage_ratio: null, status: 'PARTIAL',
    limitations: ['vin_before_first_episode and vin_in_conflict_window require an unassigned VIN universe not present in canonical pricing authorities; coverage_ratio is therefore not derivable'],
  };

  const history = scoped.map((row) => {
    const vigenciaDesde = isoDate(row.vigencia_desde);
    const vigenciaHasta = isoDate(row.vigencia_hasta);
    const intersectionFrom = maxDate(vigenciaDesde, parsed.dateFrom);
    const intersectionTo = parsed.dateTo ? minDate(vigenciaHasta, parsed.dateTo) : vigenciaHasta;
    const fullVin = vinByEpisode.get(String(row.price_episode_id)) ?? [];
    const periodVin = fullVin.filter((v) => (!intersectionFrom || v.fecha_factura >= intersectionFrom) && (!intersectionTo || v.fecha_factura <= intersectionTo));
    const periodDates = periodVin.map(v => v.fecha_factura).sort();
    const periodCount = periodVin.length;
    const canonicalCount = integerOrNull(row.vin_facturados_en_vigencia) ?? 0;
    return {
      price_episode_id: integerOrNull(row.price_episode_id),
      price_version_id: integerOrNull(row.price_version_id),
      version_id: versionId,
      brand: identity.brand, model: identity.model, version: identity.version,
      vigencia_desde: vigenciaDesde, vigencia_hasta: vigenciaHasta,
      intersection_from: intersectionFrom, intersection_to: intersectionTo,
      days_active: daysInclusive(vigenciaDesde, vigenciaHasta),
      precio_neto: integerOrNull(row.precio_neto), precio_lista: integerOrNull(row.precio_lista), precio_con_iva: integerOrNull(row.precio_con_iva),
      bono_cidef: integerOrNull(row.bono_cidef), bono_forum: integerOrNull(row.bono_forum), bono_mes: integerOrNull(row.bono_mes),
      delta_precio_neto: integerOrNull(row.delta_precio_neto), delta_precio_lista: integerOrNull(row.delta_precio_lista), delta_precio_con_iva: integerOrNull(row.delta_precio_con_iva),
      delta_bono_cidef: integerOrNull(row.delta_bono_cidef), delta_bono_forum: integerOrNull(row.delta_bono_forum), delta_bono_mes: integerOrNull(row.delta_bono_mes),
      tipo_cambio: row.tipo_cambio,
      vin_facturados_en_periodo: periodCount,
      primer_vin_fecha_en_periodo: periodDates[0] ?? null,
      ultimo_vin_fecha_en_periodo: periodDates.at(-1) ?? null,
      vin_facturados: canonicalCount,
      primer_vin_fecha: isoDate(row.primer_vin_fecha),
      ultimo_vin_fecha: isoDate(row.ultimo_vin_fecha),
      source_status: row.source_status,
      source_rows: integerOrNull(row.source_rows),
      source_variant_count: integerOrNull(row.source_variant_count),
      source_files: Array.isArray(row.source_files) ? [...row.source_files] : [],
      evidence: {
        source_rows: integerOrNull(row.source_rows),
        source_variant_count: integerOrNull(row.source_variant_count),
        source_files: Array.isArray(row.source_files) ? [...row.source_files] : [],
      },
    };
  });

  const fullEpisodeVinTotal = history.reduce((sum, row) => sum + row.vin_facturados, 0);
  const periodVinTotal = history.reduce((sum, row) => sum + row.vin_facturados_en_periodo, 0);
  return {
    date_filter_semantics: 'EPISODE_OVERLAP',
    metrics_scope: 'FULL_EPISODE',
    commercial_condition_semantics: 'PUBLISHED_COMMERCIAL_CONDITION',
    scope: { version_id: versionId, brand: identity.brand, model: identity.model, version: identity.version, date_from: parsed.dateFrom, date_to: parsed.dateTo },
    coverage,
    summary: {
      episodes: history.length,
      price_changes: history.filter((row) => row.tipo_cambio === 'PRECIO').length,
      bonus_changes: history.filter((row) => row.tipo_cambio === 'BONO').length,
      combined_changes: history.filter((row) => row.tipo_cambio === 'PRECIO_Y_BONO').length,
      conflicts: history.filter((row) => row.tipo_cambio === 'SOURCE_CONFLICT').length,
      vin_facturados_en_periodo: periodVinTotal,
      vin_facturados: fullEpisodeVinTotal,
    },
    history,
    provenance: {
      episode_authority: 'price_episode_canonico_v01',
      vin_authority: 'price_episode_vin_v01',
      product_identity_authority: 'MASTER',
      commercial_condition_semantics: 'PUBLISHED_COMMERCIAL_CONDITION',
      vin_count_semantics: 'FULL_EPISODE',
      request_period_vin_count_semantics: 'IN_REQUEST_INTERSECTION',
      price_realized_available: false,
    },
  };
}
