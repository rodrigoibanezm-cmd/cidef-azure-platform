// Deterministic equivalence of complete name tokens, never a partial-name search.
// Existing exact aliases/logins take precedence; callers must retain ambiguity
// counts and apply organizational eligibility separately.
const ACCENTS = 'ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ';
const FOLDED = 'AAAAAEEEEIIIIOOOOOUUUUNC';

export function personaNameKeySql(expression) {
  return `(SELECT string_agg(token, ' ' ORDER BY token COLLATE "C")
    FROM regexp_split_to_table(
      regexp_replace(translate(upper(${expression}), '${ACCENTS}', '${FOLDED}'), '[^[:alnum:]]+', ' ', 'g'), ' '
    ) AS tokens(token)
    WHERE token <> '' HAVING count(*) >= 2)`;
}

export const PERSONA_NAME_CANDIDATES_SQL = `
  SELECT a.valor_raw name, a.persona_id
  FROM persona_aliases a JOIN personas_master p ON p.persona_id=a.persona_id
  WHERE p.validated AND a.validated AND a.persona_id IS NOT NULL AND a.tipo_alias='nombre'
  UNION
  SELECT p.nombre_canonico, p.persona_id
  FROM personas_master p
  WHERE p.validated AND p.nombre_canonico IS NOT NULL
`;

// labelSource must be an internal SELECT returning a single name column.
export function personaSellerResolutionCtesSql(labelSource) {
  return `seller_candidates AS MATERIALIZED (
    SELECT master_norm(a.valor_raw) norm,a.persona_id FROM persona_aliases a JOIN personas_master p ON p.persona_id=a.persona_id WHERE p.validated AND a.validated AND a.persona_id IS NOT NULL
    UNION SELECT master_norm(p.nombre_canonico),p.persona_id FROM personas_master p WHERE p.validated AND p.nombre_canonico IS NOT NULL
    UNION SELECT master_norm(p.usuario_canonico),p.persona_id FROM personas_master p WHERE p.validated AND p.usuario_canonico IS NOT NULL
  ),
  seller_map AS MATERIALIZED (SELECT norm,min(persona_id) persona_id,count(DISTINCT persona_id)::int match_count FROM seller_candidates WHERE norm IS NOT NULL GROUP BY norm),
  seller_name_candidates AS MATERIALIZED (${PERSONA_NAME_CANDIDATES_SQL}),
  seller_name_map AS MATERIALIZED (
    SELECT ${personaNameKeySql('name')} name_key,min(persona_id) persona_id,
      count(DISTINCT persona_id)::int match_count
    FROM seller_name_candidates GROUP BY name_key
  ),
  seller_labels AS MATERIALIZED (
    SELECT DISTINCT master_norm(name) norm, ${personaNameKeySql('name')} name_key FROM (${labelSource}) labels
  ),
  seller_resolutions AS MATERIALIZED (
    SELECT labels.norm,coalesce(exact.persona_id,names.persona_id) persona_id,
      coalesce(exact.match_count,names.match_count) match_count
    FROM seller_labels labels
    LEFT JOIN seller_map exact ON exact.norm=labels.norm
    LEFT JOIN seller_name_map names ON exact.norm IS NULL AND names.name_key=labels.name_key
  )`;
}

