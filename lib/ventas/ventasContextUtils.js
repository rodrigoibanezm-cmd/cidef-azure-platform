import { commercialMonthForDate } from './commercialMonth.js';

export function normalizedText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

export function normalizedVin(value) {
  return normalizedText(value);
}

export function stableId(value) {
  return value == null ? '' : String(value);
}

export function compareStableId(a, b) {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a).localeCompare(String(b));
}

function sourceIdentityKey(value) {
  return value == null ? null : String(value);
}

export function recognizedSale(row, parsed, recognitionBasis, vin) {
  return {
    vin,
    source_id: row.id ?? null,
    fecha_venta: parsed.raw,
    fecha_venta_iso: parsed.date.toISOString(),
    mes_venta: commercialMonthForDate(parsed.date),
    recognition_basis: recognitionBasis,
    cliente: normalizedText(row.cliente),
    categoria_cliente: normalizedText(row.categoria_cliente),
    razon_social: normalizedText(row.razon_social),
    sucursal_source_key: sourceIdentityKey(row.id_sucursal_vta),
    vendedor_source_key: sourceIdentityKey(row.nombre_usuario),
    sucursal_id: normalizedText(row.id_sucursal_vta),
    sucursal: normalizedText(row.desc_sucursal_vta),
    vendedor: normalizedText(row.nombre_usuario),
    marca_id: normalizedText(row.id_mae_marca),
    marca: normalizedText(row.desc_mae_marca),
    producto_sku: normalizedText(row.articulo),
    producto: normalizedText(row.desc_articulo),
    nro_operacion: normalizedText(row.nro_operacion),
    nro_propuesta: normalizedText(row.nro_propuesta),
    factura: normalizedText(row.factura),
    nro_factura: normalizedText(row.nro_factura),
    precio_vta: normalizedText(row.precio_vta),
    precio_vta_pesos_con_iva: normalizedText(row.precio_vta_pesos_con_iva),
  };
}

export function sortRecognizedSales(sales) {
  return sales.sort((a, b) => {
    const byDate = String(a.fecha_venta_iso).localeCompare(String(b.fecha_venta_iso));
    if (byDate !== 0) return byDate;
    const byVin = (a.vin ?? '').localeCompare(b.vin ?? '');
    if (byVin !== 0) return byVin;
    return compareStableId(a.source_id, b.source_id);
  });
}
