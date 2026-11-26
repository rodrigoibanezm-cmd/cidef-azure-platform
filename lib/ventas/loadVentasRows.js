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
    -- Current available stock in the daily vehicle XLS supersedes a stale sale.
    -- No invoice/dated sale, active and unreserved is the source authority.
    AND NOT EXISTS (
      SELECT 1 FROM vehiculos_raw stock
      WHERE upper(btrim(stock.vin_chasis)) = upper(btrim(ventas_raw.nro_vin_chasis))
        AND btrim(stock.vigente) = '1'
        AND btrim(coalesce(stock.esta_reservado, '')) = '0'
        AND nullif(btrim(stock.numero_factura), '') IS NULL
        AND nullif(btrim(stock.fecha_factura::text), '') IS NULL
    )
`;

export async function loadVentasRows(sql = customGptDb(), candidateVins = null) {
  if (candidateVins == null) return sql.query(VENTAS_CONTEXT_SELECT);
  if (!Array.isArray(candidateVins) || candidateVins.some(vin => typeof vin !== 'string'))
    throw new Error('INVALID_SALES_CANDIDATE_VINS');
  // P1 recognizes rows without VIN individually. They are never represented
  // in a VIN candidate list, so retain all of them for every scoped run.
  return sql.query(`${VENTAS_CONTEXT_SELECT} AND (btrim(nro_vin_chasis) = ANY($1::text[]) OR nullif(btrim(nro_vin_chasis),'') IS NULL)`, [candidateVins]);
}
