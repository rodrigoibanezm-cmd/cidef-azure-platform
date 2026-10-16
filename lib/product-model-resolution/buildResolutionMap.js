import { normalizeProductKey } from './normalize.js';

function indexAliases(aliasRows = []) {
  const index = new Map();
  for (const row of aliasRows) {
    const key = normalizeProductKey(row.valor_normalizado || row.valor_raw);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    if (Number.isFinite(Number(row.modelo_id))) index.get(key).push({
      modelo_id: Number(row.modelo_id),
      version_id: row.version_id != null && String(row.version_id).trim() !== '' && Number(row.version_id) > 0 && Number.isSafeInteger(Number(row.version_id)) ? Number(row.version_id) : null,
    });
  }
  return index;
}

function evidenceStatus(row) {
  if (!row) return 'UNRESOLVED';
  if (Number(row.distinct_descriptions) !== 1 || Number(row.distinct_brands) !== 1) return 'AMBIGUOUS';
  if (Number(row.ambiguous_vins) > 0 || Number(row.distinct_model_ids) > 1) return 'AMBIGUOUS';
  if (Number(row.distinct_model_ids) === 1 && Number(row.modelo_id) > 0) return 'RESOLVED';
  return 'UNRESOLVED';
}

export function buildProductModelResolutionMap(evidenceRows = [], aliasRows = []) {
  const direct = indexAliases(aliasRows);
  const result = new Map();

  for (const row of evidenceRows) {
    const key = normalizeProductKey(row.sku_norm || row.sku_raw);
    const directRows = direct.get(key) || [];
    const directModels = [...new Set(directRows.map((x) => x.modelo_id))];
    const directVersions = [...new Set(directRows.map((x) => x.version_id).filter(Number.isFinite))];
    const evidenceModels = Array.isArray(row.candidate_model_ids)
      ? row.candidate_model_ids.map(Number).filter(Number.isFinite)
      : [];
    let status = 'UNRESOLVED';
    let modeloId = null;
    let versionId = null;
    let method = null;

    if (directModels.length === 1) {
      status = 'RESOLVED';
      modeloId = directModels[0];
      if (directVersions.length === 1) versionId = directVersions[0];
      method = 'CERTIFIED_VENTAS_ALIAS';
    } else if (directModels.length > 1) {
      status = 'AMBIGUOUS';
      modeloId = null;
      versionId = null;
      method = 'CERTIFIED_ALIAS_CONFLICT';
    }

    result.set(key, {
      sku: row.sku_raw,
      desc_articulo: row.desc_articulo,
      marca_raw: row.marca_raw,
      status,
      modelo_id: modeloId,
      version_id: versionId,
      resolution_method: method,
      candidate_model_ids: directModels.length > 0 ? directModels : evidenceModels,
      raw_rows: Number(row.raw_rows || 0),
      observed_vins: Number(row.observed_vins || 0),
      canonical_vins: Number(row.canonical_vins || 0),
      rvm_vins: Number(row.rvm_vins || 0),
      ambiguous_vins: Number(row.ambiguous_vins || 0),
      no_evidence_vins: Number(row.no_evidence_vins || 0),
      source_conflict_vins: Number(row.source_conflict_vins || 0),
    });
  }

  for (const [key, directRows] of direct.entries()) {
    if (result.has(key)) continue;
    const ids = [...new Set(directRows.map((x) => x.modelo_id))];
    const versionIds = [...new Set(directRows.map((x) => x.version_id).filter(Number.isFinite))];
    result.set(key, {
      sku: key, desc_articulo: null, marca_raw: null,
      status: ids.length === 1 ? 'RESOLVED' : 'AMBIGUOUS',
      modelo_id: ids.length === 1 ? ids[0] : null,
      version_id: ids.length === 1 && versionIds.length === 1 ? versionIds[0] : null,
      resolution_method: ids.length === 1 ? 'CERTIFIED_VENTAS_ALIAS' : 'CERTIFIED_ALIAS_CONFLICT',
      candidate_model_ids: ids,
      raw_rows: 0, observed_vins: 0, canonical_vins: 0, rvm_vins: 0,
      ambiguous_vins: 0, no_evidence_vins: 0, source_conflict_vins: 0,
    });
  }

  return result;
}
