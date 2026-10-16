import { customGptDb } from '../custom-gpt/db.js';

export const PRODUCT_IDENTITY_SELECT = `
  SELECT
    alias_id, nivel, fuente, valor_raw, valor_normalizado,
    contexto_marca_raw, contexto_modelo_raw,
    marca_id, modelo_id, version_id, evidencia_tipo
  FROM producto_aliases_v01
  WHERE estado = 'RESUELTO'
    AND modelo_id IS NOT NULL
    AND lower(fuente) LIKE 'ventas_raw%'
    AND nivel IN ('MODELO', 'VERSION')
`;

export async function loadProductIdentityMap(sql = customGptDb()) {
  return sql.query(PRODUCT_IDENTITY_SELECT);
}
