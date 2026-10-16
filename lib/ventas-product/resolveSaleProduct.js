function norm(value) {
  if (value == null) return null;
  const text = String(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  return text || null;
}

function addIndex(index, key, row) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  const rows = index.get(key);
  if (!rows.includes(row)) rows.push(row);
}

export function buildProductAliasIndex(aliasRows = []) {
  const index = new Map();
  for (const row of aliasRows) {
    addIndex(index, norm(row.valor_raw), row);
    addIndex(index, norm(row.valor_normalizado), row);
  }
  return index;
}

export function resolveSaleProduct(sale, aliasIndex) {
  // CIDEF SALES identity is certified by the ventas_raw SKU alias. desc_articulo is evidence only.
  const key = norm(sale.producto_sku);
  const matches = key ? (aliasIndex.get(key) || []) : [];
  const modelIds = [...new Set(matches.map((row) => Number(row.modelo_id)).filter(Number.isFinite))];
  const versionIds = [...new Set(matches.filter((row) => row.version_id != null && String(row.version_id).trim() !== '').map((row) => Number(row.version_id)).filter((id) => Number.isSafeInteger(id) && id > 0))];

  if (!modelIds.length) return { ...sale, product_identity_status: 'UNRESOLVED', modelo_id: null, version_id: null };
  if (modelIds.length > 1) return { ...sale, product_identity_status: 'AMBIGUOUS', modelo_id: null, version_id: null };

  return {
    ...sale,
    product_identity_status: 'RESOLVED',
    modelo_id: modelIds[0],
    version_id: versionIds.length === 1 ? versionIds[0] : null,
  };
}

export function resolveSalesProducts(sales = [], aliasRows = []) {
  const index = buildProductAliasIndex(aliasRows);
  return sales.map((sale) => resolveSaleProduct(sale, index));
}

