// Canonical commercial row emitted by pricing source adapters.
// This is the Piso 1 boundary: heterogeneous XLS layouts end here.

const cleanText = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
};

export const PRICING_CANONICAL_FIELDS = Object.freeze([
  'vigencia_desde',
  'marca',
  'modelo',
  'version',
  'codigo',
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
  'source_file',
  'source_sheet',
  'source_row',
]);

export function canonicalPricingRow(input = {}) {
  const row = {};
  for (const field of PRICING_CANONICAL_FIELDS) row[field] = input[field] ?? null;

  row.marca = cleanText(row.marca)?.toUpperCase() ?? null;
  row.modelo = cleanText(row.modelo);
  row.version = cleanText(row.version);
  row.codigo = cleanText(row.codigo);
  row.source_file = cleanText(row.source_file);
  row.source_sheet = cleanText(row.source_sheet);
  row.source_row = Number(row.source_row) || null;

  return row;
}

export function validateCanonicalPricingRow(row) {
  const missing = ['vigencia_desde', 'marca', 'modelo', 'version']
    .filter((field) => row[field] === null || row[field] === undefined || row[field] === '');

  const hasPublishedPrice = [
    row.precio_neto,
    row.precio_lista,
    row.precio_con_iva,
    row.precio_efectivo_pre_mes_sin_iva,
    row.precio_efectivo_pre_mes_con_iva,
    row.precio_efectivo_final_sin_iva,
    row.precio_efectivo_final_con_iva,
  ].some((value) => Number.isFinite(value));

  return {
    valid: missing.length === 0 && hasPublishedPrice,
    missing,
    has_published_price: hasPublishedPrice,
  };
}
