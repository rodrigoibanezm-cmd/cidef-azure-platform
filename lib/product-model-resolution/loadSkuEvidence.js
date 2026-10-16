import { customGptDb } from '../custom-gpt/db.js';

export async function loadSkuEvidence(sql = customGptDb()) {
  return sql.query(`
    WITH source_skus AS MATERIALIZED (
      SELECT DISTINCT master_norm(articulo) sku_norm, upper(trim(nro_vin_chasis)) vin_norm
      FROM ventas_raw
      WHERE master_norm(articulo) IS NOT NULL AND nullif(trim(nro_vin_chasis),'') IS NOT NULL
    ), source_values AS MATERIALIZED (
      SELECT master_norm(articulo) sku_norm, min(trim(articulo)) sku_raw,
        min(trim(desc_articulo)) desc_articulo, min(trim(desc_mae_marca)) marca_raw,
        count(*)::bigint raw_rows, count(DISTINCT master_norm(desc_articulo))::bigint distinct_descriptions,
        count(DISTINCT master_norm(desc_mae_marca))::bigint distinct_brands
      FROM ventas_raw WHERE master_norm(articulo) IS NOT NULL GROUP BY master_norm(articulo)
    ), cidef_model_candidates AS MATERIALIZED (
      SELECT s.sku_norm,m.modelo_id,length(m.nombre_normalizado) model_name_length,
        dense_rank() OVER (PARTITION BY s.sku_norm ORDER BY length(m.nombre_normalizado) DESC) specificity_rank
      FROM source_values s
      JOIN marcas_master_v01 ma ON (
        ma.nombre_normalizado=master_norm(s.marca_raw)
        OR (master_norm(s.marca_raw)='DFM' AND ma.nombre_normalizado='DONGFENG')
        OR (master_norm(s.marca_raw)='ZNA DONGFENG' AND ma.nombre_normalizado='ZNA')
      )
      JOIN modelos_master_v01 m ON m.marca_id=ma.marca_id
      WHERE s.sku_norm=m.nombre_normalizado
         OR s.sku_norm LIKE m.nombre_normalizado||' %'
         OR s.sku_norm LIKE '% '||m.nombre_normalizado||' %'
         OR s.sku_norm LIKE '% '||m.nombre_normalizado
    ), cidef_model_by_sku AS MATERIALIZED (
      SELECT sku_norm,min(modelo_id) modelo_id
      FROM cidef_model_candidates
      WHERE specificity_rank=1
      GROUP BY sku_norm
      HAVING count(DISTINCT modelo_id)=1
    ), cidef_version_candidates AS MATERIALIZED (
      SELECT s.sku_norm,v.version_id,v.modelo_id,
        CASE WHEN s.sku_norm=v.nombre_normalizado THEN 1
          WHEN s.sku_norm LIKE v.nombre_normalizado||' %' THEN 2
          WHEN v.nombre_normalizado LIKE s.sku_norm||' %' THEN 3 ELSE 9 END match_rank,
        abs(length(s.sku_norm)-length(v.nombre_normalizado)) distance
      FROM source_values s
      JOIN marcas_master_v01 ma ON (
        ma.nombre_normalizado=master_norm(s.marca_raw)
        OR (master_norm(s.marca_raw)='DFM' AND ma.nombre_normalizado='DONGFENG')
        OR (master_norm(s.marca_raw)='ZNA DONGFENG' AND ma.nombre_normalizado='ZNA')
      )
      JOIN modelos_master_v01 m ON m.marca_id=ma.marca_id
      JOIN versiones_master_v01 v ON v.modelo_id=m.modelo_id
      WHERE s.sku_norm=v.nombre_normalizado
         OR s.sku_norm LIKE v.nombre_normalizado||' %'
         OR v.nombre_normalizado LIKE s.sku_norm||' %'
    ), cidef_version_ranked AS MATERIALIZED (
      SELECT *,dense_rank() OVER (PARTITION BY sku_norm ORDER BY match_rank,distance) version_rank
      FROM cidef_version_candidates
    ), cidef_version_by_sku AS MATERIALIZED (
      SELECT sku_norm,min(version_id) version_id,min(modelo_id) modelo_id
      FROM cidef_version_ranked WHERE version_rank=1
      GROUP BY sku_norm HAVING count(DISTINCT version_id)=1
    ), canonical_by_vin AS MATERIALIZED (
      SELECT s.sku_norm,s.vin_norm,v.modelo_id,v.version_id
      FROM source_skus s JOIN vehiculo_canonico vc ON upper(trim(vc.vin))=s.vin_norm
      JOIN versiones_master_v01 v ON v.version_id=vc.version_id WHERE vc.version_id IS NOT NULL
    ), effective AS MATERIALIZED (
      SELECT s.sku_norm,s.vin_norm,coalesce(d.modelo_id,c.modelo_id) modelo_id,
        coalesce(dv.version_id,c.version_id) version_id,
        CASE WHEN d.modelo_id IS NOT NULL THEN 'CIDEF_SALES_SKU'
          WHEN c.modelo_id IS NOT NULL THEN 'VEHICULO_CANONICO' ELSE 'NO_EVIDENCE' END method,
        CASE WHEN d.modelo_id IS NOT NULL AND c.modelo_id IS NOT NULL AND d.modelo_id<>c.modelo_id THEN 1 ELSE 0 END source_conflict
      FROM source_skus s
      LEFT JOIN cidef_model_by_sku d ON d.sku_norm=s.sku_norm
      LEFT JOIN cidef_version_by_sku dv ON dv.sku_norm=s.sku_norm AND dv.modelo_id=coalesce(d.modelo_id,dv.modelo_id)
      LEFT JOIN canonical_by_vin c ON c.sku_norm=s.sku_norm AND c.vin_norm=s.vin_norm
    ), per_sku AS (
      SELECT sku_norm,count(DISTINCT modelo_id) FILTER(WHERE modelo_id IS NOT NULL)::bigint distinct_model_ids,
        min(modelo_id) FILTER(WHERE modelo_id IS NOT NULL) modelo_id,
        count(DISTINCT version_id) FILTER(WHERE version_id IS NOT NULL)::bigint distinct_version_ids,
        min(version_id) FILTER(WHERE version_id IS NOT NULL) version_id,
        array_agg(DISTINCT modelo_id ORDER BY modelo_id) FILTER(WHERE modelo_id IS NOT NULL) candidate_model_ids,
        count(*)::bigint observed_vins,
        count(*) FILTER(WHERE method='VEHICULO_CANONICO')::bigint canonical_vins,
        count(*) FILTER(WHERE method='CIDEF_SALES_SKU')::bigint sales_sku_vins,
        count(*) FILTER(WHERE method='NO_EVIDENCE')::bigint no_evidence_vins,
        sum(source_conflict)::bigint source_conflict_vins
      FROM effective GROUP BY sku_norm
    )
    SELECT s.*,coalesce(p.distinct_model_ids,0) distinct_model_ids,p.modelo_id,
      coalesce(p.candidate_model_ids, ARRAY[]::bigint[]) candidate_model_ids,
      coalesce(p.distinct_version_ids,0) distinct_version_ids,p.version_id,
      coalesce(p.observed_vins,0) observed_vins,coalesce(p.canonical_vins,0) canonical_vins,
      coalesce(p.sales_sku_vins,0) sales_sku_vins,0::bigint ambiguous_vins,
      coalesce(p.no_evidence_vins,0) no_evidence_vins,coalesce(p.source_conflict_vins,0) source_conflict_vins
    FROM source_values s LEFT JOIN per_sku p USING(sku_norm) ORDER BY s.sku_norm
  `);
}
