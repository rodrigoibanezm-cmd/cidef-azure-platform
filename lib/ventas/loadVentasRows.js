import { customGptDb } from '../custom-gpt/db.js';

export const VENTAS_CONTEXT_SELECT = `
  SELECT
    id, nro_operacion, razon_social, cliente, articulo, desc_articulo,
    nro_vin_chasis, nombre_usuario, fecha_factura, precio_vta,
    precio_vta_pesos_con_iva, id_sucursal_vta, desc_sucursal_vta,
    id_mae_marca, desc_mae_marca, nro_propuesta, factura, nro_factura,
    categoria_cliente
  FROM ventas_raw
  WHERE btrim(categoria_cliente) IN ('Cliente General', 'Concesionaria')
`;

export async function loadVentasRows(sql = customGptDb()) {
  return sql.query(VENTAS_CONTEXT_SELECT);
}
