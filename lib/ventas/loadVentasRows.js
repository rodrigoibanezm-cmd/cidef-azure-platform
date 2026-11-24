import { customGptDb } from '../custom-gpt/db.js';

export const VENTAS_CONTEXT_SELECT = `
  SELECT
    id, nro_operacion, razon_social, cliente, articulo, desc_articulo,
    nro_vin_chasis, nombre_usuario, fecha_factura, precio_vta,
    precio_vta_pesos_con_iva, id_sucursal_vta, desc_sucursal_vta,
    id_mae_marca, desc_mae_marca, nro_propuesta, factura, nro_factura,
    categoria_cliente, entidad_financiera
  FROM ventas_raw
  WHERE btrim(categoria_cliente) IN ('Cliente General', 'Concesionaria')
    -- Temporary exclusion: cancelled invoice 78898, replaced by invoice 79079 on another VIN.
    -- Remove after SALES source refresh confirms cancellation.
    AND NOT (btrim(nro_vin_chasis) IS NOT DISTINCT FROM 'LVAV2AVB8TE322187'
      AND (btrim(nro_factura::text) IS NOT DISTINCT FROM '78898' OR btrim(factura::text) IS NOT DISTINCT FROM '78898'))
`;

export async function loadVentasRows(sql = customGptDb(), candidateVins = null) {
  if (candidateVins == null) return sql.query(VENTAS_CONTEXT_SELECT);
  if (!Array.isArray(candidateVins) || candidateVins.some(vin => typeof vin !== 'string'))
    throw new Error('INVALID_SALES_CANDIDATE_VINS');
  if (candidateVins.length === 0) return [];
  // Load every historical row for each candidate VIN; recognition still applies the cutoff.
  return sql.query(`${VENTAS_CONTEXT_SELECT} AND btrim(nro_vin_chasis) = ANY($1::text[])`, [candidateVins]);
}
