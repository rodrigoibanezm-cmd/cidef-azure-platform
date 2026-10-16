import { customGptDb } from '../custom-gpt/db.js';
import { VENDEDOR_CIDEF_INTERVALS_SQL } from '../ventas-org/vendedorCidefSql.js';
import { personaSellerResolutionCtesSql } from '../master/personaNameIdentity.js';

export const UNIVERSE_NAME = 'crm_universe_v01';
export const UNIVERSE_VERSION = '0.1';

const AXIS_COLUMN = Object.freeze({
  CREATED_AT: '"Creado el"',
  ASSIGNED_AT: '"Asignado el"',
  MANAGED_AT: '"Gestionado el"',
  DESISTED_AT: '"Desistido el"',
});

function dateExpression(column) {
  return `CASE
    WHEN nullif(trim(${column}),'') IS NULL THEN NULL
    WHEN trim(${column}) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN to_date(substring(trim(${column}) from 1 for 10),'YYYY-MM-DD')
    WHEN trim(${column}) ~ '^\\d{2}/\\d{2}/\\d{4}' THEN to_date(substring(trim(${column}) from 1 for 10),'DD/MM/YYYY')
    WHEN trim(${column}) ~ '^\\d{2}-\\d{2}-\\d{4}' THEN to_date(substring(trim(${column}) from 1 for 10),'DD-MM-YYYY')
    ELSE NULL END`;
}

function loadedAtExpression(column) {
  return `CASE
    WHEN nullif(trim(${column}),'') IS NULL THEN NULL
    WHEN trim(${column}) ~ '^\\d{4}-\\d{2}-\\d{2}[T ]' THEN trim(${column})::timestamptz
    ELSE NULL END`;
}

function state(rawNorm, matchCount, resolvedValue) {
  if (rawNorm == null) return 'NOT_APPLICABLE';
  if (Number(matchCount || 0) > 1) return 'AMBIGUOUS';
  return resolvedValue == null ? 'UNRESOLVED' : 'RESOLVED';
}

function countStates(events, field) {
  const counts = { RESOLVED: 0, UNRESOLVED: 0, AMBIGUOUS: 0, NOT_APPLICABLE: 0 };
  for (const row of events) counts[row[field]] = (counts[row[field]] || 0) + 1;
  return { ...counts, total: events.length };
}

function availability(events, field) {
  const nonNullValues = events.map((row) => row[field]).filter((value) => value != null && String(value).trim() !== '');
  return { non_null: nonNullValues.length, null: events.length - nonNullValues.length, distinct: new Set(nonNullValues).size };
}

function inCommercialUniverse(row, commercialUniverse) {
  return commercialUniverse !== 'OWN_STORES' || (row.store_resolution_status === 'RESOLVED' && row.tipo_canal === 'CIDEF');
}

export function buildCrmUniverseQuery({ eligibilityDateAxis = 'CREATED_AT' } = {}) {
  const axis = AXIS_COLUMN[eligibilityDateAxis];
  if (!axis) throw new Error(`INVALID_CRM_UNIVERSE_DATE_AXIS: ${eligibilityDateAxis}`);
  const vendedor = VENDEDOR_CIDEF_INTERVALS_SQL.trim().replace(/;$/, '');
  return `WITH source AS MATERIALIZED (
    SELECT c.*, count(*) OVER()::bigint source_rows,
      row_number() OVER (
        PARTITION BY coalesce(nullif(trim("ID"),''),ctid::text)
        ORDER BY ${loadedAtExpression('"loaded_at"')} DESC NULLS LAST, ctid DESC
      ) rn
    FROM "CRM_Cidef_raw" c
  ),
  product_candidates AS MATERIALIZED (
    SELECT master_norm(m.nombre_canonico) norm,m.modelo_id,ma.marca_id,ma.nombre_canonico brand,m.nombre_canonico model FROM modelos_master_v01 m JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id
    UNION SELECT master_norm(concat_ws(' ',ma.nombre_canonico,m.nombre_canonico)),m.modelo_id,ma.marca_id,ma.nombre_canonico,m.nombre_canonico FROM modelos_master_v01 m JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id
    UNION SELECT master_norm(v.nombre_canonico),m.modelo_id,ma.marca_id,ma.nombre_canonico,m.nombre_canonico FROM versiones_master_v01 v JOIN modelos_master_v01 m ON m.modelo_id=v.modelo_id JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id
    UNION SELECT master_norm(concat_ws(' ',ma.nombre_canonico,v.nombre_canonico)),m.modelo_id,ma.marca_id,ma.nombre_canonico,m.nombre_canonico FROM versiones_master_v01 v JOIN modelos_master_v01 m ON m.modelo_id=v.modelo_id JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id
    UNION SELECT master_norm(concat_ws(' ',m.nombre_canonico,v.nombre_canonico)),m.modelo_id,ma.marca_id,ma.nombre_canonico,m.nombre_canonico FROM versiones_master_v01 v JOIN modelos_master_v01 m ON m.modelo_id=v.modelo_id JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id
    UNION SELECT master_norm(concat_ws(' ',ma.nombre_canonico,m.nombre_canonico,v.nombre_canonico)),m.modelo_id,ma.marca_id,ma.nombre_canonico,m.nombre_canonico FROM versiones_master_v01 v JOIN modelos_master_v01 m ON m.modelo_id=v.modelo_id JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id
    UNION SELECT a.valor_normalizado,coalesce(a.modelo_id,v.modelo_id),ma.marca_id,ma.nombre_canonico,m.nombre_canonico FROM producto_aliases_v01 a LEFT JOIN versiones_master_v01 v ON v.version_id=a.version_id JOIN modelos_master_v01 m ON m.modelo_id=coalesce(a.modelo_id,v.modelo_id) JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id WHERE a.estado='RESUELTO' AND a.nivel IN ('MODELO','VERSION')
    UNION SELECT master_norm(concat_ws(' ',ma.nombre_canonico,a.valor_raw)),coalesce(a.modelo_id,v.modelo_id),ma.marca_id,ma.nombre_canonico,m.nombre_canonico FROM producto_aliases_v01 a LEFT JOIN versiones_master_v01 v ON v.version_id=a.version_id JOIN modelos_master_v01 m ON m.modelo_id=coalesce(a.modelo_id,v.modelo_id) JOIN marcas_master_v01 ma ON ma.marca_id=m.marca_id WHERE a.estado='RESUELTO' AND a.nivel IN ('MODELO','VERSION')
  ),
  product_map AS MATERIALIZED (
    SELECT norm,min(modelo_id) modelo_id,min(marca_id) marca_id,min(brand) brand,min(model) model,
      count(DISTINCT modelo_id)::int model_match_count,count(DISTINCT marca_id)::int brand_match_count
    FROM product_candidates WHERE norm IS NOT NULL GROUP BY norm
  ),
  store_candidates AS MATERIALIZED (
    SELECT master_norm(a.valor_raw) norm,a.sucursal_id FROM sucursal_aliases a WHERE a.validated AND a.sucursal_id IS NOT NULL
    UNION SELECT master_norm(s.nombre_canonico),s.sucursal_id FROM sucursales_master s
  ),
  store_map AS MATERIALIZED (SELECT norm,min(sucursal_id) sucursal_id,count(DISTINCT sucursal_id)::int match_count FROM store_candidates WHERE norm IS NOT NULL GROUP BY norm),
  ${personaSellerResolutionCtesSql('SELECT "Asignado a" name FROM source')},
  vendedor_cidef AS MATERIALIZED (${vendedor}),
  prepared AS MATERIALIZED (
    SELECT d.*,
      ${dateExpression('"Creado el"')} created_date,
      ${dateExpression('"Asignado el"')} assigned_date,
      ${dateExpression('"Gestionado el"')} managed_date,
      ${dateExpression('"Desistido el"')} desist_date,
      ${dateExpression(axis)} eligibility_date,
      master_norm("Producto de interes") product_interest_norm,
      master_norm("Origen") origin_norm, master_norm("Suborigen") suborigin_norm,
      master_norm("Sucursal Asignada") store_raw_norm, master_norm("Asignado a") seller_raw_norm,
      master_norm("Estado") status_norm, master_norm("Vendido") sold_norm,
      master_norm("Grado de Interes") interest_level_norm, master_norm("Motivo desistido") desist_reason_norm
    FROM source d
  )
  SELECT
    p."ID"::text lead_id, to_jsonb(p)->>'source_file' source_file, p."loaded_at"::text loaded_at,
    p.source_rows,p.rn,
    to_char(p.created_date,'YYYY-MM-DD') created_date, to_char(p.assigned_date,'YYYY-MM-DD') assigned_date,
    to_char(p.managed_date,'YYYY-MM-DD') managed_date, to_char(p.desist_date,'YYYY-MM-DD') desist_date,
    to_char(p.eligibility_date,'YYYY-MM-DD') eligibility_date,
    p."Creado el" created_raw, p."Asignado el" assigned_raw, p."Gestionado el" managed_raw, p."Desistido el" desist_raw,
    p."Estado" estado_raw,p.status_norm,p."Vendido" vendido_raw,p.sold_norm,
    p."Grado de Interes" interest_level,p.interest_level_norm,p."Motivo desistido" desist_reason,p.desist_reason_norm,
    p."Origen" origin_raw,p.origin_norm,p."Suborigen" suborigin_raw,p.suborigin_norm,
    p."Producto de interes" product_interest_raw,p.product_interest_norm,
    pm.brand_match_count,pm.model_match_count,
    CASE WHEN pm.brand_match_count=1 THEN pm.marca_id END brand_id,
    CASE WHEN pm.brand_match_count=1 THEN pm.brand END brand,
    CASE WHEN pm.model_match_count=1 THEN pm.modelo_id END model_id,
    CASE WHEN pm.model_match_count=1 THEN pm.model END model,
    p."Sucursal Asignada" store_raw,p.store_raw_norm,sm.match_count store_match_count,
    CASE WHEN sm.match_count=1 THEN sm.sucursal_id END sucursal_id,
    CASE WHEN sm.match_count=1 THEN ss.nombre_canonico END sucursal_nombre,
    CASE WHEN sm.match_count=1 THEN ss.tipo_canal END tipo_canal,
    p."Asignado a" seller_raw,p.seller_raw_norm,pe.match_count seller_match_count,
    CASE WHEN pe.match_count=1 THEN pe.persona_id END persona_id,
    CASE WHEN pe.match_count=1 THEN pp.nombre_canonico END persona_nombre,
    CASE WHEN sm.match_count=1 AND pe.match_count=1 AND ss.tipo_canal='CIDEF' AND EXISTS (
      SELECT 1 FROM weekly_projection_sellers wps
      WHERE wps.persona_id=pe.persona_id AND wps.sucursal_id=sm.sucursal_id
        AND wps.habilitado=true
    ) THEN true ELSE false END current_roster_member,
    CASE WHEN sm.match_count=1 AND pe.match_count=1 AND ss.tipo_canal='CIDEF' AND EXISTS (
      SELECT 1 FROM vendedor_cidef vc WHERE vc.persona_id=pe.persona_id AND vc.sucursal_id=sm.sucursal_id
        AND p.eligibility_date BETWEEN coalesce(vc.valid_from,'-infinity'::date) AND coalesce(vc.valid_to,'infinity'::date)
        AND (vc.vigente OR vc.valid_from IS NOT NULL OR vc.valid_to IS NOT NULL)
    ) THEN true ELSE false END eligible_vendedor_cidef
  FROM prepared p
  LEFT JOIN product_map pm ON pm.norm=p.product_interest_norm
  LEFT JOIN store_map sm ON sm.norm=p.store_raw_norm
  LEFT JOIN sucursales_master ss ON ss.sucursal_id=sm.sucursal_id AND sm.match_count=1
  LEFT JOIN seller_resolutions pe ON pe.norm=p.seller_raw_norm
  LEFT JOIN personas_master pp ON pp.persona_id=pe.persona_id AND pe.match_count=1`;
}

export function assembleCrmUniverse(rows, input = {}) {
  const commercialUniverse = String(input.commercial_universe || input.universe || 'COMPANY').toUpperCase();
  if (!['COMPANY', 'OWN_STORES'].includes(commercialUniverse)) throw new Error(`UNSUPPORTED_CRM_UNIVERSE: ${commercialUniverse}`);
  const allVersions = rows.map((row) => {
    const productIdentityStatus = state(row.product_interest_norm, row.model_match_count, row.model_id);
    const storeResolutionStatus = state(row.store_raw_norm, row.store_match_count, row.sucursal_id);
    const sellerResolutionStatus = state(row.seller_raw_norm, row.seller_match_count, row.persona_id);
    return { ...row, product_identity_status: productIdentityStatus, store_resolution_status: storeResolutionStatus, seller_resolution_status: sellerResolutionStatus };
  });
  const all = allVersions.filter((row) => Number(row.rn) === 1);
  const events = all.filter((row) => inCommercialUniverse(row, commercialUniverse));
  const historicalStates = allVersions.filter((row) => inCommercialUniverse(row, commercialUniverse));
  const sourceRows = Number(rows[0]?.source_rows || 0);
  const deduplicated = all.length;
  const duplicateIdsRemoved = Math.max(0, sourceRows - deduplicated);
  const historicalExtraVersions = Math.max(0, allVersions.length - deduplicated);
  const idsWithHistory = new Set(allVersions.filter((row) => Number(row.rn) > 1).map((row) => row.lead_id)).size;
  const coverage = {
    deduplication: { source_rows: sourceRows, deduplicated_leads: deduplicated, duplicate_ids_removed: duplicateIdsRemoved },
    historical_states: { source_versions: allVersions.length, current_states: deduplicated, historical_extra_versions: historicalExtraVersions, ids_with_history: idsWithHistory, included_states: historicalStates.length },
    dates: Object.fromEntries(['created_date','assigned_date','managed_date','desist_date'].map((field) => [field, {
      parsed: all.filter((row) => row[field] != null).length,
      missing_or_invalid: all.filter((row) => row[field] == null).length,
      total: all.length,
    }])),
    product_identity: countStates(all, 'product_identity_status'),
    store_identity: countStates(all, 'store_resolution_status'),
    seller_identity: countStates(all, 'seller_resolution_status'),
    vendedor_cidef: { eligible: all.filter((row) => row.eligible_vendedor_cidef === true).length, not_eligible: all.filter((row) => row.eligible_vendedor_cidef !== true).length, total: all.length },
    current_roster: { in_roster: all.filter((row) => row.current_roster_member === true).length, outside_roster: all.filter((row) => row.current_roster_member !== true).length, total: all.length },
    commercial_universe: {
      company_events: all.length,
      own_store_events: all.filter((row) => row.store_resolution_status === 'RESOLVED' && row.tipo_canal === 'CIDEF').length,
      resolved_other_universe: all.filter((row) => row.store_resolution_status === 'RESOLVED' && row.tipo_canal !== 'CIDEF').length,
      unresolved: all.filter((row) => row.store_resolution_status === 'UNRESOLVED').length,
      ambiguous: all.filter((row) => row.store_resolution_status === 'AMBIGUOUS').length,
      not_applicable: all.filter((row) => row.store_resolution_status === 'NOT_APPLICABLE').length,
      included_events: events.length,
    },
    origin: availability(all, 'origin_raw'), suborigin: availability(all, 'suborigin_raw'),
  };
  const reconcile = (counts) => ['RESOLVED','UNRESOLVED','AMBIGUOUS','NOT_APPLICABLE'].reduce((sum, key) => sum + Number(counts[key] || 0), 0) === all.length;
  const currentIds = all.map((row) => row.lead_id).filter((value) => value != null && String(value).trim() !== '');
  const validation = {
    source_rows: sourceRows, deduplicated_leads: deduplicated, duplicate_ids_removed: duplicateIdsRemoved,
    analytical_events_count: events.length, historical_states_count: historicalStates.length,
    company_reconciles: deduplicated === all.length,
    current_state_unique_ids: new Set(currentIds).size === currentIds.length,
    history_reconciles: allVersions.length === sourceRows,
    own_stores_subset: coverage.commercial_universe.own_store_events <= all.length,
    own_stores_membership_valid: all.filter((row) => row.store_resolution_status === 'RESOLVED' && row.tipo_canal === 'CIDEF').every((row) => row.tipo_canal === 'CIDEF'),
    product_identity_reconciles: reconcile(coverage.product_identity),
    store_identity_reconciles: reconcile(coverage.store_identity),
    seller_identity_reconciles: reconcile(coverage.seller_identity),
  };
  validation.valid = Object.entries(validation).filter(([,value]) => typeof value === 'boolean').every(([,value]) => value);
  return {
    universe: UNIVERSE_NAME, version: UNIVERSE_VERSION, commercial_universe: commercialUniverse,
    period: { requested_date_from: input.date_from ?? null, requested_date_to: input.date_to ?? null, cutoff_date: input.cutoff_date ?? null, last_observed_date: null },
    analytical_events: events,
    current_state: events,
    historical_states: historicalStates,
    coverage, validation,
    warnings: ['CRM_HISTORICAL_STATE_COVERAGE_STARTS_WITH_VERSIONED_IMPORTS', ...(commercialUniverse === 'OWN_STORES' ? ['OWN_STORES_REQUIRES_RESOLVED_CIDEF_STORE'] : [])],
    lineage: {
      source: 'CRM_Cidef_raw',
      deduplication: 'latest loaded row per non-empty CRM ID ordered by loaded_at timestamptz; stable ctid tie-break',
      historical_states: 'all observed CRM_Cidef_raw versions prepared with the same certified product/store/seller/commercial semantics as current_state',
      product_identity: 'producto_aliases_v01 + versiones_master_v01 + modelos_master_v01 + marcas_master_v01',
      store_identity: 'sucursal_aliases + sucursales_master', seller_identity: 'persona_aliases + personas_master; exact alias/name/login first, then validated complete-name token equivalence (accents, separators and order); multi-persona matches remain ambiguous',
      vendedor_cidef: 'persona_roles + persona_sucursal through existing VENDEDOR_CIDEF interval authority',
      current_roster: 'weekly_projection_sellers: habilitado=true, persona_id + sucursal_id; includes temporary leave',
      origin_suborigin: 'observed RAW + master_norm only',
    },
  };
}

export async function buildCrmUniverse(input = {}, options = {}) {
  const sql = options.sql || customGptDb();
  const eligibilityDateAxis = input.eligibility_date_axis || input.date_axis || 'CREATED_AT';
  const rows = await sql.query(buildCrmUniverseQuery({ eligibilityDateAxis }));
  return assembleCrmUniverse(rows, input);
}

export async function buildCrmUniverses(input = {}, universes = ['COMPANY'], options = {}) {
  const sql = options.sql || customGptDb();
  const rows = await sql.query(buildCrmUniverseQuery({ eligibilityDateAxis: input.eligibility_date_axis || input.date_axis || 'CREATED_AT' }));
  return new Map(universes.map((universe) => [universe, assembleCrmUniverse(rows, { ...input, commercial_universe: universe })]));
}
