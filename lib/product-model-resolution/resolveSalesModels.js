import { normalizeProductKey } from './normalize.js';

export function resolveSaleModel(sale, resolutionMap) {
  const key = normalizeProductKey(sale.producto_sku);
  const match = key ? resolutionMap.get(key) : null;

  if (match?.status === 'AMBIGUOUS') {
    return {
      ...sale,
      product_identity_status: 'AMBIGUOUS',
      modelo_id: null,
      version_id: null,
      product_resolution_method: null,
    };
  }
  if (match?.status === 'RESOLVED' && Number.isFinite(Number(match.modelo_id))) {
    return {
      ...sale,
      product_identity_status: 'RESOLVED',
      modelo_id: Number(match.modelo_id),
      version_id: match.version_id != null && String(match.version_id).trim() !== '' && Number(match.version_id) > 0 && Number.isSafeInteger(Number(match.version_id)) ? Number(match.version_id) : null,
      product_resolution_method: match.resolution_method || null,
    };
  }
  return {
    ...sale,
    product_identity_status: 'UNRESOLVED',
    modelo_id: null,
    version_id: null,
    product_resolution_method: null,
  };
}

export function resolveSalesModels(sales = [], resolutionMap = new Map()) {
  return sales.map((sale) => resolveSaleModel(sale, resolutionMap));
}
