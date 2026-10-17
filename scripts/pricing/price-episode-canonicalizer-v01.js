import { createHash } from 'node:crypto';
import { azureQuery as queryDb } from '../../lib/azure-postgres.js';

const VERSION = '0.3';
const EXCLUDED_PRICE_VERSION_IDS = new Set([77]);
const COMMERCIAL_FIELDS = [
  'precio_neto',
  'precio_lista',
  'precio_con_iva',
  'bono_cidef',
  'bono_forum',
  'bono_mes',
  'precio_efectivo_pre_mes_sin_iva',
  'precio_efectivo_pre_mes_con_iva',
  'precio_efectivo_final_sin_iva',
  'precio_efectivo_final_con_iva',
];
const PRICE_FIELDS = new Set(['precio_neto', 'precio_lista', 'precio_con_iva', 'precio_efectivo_pre_mes_sin_iva', 'precio_efectivo_pre_mes_con_iva', 'precio_efectivo_final_sin_iva', 'precio_efectivo_final_con_iva']);
const BONUS_FIELDS = new Set(['bono_cidef', 'bono_forum', 'bono_mes']);

function n(value) {
  return Number(value ?? 0);
}

function nullableInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`price_episode_canonicalizer_v01 invalid integer value: ${value}`);
  return parsed;
}

function dateOnly(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function previousDate(yyyyMmDd) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function normalizeProductText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function commercialTuple(row) {
  return Object.fromEntries(COMMERCIAL_FIELDS.map((field) => [field, nullableInt(row[field])]));
}

function tupleKey(tuple) {
  return JSON.stringify(COMMERCIAL_FIELDS.map((field) => tuple[field]));
}

function commercialConditionId(tuple) {
  return createHash('md5').update(tupleKey(tuple)).digest('hex');
}

function tuplesEqual(a, b) {
  return COMMERCIAL_FIELDS.every((field) => Object.is(a[field], b[field]));
}

function unionSortedNumbers(...collections) {
  return [...new Set(collections.flat().map(Number))].sort((a, b) => a - b);
}

function qualityFlags(row) {
  const flags = [];
  const sheet = String(row.source_sheet ?? '').toUpperCase();
  const preSin = nullableInt(row.precio_efectivo_pre_mes_sin_iva);
  const preIva = nullableInt(row.precio_efectivo_pre_mes_con_iva);
  const finalSin = nullableInt(row.precio_efectivo_final_sin_iva);
  const bonoMes = nullableInt(row.bono_mes);

  if (sheet === 'FOTON VIEW GRAND' && preSin != null && preIva != null && Math.round(preSin * 1.19) !== preIva) {
    flags.push('SOURCE_PRE_IVA_RECONCILIATION_EXCEPTION');
  }
  if (sheet === 'DONGFENG' && bonoMes != null && bonoMes !== 0 && preSin != null && finalSin != null && preSin === finalSin) {
    flags.push('SOURCE_FINAL_NOT_SEPARATELY_PUBLISHED');
  }
  if (sheet === 'DONGFENG PICK UP' && row.precio_lista != null && finalSin != null) {
    const expected = nullableInt(row.precio_lista) - (nullableInt(row.bono_cidef) ?? 0) - (nullableInt(row.bono_forum) ?? 0) - (bonoMes ?? 0);
    if (expected !== finalSin) flags.push('SOURCE_BONUS_RECONCILIATION_EXCEPTION');
  }
  return flags;
}

export function classifyChange(previousTuple, currentTuple, isFirstClean = false) {
  if (isFirstClean || !previousTuple) return 'INITIAL';
  let priceChanged = false;
  let bonusChanged = false;
  for (const field of COMMERCIAL_FIELDS) {
    const changed = !Object.is(previousTuple[field], currentTuple[field]);
    if (!changed) continue;
    if (PRICE_FIELDS.has(field)) priceChanged = true;
    if (BONUS_FIELDS.has(field)) bonusChanged = true;
  }
  if (!priceChanged && !bonusChanged) return 'NO_CHANGE';
  if (priceChanged && bonusChanged) return 'PRECIO_Y_BONO';
  return priceChanged ? 'PRECIO' : 'BONO';
}

function deltas(previousTuple, currentTuple) {
  if (!previousTuple) {
    return Object.fromEntries(COMMERCIAL_FIELDS.map((field) => [`delta_${field}`, null]));
  }
  const result = {};
  for (const field of COMMERCIAL_FIELDS) {
    const previous = previousTuple[field];
    const current = currentTuple[field];
    result[`delta_${field}`] = previous == null || current == null ? null : current - previous;
  }
  return result;
}

export function resolvePriceVersions(priceVersions, aliases, masterRows) {
  const aliasIndex = new Map();
  for (const alias of aliases) {
    if (String(alias.fuente || '').toLowerCase() !== 'lista_precios') continue;
    if (String(alias.nivel || '').toUpperCase() !== 'VERSION') continue;
    if (String(alias.estado || '').toUpperCase() !== 'RESUELTO') continue;
    if (alias.version_id == null) continue;
    const key = [
      normalizeProductText(alias.contexto_marca_raw),
      normalizeProductText(alias.contexto_modelo_raw),
      normalizeProductText(alias.valor_raw),
    ].join('|');
    if (!aliasIndex.has(key)) aliasIndex.set(key, new Set());
    aliasIndex.get(key).add(Number(alias.version_id));
  }

  const masterIndex = new Map();
  for (const row of masterRows) {
    const key = [
      normalizeProductText(row.marca_canonica ?? row.marca_normalizada),
      normalizeProductText(row.modelo_canonico ?? row.modelo_normalizado),
      normalizeProductText(row.version_canonica ?? row.version_normalizada),
    ].join('|');
    if (!masterIndex.has(key)) masterIndex.set(key, new Set());
    masterIndex.get(key).add(Number(row.version_id));
  }

  const result = new Map();
  const counts = { total: priceVersions.length, resolved: 0, excluded: 0, unresolved: 0 };
  const unresolved = [];

  for (const pv of priceVersions) {
    const id = Number(pv.price_version_id);
    if (EXCLUDED_PRICE_VERSION_IDS.has(id)) {
      result.set(id, { status: 'excluded', version_id: null, method: 'EXPLICIT_HISTORICAL_EXCLUSION' });
      counts.excluded += 1;
      continue;
    }

    const versionValue = pv.version_raw ?? pv.version;
    const exactKey = [normalizeProductText(pv.marca), normalizeProductText(pv.modelo), normalizeProductText(versionValue)].join('|');
    const aliasCandidates = aliasIndex.get(exactKey) ?? new Set();
    if (aliasCandidates.size === 1) {
      const versionId = [...aliasCandidates][0];
      result.set(id, { status: 'resolved', version_id: versionId, method: 'ALIAS_LISTA_PRECIOS' });
      counts.resolved += 1;
      continue;
    }

    const masterCandidates = masterIndex.get(exactKey) ?? new Set();
    if (masterCandidates.size === 1) {
      const versionId = [...masterCandidates][0];
      result.set(id, { status: 'resolved', version_id: versionId, method: 'EXACT_NORMALIZED_MASTER' });
      counts.resolved += 1;
      continue;
    }

    result.set(id, { status: 'unresolved', version_id: null, method: aliasCandidates.size > 1 || masterCandidates.size > 1 ? 'AMBIGUOUS' : 'NO_MATCH' });
    counts.unresolved += 1;
    unresolved.push(id);
  }

  return { map: result, counts, unresolved };
}

export function buildStatePoints(historyRows, resolutionMap) {
  const groups = new Map();
  for (const row of historyRows) {
    const priceVersionId = Number(row.price_version_id);
    const resolution = resolutionMap.get(priceVersionId) ?? { status: 'unresolved', version_id: null };
    const date = dateOnly(row.vigencia_desde);
    const key = resolution.status === 'resolved'
      ? `VERSION|${Number(resolution.version_id)}|${date}`
      : `PRICE_VERSION|${priceVersionId}|${date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, priceVersionId, resolution });
  }

  const points = [];
  for (const evidence of groups.values()) {
    const first = evidence[0];
    const resolved = first.resolution.status === 'resolved';
    const variants = new Map();
    for (const item of evidence) {
      const tuple = commercialTuple(item.row);
      const key = tupleKey(tuple);
      if (!variants.has(key)) variants.set(key, { tuple, evidence: [] });
      variants.get(key).evidence.push(item);
    }

    for (const variant of variants.values()) {
      const variantEvidence = variant.evidence;
      const priceVersionIds = unionSortedNumbers(variantEvidence.map((item) => item.priceVersionId));
      points.push({
        price_version_id: priceVersionIds[0],
        price_version_ids: priceVersionIds,
        version_id: resolved ? Number(first.resolution.version_id) : null,
        resolution_status: first.resolution.status,
        vigencia_desde: dateOnly(first.row.vigencia_desde),
        commercial_condition_id: commercialConditionId(variant.tuple),
        source_status: 'OK',
        tuple: variant.tuple,
        source_rows: variantEvidence.length,
        source_variant_count: variants.size,
        source_files: [...new Set(variantEvidence.map((item) => item.row.source_file).filter(Boolean))].sort(),
        quality_flags: [...new Set(variantEvidence.flatMap((item) => qualityFlags(item.row)))].sort(),
      });
    }
  }
  points.sort((a, b) => {
    const aVersion = a.version_id ?? Number.MAX_SAFE_INTEGER;
    const bVersion = b.version_id ?? Number.MAX_SAFE_INTEGER;
    return aVersion - bVersion
      || a.vigencia_desde.localeCompare(b.vigencia_desde)
      || a.commercial_condition_id.localeCompare(b.commercial_condition_id)
      || a.price_version_id - b.price_version_id;
  });
  return points;
}
export function buildPriceEpisodes(statePoints) {
  const byVersion = new Map();
  for (const point of statePoints) {
    if (point.resolution_status !== 'resolved') continue;
    const versionId = Number(point.version_id);
    if (!byVersion.has(versionId)) byVersion.set(versionId, []);
    byVersion.get(versionId).push(point);
  }

  const episodes = [];
  for (const [versionId, points] of byVersion) {
    const byDate = new Map();
    for (const point of points) {
      if (!byDate.has(point.vigencia_desde)) byDate.set(point.vigencia_desde, []);
      byDate.get(point.vigencia_desde).push(point);
    }
    const dates = [...byDate.keys()].sort();
    const active = new Map();
    const completed = [];

    for (const date of dates) {
      const today = byDate.get(date);
      const todayIds = new Set(today.map((point) => point.commercial_condition_id));

      for (const [conditionId, segment] of [...active.entries()]) {
        if (todayIds.has(conditionId)) continue;
        segment.vigencia_hasta = previousDate(date);
        completed.push(segment);
        active.delete(conditionId);
      }

      for (const point of today) {
        const conditionId = point.commercial_condition_id;
        const current = active.get(conditionId);
        if (current) {
          current.source_rows += point.source_rows;
          current.source_variant_count = Math.max(current.source_variant_count, point.source_variant_count);
          current.source_files = [...new Set([...current.source_files, ...point.source_files])].sort();
          current.price_version_ids = unionSortedNumbers(current.price_version_ids, point.price_version_ids ?? [point.price_version_id]);
          current.quality_flags = [...new Set([...current.quality_flags, ...(point.quality_flags ?? [])])].sort();
          continue;
        }
        active.set(conditionId, {
          price_version_id: point.price_version_id,
          price_version_ids: [...(point.price_version_ids ?? [point.price_version_id])],
          version_id: versionId,
          commercial_condition_id: conditionId,
          vigencia_desde: point.vigencia_desde,
          vigencia_hasta: null,
          source_status: 'OK',
          tuple: { ...point.tuple },
          source_rows: point.source_rows,
          source_variant_count: point.source_variant_count,
          source_files: [...point.source_files],
          quality_flags: [...(point.quality_flags ?? [])],
        });
      }
    }
    completed.push(...active.values());

    completed.sort((a, b) => a.vigencia_desde.localeCompare(b.vigencia_desde)
      || a.commercial_condition_id.localeCompare(b.commercial_condition_id));

    for (const segment of completed) {
      const immediatelyPrevious = completed.filter((candidate) =>
        candidate.vigencia_hasta === previousDate(segment.vigencia_desde));
      const predecessor = immediatelyPrevious.length === 1 ? immediatelyPrevious[0] : null;
      const previousTuple = predecessor?.tuple ?? null;
      episodes.push({
        ...segment,
        ...segment.tuple,
        ...deltas(previousTuple, segment.tuple),
        tipo_cambio: classifyChange(previousTuple, segment.tuple, !previousTuple),
      });
    }
  }

  return episodes.sort((a, b) => Number(a.version_id) - Number(b.version_id)
    || a.vigencia_desde.localeCompare(b.vigencia_desde)
    || a.commercial_condition_id.localeCompare(b.commercial_condition_id)
    || a.price_version_id - b.price_version_id);
}

function inRange(date, episode) {
  return date >= episode.vigencia_desde && (episode.vigencia_hasta == null || date <= episode.vigencia_hasta);
}

function episodeKey(episode) {
  return `${episode.version_id}|${episode.vigencia_desde}|${episode.commercial_condition_id}`;
}

export function assignVehiclesToEpisodes(vehicleRows, episodes) {
  const cleanByVersion = new Map();
  for (const episode of episodes) {
    if (episode.source_status !== 'OK') continue;
    if (!cleanByVersion.has(Number(episode.version_id))) cleanByVersion.set(Number(episode.version_id), []);
    cleanByVersion.get(Number(episode.version_id)).push(episode);
  }

  const assignments = [];
  const ambiguous = [];
  let eligible = 0;
  let unassigned = 0;

  for (const vehicle of vehicleRows) {
    if (vehicle.vendido !== true || vehicle.version_id == null || vehicle.fecha_factura == null) continue;
    const candidates = cleanByVersion.get(Number(vehicle.version_id));
    if (!candidates?.length) continue;
    eligible += 1;
    const date = dateOnly(vehicle.fecha_factura);
    const matches = candidates.filter((episode) => inRange(date, episode));
    if (matches.length === 0) {
      unassigned += 1;
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push({ vehiculo_id: Number(vehicle.vehiculo_id), vin: vehicle.vin, matches: matches.map((e) => `${e.version_id}|${e.vigencia_desde}`) });
      continue;
    }
    const episode = matches[0];
    assignments.push({
      episode_key: episodeKey(episode),
      price_version_id: episode.price_version_id,
      commercial_condition_id: episode.commercial_condition_id,
      vigencia_desde: episode.vigencia_desde,
      vehiculo_id: Number(vehicle.vehiculo_id),
      vin: vehicle.vin,
      version_id: Number(vehicle.version_id),
      fecha_factura: date,
      numero_factura: vehicle.numero_factura ?? null,
    });
  }

  return { eligible, assigned: assignments.length, unassigned, ambiguous: ambiguous.length, assignments, ambiguous_rows: ambiguous };
}

export function addEpisodeVinAggregates(episodes, assignments) {
  const aggregate = new Map();
  for (const assignment of assignments) {
    const key = assignment.episode_key;
    if (!aggregate.has(key)) aggregate.set(key, { count: 0, min: null, max: null });
    const item = aggregate.get(key);
    item.count += 1;
    item.min = item.min == null || assignment.fecha_factura < item.min ? assignment.fecha_factura : item.min;
    item.max = item.max == null || assignment.fecha_factura > item.max ? assignment.fecha_factura : item.max;
  }
  return episodes.map((episode) => {
    const item = aggregate.get(episodeKey(episode)) ?? { count: 0, min: null, max: null };
    return {
      ...episode,
      vin_facturados_en_vigencia: item.count,
      primer_vin_fecha: item.min,
      ultimo_vin_fecha: item.max,
    };
  });
}

function diagnostic(resolution, statePoints, episodes, vinAssignment, dryRun) {
  const multiPriceVersionEpisodes = episodes.filter((episode) => (episode.price_version_ids?.length ?? 1) > 1);
  return {
    phase: 'price_episode_canonicalizer_v01',
    version: VERSION,
    dry_run: dryRun,
    price_versions: resolution.counts,
    state_points: {
      total: statePoints.length,
      clean: statePoints.filter((p) => p.source_status === 'OK').length,
      coexisting_conditions: statePoints.filter((p) => p.source_variant_count > 1).length,
    },
    episodes: {
      total: episodes.length,
      clean: episodes.filter((p) => p.source_status === 'OK').length,
      coexisting_conditions: episodes.filter((p) => p.source_variant_count > 1).length,
    },
    vin_assignment: {
      eligible: vinAssignment.eligible,
      assigned: vinAssignment.assigned,
      unassigned: vinAssignment.unassigned,
      ambiguous: vinAssignment.ambiguous,
    },
    provenance: {
      price_version_id_semantics: 'REPRESENTATIVE_TECHNICAL_ORIGIN_OF_EPISODE',
      multi_price_version_episodes: multiPriceVersionEpisodes.length,
      quality_exception_episodes: episodes.filter((episode) => (episode.quality_flags?.length ?? 0) > 0).length,
      sample: multiPriceVersionEpisodes.slice(0, 10).map((episode) => ({
        version_id: episode.version_id,
        vigencia_desde: episode.vigencia_desde,
        price_version_id: episode.price_version_id,
        price_version_ids: episode.price_version_ids,
      })),
    },
  };
}

async function loadInputs() {
  const [priceVersions, aliases, masterRows, historyRows, vehicleRows] = await Promise.all([
    queryDb(`SELECT price_version_id, marca, modelo, version, version_raw FROM public.price_versions ORDER BY price_version_id`),
    queryDb(`SELECT fuente, nivel, estado, valor_raw, contexto_marca_raw, contexto_modelo_raw, version_id FROM public.producto_aliases_v01 WHERE fuente='lista_precios' AND nivel='VERSION' AND estado='RESUELTO'`),
    queryDb(`
      SELECT v.version_id,
             ma.nombre_canonico AS marca_canonica,
             ma.nombre_normalizado AS marca_normalizada,
             mo.nombre_canonico AS modelo_canonico,
             mo.nombre_normalizado AS modelo_normalizado,
             v.nombre_canonico AS version_canonica,
             v.nombre_normalizado AS version_normalizada
      FROM public.versiones_master_v01 v
      JOIN public.modelos_master_v01 mo ON mo.modelo_id=v.modelo_id
      JOIN public.marcas_master_v01 ma ON ma.marca_id=mo.marca_id
    `),
    queryDb(`SELECT price_history_id, price_version_id, vigencia_desde, precio_neto, precio_lista, precio_con_iva, bono_cidef, bono_forum, bono_mes, precio_efectivo_pre_mes_sin_iva, precio_efectivo_pre_mes_con_iva, precio_efectivo_final_sin_iva, precio_efectivo_final_con_iva, source_file, source_sheet FROM public.price_history ORDER BY price_version_id, vigencia_desde, price_history_id`),
    queryDb(`SELECT vehiculo_id, vin, version_id, fecha_factura, numero_factura, vendido FROM public.vehiculo_canonico WHERE vendido=true AND version_id IS NOT NULL AND fecha_factura IS NOT NULL ORDER BY vehiculo_id`),
  ]);
  return { priceVersions, aliases, masterRows, historyRows, vehicleRows };
}

function persistedEpisodePayload(episodes) {
  return episodes.map((episode) => {
    const copy = { ...episode };
    delete copy.tuple;
    delete copy.price_version_ids;
    return copy;
  });
}

function jsonDollarLiteral(value) {
  const json = JSON.stringify(value);
  if (json.includes('$price_episode_json$')) throw new Error('price_episode_canonicalizer_v01 JSON delimiter collision');
  return `$price_episode_json$${json}$price_episode_json$`;
}

async function persistAtomically(episodes, assignments, expectedConflicts) {
  const episodeJson = jsonDollarLiteral(persistedEpisodePayload(episodes));
  const assignmentJson = jsonDollarLiteral(assignments);
  const sql = `
DO $price_episode_do$
DECLARE
  episode_payload jsonb := ${episodeJson}::jsonb;
  vin_payload jsonb := ${assignmentJson}::jsonb;
  failures bigint;
  conflict_count bigint;
BEGIN
  TRUNCATE TABLE public.price_episode_vin_v01, public.price_episode_canonico_v01 RESTART IDENTITY;

  INSERT INTO public.price_episode_canonico_v01 (
    version_id, price_version_id, commercial_condition_id, vigencia_desde, vigencia_hasta,
    precio_neto, precio_lista, precio_con_iva, bono_cidef, bono_forum, bono_mes,
    precio_efectivo_pre_mes_sin_iva, precio_efectivo_pre_mes_con_iva, precio_efectivo_final_sin_iva, precio_efectivo_final_con_iva,
    delta_precio_neto, delta_precio_lista, delta_precio_con_iva,
    delta_bono_cidef, delta_bono_forum, delta_bono_mes,
    delta_precio_efectivo_pre_mes_sin_iva, delta_precio_efectivo_pre_mes_con_iva, delta_precio_efectivo_final_sin_iva, delta_precio_efectivo_final_con_iva,
    tipo_cambio, source_status, source_rows, source_variant_count, source_files, quality_flags,
    vin_facturados_en_vigencia, primer_vin_fecha, ultimo_vin_fecha, canonicalized_at
  )
  SELECT
    x.version_id, x.price_version_id, x.commercial_condition_id, x.vigencia_desde, x.vigencia_hasta,
    x.precio_neto, x.precio_lista, x.precio_con_iva, x.bono_cidef, x.bono_forum, x.bono_mes,
    x.precio_efectivo_pre_mes_sin_iva, x.precio_efectivo_pre_mes_con_iva, x.precio_efectivo_final_sin_iva, x.precio_efectivo_final_con_iva,
    x.delta_precio_neto, x.delta_precio_lista, x.delta_precio_con_iva,
    x.delta_bono_cidef, x.delta_bono_forum, x.delta_bono_mes,
    x.delta_precio_efectivo_pre_mes_sin_iva, x.delta_precio_efectivo_pre_mes_con_iva, x.delta_precio_efectivo_final_sin_iva, x.delta_precio_efectivo_final_con_iva,
    x.tipo_cambio, x.source_status, x.source_rows, x.source_variant_count, x.source_files, x.quality_flags,
    x.vin_facturados_en_vigencia, x.primer_vin_fecha, x.ultimo_vin_fecha, now()
  FROM jsonb_to_recordset(episode_payload) AS x(
    version_id bigint, price_version_id bigint, commercial_condition_id text, vigencia_desde date, vigencia_hasta date,
    precio_neto bigint, precio_lista bigint, precio_con_iva bigint, bono_cidef bigint, bono_forum bigint, bono_mes bigint,
    precio_efectivo_pre_mes_sin_iva bigint, precio_efectivo_pre_mes_con_iva bigint, precio_efectivo_final_sin_iva bigint, precio_efectivo_final_con_iva bigint,
    delta_precio_neto bigint, delta_precio_lista bigint, delta_precio_con_iva bigint,
    delta_bono_cidef bigint, delta_bono_forum bigint, delta_bono_mes bigint,
    delta_precio_efectivo_pre_mes_sin_iva bigint, delta_precio_efectivo_pre_mes_con_iva bigint, delta_precio_efectivo_final_sin_iva bigint, delta_precio_efectivo_final_con_iva bigint,
    tipo_cambio text, source_status text, source_rows integer, source_variant_count integer, source_files text[], quality_flags text[],
    vin_facturados_en_vigencia integer, primer_vin_fecha date, ultimo_vin_fecha date
  );

  INSERT INTO public.price_episode_vin_v01 (
    price_episode_id, vehiculo_id, vin, version_id, fecha_factura, numero_factura, canonicalized_at
  )
  SELECT e.price_episode_id, x.vehiculo_id, x.vin, x.version_id, x.fecha_factura, x.numero_factura, now()
  FROM jsonb_to_recordset(vin_payload) AS x(
    price_version_id bigint, commercial_condition_id text, vigencia_desde date, vehiculo_id bigint, vin text, version_id bigint, fecha_factura date, numero_factura text
  )
  JOIN public.price_episode_canonico_v01 e
    ON e.price_version_id=x.price_version_id AND e.commercial_condition_id=x.commercial_condition_id AND e.vigencia_desde=x.vigencia_desde
  WHERE e.source_status='OK';

  SELECT count(*) INTO failures
  FROM public.price_episode_canonico_v01
  WHERE vigencia_hasta IS NOT NULL AND vigencia_hasta < vigencia_desde;
  IF failures <> 0 THEN RAISE EXCEPTION 'price_episode_canonicalizer_v01 invalid episode ranges=%', failures; END IF;

  SELECT count(*) INTO failures
  FROM public.price_episode_canonico_v01 a
  JOIN public.price_episode_canonico_v01 b
    ON a.version_id=b.version_id
   AND a.commercial_condition_id=b.commercial_condition_id
   AND a.price_episode_id < b.price_episode_id
   AND a.source_status='OK' AND b.source_status='OK'
   AND daterange(a.vigencia_desde, COALESCE(a.vigencia_hasta, 'infinity'::date), '[]')
       && daterange(b.vigencia_desde, COALESCE(b.vigencia_hasta, 'infinity'::date), '[]');
  IF failures <> 0 THEN RAISE EXCEPTION 'price_episode_canonicalizer_v01 clean overlaps=%', failures; END IF;

  SELECT count(*) INTO conflict_count FROM public.price_episode_canonico_v01 WHERE source_status='SOURCE_CONFLICT';
  IF conflict_count <> ${Number(expectedConflicts)} THEN RAISE EXCEPTION 'price_episode_canonicalizer_v01 conflict reconciliation expected=${Number(expectedConflicts)} actual=%', conflict_count; END IF;

  SELECT count(*) INTO failures
  FROM public.price_episode_vin_v01 v
  JOIN public.price_episode_canonico_v01 e USING(price_episode_id)
  WHERE e.source_status='SOURCE_CONFLICT';
  IF failures <> 0 THEN RAISE EXCEPTION 'price_episode_canonicalizer_v01 VIN assigned to conflict=%', failures; END IF;

  SELECT count(*) INTO failures
  FROM public.price_episode_vin_v01 v
  JOIN public.price_episode_canonico_v01 e USING(price_episode_id)
  WHERE v.fecha_factura < e.vigencia_desde
     OR (e.vigencia_hasta IS NOT NULL AND v.fecha_factura > e.vigencia_hasta)
     OR v.version_id <> e.version_id;
  IF failures <> 0 THEN RAISE EXCEPTION 'price_episode_canonicalizer_v01 bridge temporal/version mismatch=%', failures; END IF;

  SELECT count(*) INTO failures
  FROM (
    SELECT vehiculo_id FROM public.price_episode_vin_v01 GROUP BY vehiculo_id HAVING count(*) > 1
  ) q;
  IF failures <> 0 THEN RAISE EXCEPTION 'price_episode_canonicalizer_v01 duplicate vehiculo bridge=%', failures; END IF;

  SELECT count(*) INTO failures
  FROM public.price_episode_canonico_v01 e
  LEFT JOIN (
    SELECT price_episode_id, count(*)::integer AS n, min(fecha_factura) AS min_f, max(fecha_factura) AS max_f
    FROM public.price_episode_vin_v01 GROUP BY price_episode_id
  ) b USING(price_episode_id)
  WHERE e.vin_facturados_en_vigencia <> COALESCE(b.n,0)
     OR e.primer_vin_fecha IS DISTINCT FROM b.min_f
     OR e.ultimo_vin_fecha IS DISTINCT FROM b.max_f;
  IF failures <> 0 THEN RAISE EXCEPTION 'price_episode_canonicalizer_v01 bridge aggregate reconciliation=%', failures; END IF;
END
$price_episode_do$;`;
  await queryDb(sql);
}

async function postAudit(expectedConflicts) {
  const rows = await queryDb(`
    WITH overlap_rows AS (
      SELECT count(*) AS n
      FROM public.price_episode_canonico_v01 a
      JOIN public.price_episode_canonico_v01 b
        ON a.version_id=b.version_id
       AND a.commercial_condition_id=b.commercial_condition_id
       AND a.price_episode_id < b.price_episode_id
       AND a.source_status='OK' AND b.source_status='OK'
       AND daterange(a.vigencia_desde, COALESCE(a.vigencia_hasta, 'infinity'::date), '[]')
           && daterange(b.vigencia_desde, COALESCE(b.vigencia_hasta, 'infinity'::date), '[]')
    ), bridge_mismatch AS (
      SELECT count(*) AS n
      FROM public.price_episode_vin_v01 v JOIN public.price_episode_canonico_v01 e USING(price_episode_id)
      WHERE v.fecha_factura < e.vigencia_desde
         OR (e.vigencia_hasta IS NOT NULL AND v.fecha_factura > e.vigencia_hasta)
         OR v.version_id <> e.version_id
    ), reconciliation AS (
      SELECT count(*) AS n
      FROM public.price_episode_canonico_v01 e
      LEFT JOIN (
        SELECT price_episode_id, count(*)::integer AS n, min(fecha_factura) AS min_f, max(fecha_factura) AS max_f
        FROM public.price_episode_vin_v01 GROUP BY price_episode_id
      ) b USING(price_episode_id)
      WHERE e.vin_facturados_en_vigencia <> COALESCE(b.n,0)
         OR e.primer_vin_fecha IS DISTINCT FROM b.min_f
         OR e.ultimo_vin_fecha IS DISTINCT FROM b.max_f
    )
    SELECT
      (SELECT count(*) FROM public.price_episode_canonico_v01) AS episodes_total,
      (SELECT count(*) FROM public.price_episode_canonico_v01 WHERE source_status='OK') AS episodes_clean,
      (SELECT count(*) FROM public.price_episode_canonico_v01 WHERE source_status='SOURCE_CONFLICT') AS source_conflicts,
      (SELECT count(*) FROM public.price_episode_vin_v01) AS vin_assigned,
      (SELECT n FROM overlap_rows) AS overlaps,
      (SELECT count(*) FROM (SELECT price_version_id,vigencia_desde,commercial_condition_id FROM public.price_episode_canonico_v01 GROUP BY 1,2,3 HAVING count(*)>1) d) AS grain_duplicates,
      (SELECT count(*) FROM (SELECT vehiculo_id FROM public.price_episode_vin_v01 GROUP BY 1 HAVING count(*)>1) d) AS bridge_duplicates,
      (SELECT n FROM bridge_mismatch) AS mismatches,
      (SELECT n FROM reconciliation) AS reconciliation_failures,
      (SELECT count(*) FROM public.price_episode_vin_v01 v JOIN public.price_episode_canonico_v01 e USING(price_episode_id) WHERE e.source_status='SOURCE_CONFLICT') AS conflict_vins,
      ${Number(expectedConflicts)}::bigint AS expected_source_conflicts
  `);
  const audit = rows[0];
  const failures = n(audit.overlaps) + n(audit.grain_duplicates) + n(audit.bridge_duplicates) + n(audit.mismatches) + n(audit.reconciliation_failures) + n(audit.conflict_vins) + (n(audit.source_conflicts) === n(audit.expected_source_conflicts) ? 0 : 1);
  if (failures !== 0) throw new Error(`price_episode_canonicalizer_v01 post-audit failed: ${JSON.stringify(audit)}`);
  return audit;
}

export async function priceEpisodeCanonicalizerV01(options = {}) {
  const dryRun = options?.dry_run === true;
  const inputs = await loadInputs();
  const resolution = resolvePriceVersions(inputs.priceVersions, inputs.aliases, inputs.masterRows);
  const statePoints = buildStatePoints(inputs.historyRows, resolution.map);
  const episodesBase = buildPriceEpisodes(statePoints);
  const vinAssignment = assignVehiclesToEpisodes(inputs.vehicleRows, episodesBase);
  const episodes = addEpisodeVinAggregates(episodesBase, vinAssignment.assignments);
  const result = diagnostic(resolution, statePoints, episodes, vinAssignment, dryRun);

  if (dryRun) {
    return {
      ...result,
      unresolved_price_version_ids: resolution.unresolved,
      ambiguous_vehicle_sample: vinAssignment.ambiguous_rows.slice(0, 10),
    };
  }

  if (resolution.counts.unresolved !== 0) {
    throw new Error(`price_episode_canonicalizer_v01 blocked: unresolved price_versions=${resolution.unresolved.join(',')}`);
  }

  const expectedConflicts = episodes.filter((episode) => episode.source_status === 'SOURCE_CONFLICT').length;
  await persistAtomically(episodes, vinAssignment.assignments, expectedConflicts);
  const audit = await postAudit(expectedConflicts);

  return { ...result, dry_run: false, audit };
}

