export const VENDEDOR_CIDEF_INTERVALS_SQL = `
SELECT ps.persona_id,
       ps.sucursal_id,
       GREATEST(r.valid_from, ps.valid_from) AS valid_from,
       LEAST(r.valid_to, ps.valid_to) AS valid_to,
       (r.vigente AND ps.vigente) AS vigente
FROM persona_roles r
JOIN persona_sucursal ps
  ON ps.persona_id = r.persona_id
 AND ps.rol = 'VENDEDOR_TIENDA'
JOIN sucursales_master s ON s.sucursal_id = ps.sucursal_id
WHERE r.rol = 'VENDEDOR_TIENDA'
  AND s.tipo_canal = 'CIDEF'
  AND COALESCE(r.valid_from, '-infinity'::date) <= COALESCE(ps.valid_to, 'infinity'::date)
  AND COALESCE(ps.valid_from, '-infinity'::date) <= COALESCE(r.valid_to, 'infinity'::date)
`;
