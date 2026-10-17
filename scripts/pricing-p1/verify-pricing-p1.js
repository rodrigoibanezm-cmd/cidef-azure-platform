import { closeAzurePool, azureQuery } from '../../lib/azure-postgres.js';
import { pricingHistoryV01 } from '../../lib/motors/pricing-history-v01.js';

const rows = await azureQuery(`
  WITH semantic_rows AS (
    SELECT ma.nombre_canonico AS brand, mo.nombre_canonico AS model, v.nombre_canonico AS version,
           e.vigencia_desde, e.commercial_condition_id,
           jsonb_build_array(
             ma.nombre_canonico, mo.nombre_canonico, v.nombre_canonico,
             e.vigencia_desde, e.vigencia_hasta, e.precio_neto, e.precio_lista, e.precio_con_iva,
             e.bono_cidef, e.bono_forum, e.bono_mes,
             e.precio_efectivo_pre_mes_sin_iva, e.precio_efectivo_pre_mes_con_iva,
             e.precio_efectivo_final_sin_iva, e.precio_efectivo_final_con_iva,
             e.delta_precio_neto, e.delta_precio_lista, e.delta_precio_con_iva,
             e.delta_bono_cidef, e.delta_bono_forum, e.delta_bono_mes,
             e.delta_precio_efectivo_pre_mes_sin_iva, e.delta_precio_efectivo_pre_mes_con_iva,
             e.delta_precio_efectivo_final_sin_iva, e.delta_precio_efectivo_final_con_iva,
             e.tipo_cambio, e.source_status, e.source_rows, e.source_variant_count,
             e.source_files, e.quality_flags, e.vin_facturados_en_vigencia,
             e.primer_vin_fecha, e.ultimo_vin_fecha
           )::text AS semantic
    FROM public.price_episode_canonico_v01 e
    JOIN public.versiones_master_v01 v ON v.version_id=e.version_id
    JOIN public.modelos_master_v01 mo ON mo.modelo_id=v.modelo_id
    JOIN public.marcas_master_v01 ma ON ma.marca_id=mo.marca_id
  ), overall AS (
    SELECT count(*)::bigint AS episodes,
           count(*) FILTER (WHERE semantic LIKE '%SOURCE_CONFLICT%')::bigint AS ignored_conflict_count,
           md5(string_agg(semantic, E'\\n' ORDER BY brand,model,version,vigencia_desde,commercial_condition_id)) AS semantic_md5
    FROM semantic_rows
  ), totals AS (
    SELECT count(*) FILTER (WHERE source_status='OK')::bigint AS episodes_clean,
           count(*) FILTER (WHERE source_status='SOURCE_CONFLICT')::bigint AS source_conflicts,
           COALESCE(sum(vin_facturados_en_vigencia),0)::bigint AS vin_assigned
    FROM public.price_episode_canonico_v01
  ), dongfeng AS (
    SELECT sr.model, sr.version, count(*)::bigint AS episodes,
           md5(string_agg(sr.semantic, E'\\n' ORDER BY sr.vigencia_desde,sr.commercial_condition_id)) AS semantic_md5
    FROM semantic_rows sr
    WHERE upper(sr.brand)='DONGFENG' AND regexp_replace(upper(sr.model),'[^A-Z0-9]','','g') IN ('007','008')
    GROUP BY sr.model,sr.version
  )
  SELECT jsonb_build_object(
    'episodes_total', overall.episodes,
    'episodes_clean', totals.episodes_clean,
    'source_conflicts', totals.source_conflicts,
    'vin_assigned', totals.vin_assigned,
    'semantic_md5', overall.semantic_md5,
    'dongfeng_007_008', COALESCE((SELECT jsonb_agg(to_jsonb(dongfeng) ORDER BY model,version) FROM dongfeng),'[]'::jsonb)
  ) AS result
  FROM overall CROSS JOIN totals
`);
const productChecks = [];
for (const [model, version] of [['007', '007 Automática'], ['008', '008 Automática']]) {
  const result = await pricingHistoryV01({ brand: 'DONGFENG', model, version });
  productChecks.push({
    model,
    version,
    engine: result.engine,
    status: result.status,
    episodes: result.summary.episodes,
    history: result.history.map(({ vigencia_desde, vigencia_hasta, precio_lista, precio_efectivo_final_sin_iva, tipo_cambio }) => ({
      vigencia_desde, vigencia_hasta, precio_lista, precio_efectivo_final_sin_iva, tipo_cambio,
    })),
  });
}
console.log(JSON.stringify({ ...(rows[0]?.result ?? {}), mcp_contract_checks: productChecks }, null, 2));
await closeAzurePool();
