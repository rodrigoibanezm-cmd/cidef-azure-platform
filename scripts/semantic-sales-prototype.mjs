// Experimental semantic SALES reader. Independent of P1/P2/P3; NOT certified.
// Scope: candidate VINs for an exact brand/model/month and optional own store. Read-only PostgreSQL.
import { queryDb } from '../lib/neon.js';

export async function semanticSalesCandidates({
  store_id, dealer_id, model_id, brand_id, year, month, commercial_universe = 'OWN_STORES',
}) {
  if (!['OWN_STORES','DEALERS'].includes(commercial_universe)) throw new Error('INVALID_COMMERCIAL_UNIVERSE');
  if (commercial_universe === 'DEALERS' && store_id != null) throw new Error('DEALER_SCOPE_DOES_NOT_USE_STORE');
  if (commercial_universe !== 'DEALERS' && dealer_id != null) throw new Error('DEALER_ID_REQUIRES_DEALERS');
  for (const id of [model_id, brand_id, ...(store_id == null ? [] : [store_id]), ...(dealer_id == null ? [] : [dealer_id])]) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('INVALID_ID');
  }
  if (!Number.isSafeInteger(year) || year < 2020 || year > 2100 ||
      !Number.isSafeInteger(month) || month < 1 || month > 12)
    throw new Error('INVALID_PERIOD');
  const mm = String(month).padStart(2, '0');
  const yy = String(year).slice(-2);
  const datePattern = '^(' + year + '-' + mm + '-[0-9]{2}|[0-9]{1,2}/0?' +
    month + '/' + year + '|[0-9]{1,2}/0?' + month + '/' + yy + ')([[:space:]]|$)';
  const params=[datePattern,model_id,brand_id,
    commercial_universe==='DEALERS'?'Concesionaria':'Cliente General'];
  if(store_id!=null)params.push(store_id);
  if(dealer_id!=null)params.push(dealer_id);
  const sql = `
    SELECT DISTINCT btrim(v.nro_vin_chasis) AS vin
    FROM ventas_raw v
    WHERE btrim(v.categoria_cliente) = $4
      AND nullif(btrim(v.nro_vin_chasis),'') IS NOT NULL
      AND btrim(v.fecha_factura) ~ $1
      ${store_id != null ? `AND (EXISTS (
        SELECT 1 FROM sucursales_master s
        WHERE s.sucursal_id = $5
          AND btrim(s.id_sucursal_vta::text) = btrim(v.id_sucursal_vta::text)
      ) OR EXISTS (
        SELECT 1 FROM vehiculo_canonico vc
        WHERE vc.vin = v.nro_vin_chasis AND vc.sucursal_venta_id = $5
      ))` : ''}
      ${dealer_id != null ? `AND (EXISTS (
        SELECT 1 FROM dealers_master d
        WHERE d.dealer_id = $5
          AND d.rut_normalizado IS NOT NULL
          AND regexp_replace(v.cliente, '[^0-9]', '', 'g') =
              regexp_replace(d.rut_normalizado, '[^0-9]', '', 'g')
      ) OR EXISTS (
        SELECT 1 FROM vehiculo_canonico vc
        WHERE vc.vin = v.nro_vin_chasis AND vc.dealer_id = $5
      ))` : ''}
      AND (EXISTS (
        SELECT 1 FROM producto_aliases_v01 a
        JOIN modelos_master_v01 m ON m.modelo_id = a.modelo_id
        WHERE a.estado = 'RESUELTO' AND a.modelo_id = $2 AND m.marca_id = $3
          AND lower(a.fuente) LIKE 'ventas_raw%'
          AND a.nivel IN ('MODELO','VERSION')
          AND master_norm(v.articulo) = master_norm(a.valor_normalizado)
      ) OR EXISTS (
        SELECT 1 FROM vehiculo_canonico vc
        JOIN versiones_master_v01 ver ON ver.version_id = vc.version_id
        JOIN modelos_master_v01 m ON m.modelo_id = ver.modelo_id
        WHERE vc.vin = v.nro_vin_chasis
          AND m.modelo_id = $2 AND m.marca_id = $3
      ))
    ORDER BY vin`;
  const start = performance.now();
  const rows = await queryDb(sql, params);
  return { vins: rows.map(row => row.vin), count: rows.length,
    elapsed_ms: Math.round(performance.now() - start),
    status: 'CANDIDATES_ONLY_NOT_CERTIFIED' };
}

// Example: semanticSalesCandidates({store_id:4,model_id:28,brand_id:89,year:2026,month:8})
