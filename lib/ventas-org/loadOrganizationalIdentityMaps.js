import { customGptDb } from '../custom-gpt/db.js';
import { toVendedorCidefLookup } from './vendedorCidef.js';
import { VENDEDOR_CIDEF_INTERVALS_SQL } from './vendedorCidefSql.js';

const STORE_SQL = `
SELECT id_sucursal_vta::text AS source_key,
       MIN(sucursal_id) AS sucursal_id,
       MIN(nombre_canonico) AS nombre_canonico,
       MIN(tipo_canal) AS tipo_canal,
       MIN(dealer_id) AS dealer_id,
       MIN(dealer_group_id) AS dealer_group_id,
       COUNT(*)::int AS match_count
FROM sucursales_master
GROUP BY id_sucursal_vta;
`;

const SELLER_SQL = `
SELECT usuario_canonico::text AS source_key,
       MIN(persona_id) AS persona_id,
       MIN(nombre_canonico) AS nombre_canonico,
       BOOL_AND(validated) AS validated,
       COUNT(*)::int AS match_count
FROM personas_master
GROUP BY usuario_canonico;
`;

const DEALER_SQL = `
SELECT d.dealer_id, d.razon_social_canonica, d.nombre_comercial,
       d.dealer_group_id, g.nombre_canonico AS dealer_group_nombre
FROM dealers_master d
LEFT JOIN dealer_groups g ON g.dealer_group_id = d.dealer_group_id
`;

// Role and assignment remain separate in MASTER. This query only returns their
// overlap for CIDEF stores; ventas_raw is never used to create membership.
function toLookup(rows, idField) {
  return new Map(rows.map((row) => [
    String(row.source_key),
    {
      canonical_id: row[idField],
      nombre_canonico: row.nombre_canonico ?? null,
      tipo_canal: row.tipo_canal ?? null,
      dealer_id: row.dealer_id ?? null,
      dealer_group_id: row.dealer_group_id ?? null,
      validated: row.validated ?? null,
      match_count: Number(row.match_count ?? 0),
    },
  ]));
}

export async function loadOrganizationalIdentityMaps(sql = customGptDb()) {
  const [stores, sellers, vendedorCidef, dealers] = await Promise.all([
    sql.query(STORE_SQL),
    sql.query(SELLER_SQL),
    sql.query(VENDEDOR_CIDEF_INTERVALS_SQL),
    sql.query(DEALER_SQL),
  ]);

  return {
    stores: toLookup(stores, 'sucursal_id'),
    sellers: toLookup(sellers, 'persona_id'),
    vendedorCidef: toVendedorCidefLookup(vendedorCidef),
    dealers: new Map(dealers.map((row) => [String(row.dealer_id), {
      dealer_id: row.dealer_id,
      nombre_canonico: row.nombre_comercial || row.razon_social_canonica || null,
      dealer_group_id: row.dealer_group_id ?? null,
      dealer_group_nombre: row.dealer_group_nombre ?? null,
    }])),
  };
}
