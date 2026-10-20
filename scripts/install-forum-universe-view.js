import assert from 'node:assert/strict';
import { azureQuery, closeAzurePool } from '../lib/azure-postgres.js';

const requiredColumns = [
  'snapshot_date', 'source_type', 'numero_operacion', 'tipo_proceso', 'fecha_cotizacion',
  'distribuidor', 'sucursal', 'vendedor', 'ejecutivo', 'modelo_vehiculo', 'version_vehiculo',
  'valor_vehiculo', 'promocion', 'plazo_credito', 'numero_contrato', 'monto_financiado',
  'fecha_pagare', 'fecha_primera_cuota', 'ultimo_vencimiento_no_pagado', 'forma_pago', 'rut',
  'nombre_completo', 'comuna', 'ciudad', 'region', 'fecha_cancelacion', 'motivo_cancelacion',
  'cantidad_vehiculo', 'fecha_precurse', 'fecha_curse', 'source_file', 'load_kind', 'loaded_at',
];

const universeView = `
  WITH ranked AS (
    SELECT r.*,
      row_number() OVER (
        PARTITION BY r.numero_operacion
        ORDER BY r.snapshot_date DESC,
          CASE r.source_type WHEN 'CURSE' THEN 3 WHEN 'PRECURSE' THEN 2 ELSE 1 END DESC,
          r.loaded_at DESC
      ) AS rn
    FROM public.forum_funnel_raw r
  ), latest_precurse_snapshot AS (
    SELECT max(snapshot_date) AS snapshot_date
    FROM public.forum_funnel_raw
    WHERE source_type = 'PRECURSE'
  ), current_precurse AS (
    SELECT r.numero_operacion,
      max(r.cantidad_vehiculo) AS cantidad_vehiculo
    FROM public.forum_funnel_raw r
    CROSS JOIN latest_precurse_snapshot latest
    WHERE r.source_type = 'PRECURSE'
      AND r.snapshot_date = latest.snapshot_date
    GROUP BY r.numero_operacion
  ), evidence AS (
    SELECT numero_operacion,
      min(fecha_cotizacion) AS fecha_cotizacion,
      max(fecha_precurse) AS fecha_precurse,
      max(fecha_curse) FILTER (
        WHERE source_type = 'CURSE'
          AND upper(btrim(coalesce(tipo_proceso, ''))) = 'CURSADA'
          AND fecha_curse::date < DATE '2100-01-01'
      ) AS fecha_curse,
      max(cantidad_vehiculo) FILTER (
        WHERE source_type = 'CURSE'
          AND upper(btrim(coalesce(tipo_proceso, ''))) = 'CURSADA'
          AND fecha_curse::date < DATE '2100-01-01'
      ) AS curse_cantidad_vehiculo,
      max(cantidad_vehiculo) AS cantidad_vehiculo,
      max(snapshot_date) AS last_snapshot_date,
      bool_or(source_type = 'COTIZACION') AS has_cotizacion_evidence,
      bool_or(source_type = 'PRECURSE') AS has_precurse_evidence,
      bool_or(source_type = 'CURSE'
        AND upper(btrim(coalesce(tipo_proceso, ''))) = 'CURSADA'
        AND fecha_curse IS NOT NULL
        AND fecha_curse::date < DATE '2100-01-01'
      ) AS has_curse_evidence,
      count(*)::integer AS evidence_rows
    FROM public.forum_funnel_raw
    GROUP BY numero_operacion
  )
  SELECT l.numero_operacion,
    l.tipo_proceso AS estado_actual,
    e.fecha_cotizacion,
    e.fecha_precurse,
    e.fecha_curse,
    CASE WHEN e.has_curse_evidence THEN 'CURSE'
      WHEN p.numero_operacion IS NOT NULL THEN 'PRECURSE'
      ELSE 'COTIZACION' END AS etapa_certificada,
    CASE WHEN e.has_curse_evidence THEN coalesce(e.curse_cantidad_vehiculo, 1)
      ELSE 0 END AS ufi_curse,
    CASE WHEN NOT e.has_curse_evidence AND p.numero_operacion IS NOT NULL
      THEN coalesce(p.cantidad_vehiculo, 1) ELSE 0 END AS ufi_precurse_abierto,
    CASE WHEN e.has_curse_evidence THEN coalesce(e.curse_cantidad_vehiculo, 1)
      WHEN p.numero_operacion IS NOT NULL THEN coalesce(p.cantidad_vehiculo, 1)
      ELSE 0 END AS ufi_operacional,
    l.distribuidor, l.sucursal, l.vendedor, l.ejecutivo,
    l.modelo_vehiculo, l.version_vehiculo, l.valor_vehiculo, l.promocion,
    l.plazo_credito, l.numero_contrato, l.monto_financiado, l.forma_pago,
    l.rut, l.nombre_completo, l.comuna, l.ciudad, l.region,
    l.fecha_cancelacion, l.motivo_cancelacion,
    e.cantidad_vehiculo, e.last_snapshot_date,
    l.source_type AS latest_source_type,
    l.source_file AS latest_source_file,
    e.has_cotizacion_evidence, e.has_precurse_evidence, e.has_curse_evidence,
    e.evidence_rows
  FROM ranked l
  JOIN evidence e USING (numero_operacion)
  LEFT JOIN current_precurse p USING (numero_operacion)
  WHERE l.rn = 1
`;

try {
  const [target] = await azureQuery(`SELECT to_regclass('public.forum_funnel_universe_v01')::text AS relation`);
  const columns = await azureQuery(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='forum_funnel_raw'
  `);
  const actual = new Set(columns.map(row => row.column_name));
  const missing = requiredColumns.filter(column => !actual.has(column));
  assert.equal(missing.length, 0,
    `Cannot replace Forum universe view; public.forum_funnel_raw is missing columns: ${missing.join(', ')}`);
  assert.ok(columns.length, 'Cannot replace Forum universe view; public.forum_funnel_raw is missing');

  await azureQuery(`CREATE OR REPLACE VIEW public.forum_funnel_universe_v01 AS ${universeView}`);
    const [check] = await azureQuery(`
      SELECT count(*)::bigint AS rows,
        count(DISTINCT numero_operacion)::bigint AS operations,
        count(*) FILTER (WHERE etapa_certificada='PRECURSE')::bigint AS precurse_operations,
        count(*) FILTER (WHERE etapa_certificada='PRECURSE' AND upper(btrim(coalesce(distribuidor,'')))='CIDEF')::bigint AS cidef_precurse_operations,
        (SELECT max(snapshot_date)::text FROM public.forum_funnel_raw WHERE source_type='PRECURSE') AS precurse_snapshot_date,
        coalesce(sum(ufi_curse),0)::bigint AS ufi_curse,
        coalesce(sum(ufi_precurse_abierto),0)::bigint AS ufi_precurse_open
      FROM public.forum_funnel_universe_v01
    `);
  assert.equal(Number(check.rows), Number(check.operations), 'Forum universe must contain one row per operation');
  console.log(JSON.stringify({
    status: target.relation ? 'REPLACED_FROM_EXISTING_RAW' : 'CREATED_FROM_EXISTING_RAW',
    relation: 'public.forum_funnel_universe_v01',
    ...Object.fromEntries(Object.entries(check).map(([key, value]) => [
      key, value === null || key === 'precurse_snapshot_date' ? value : Number(value),
    ])),
  }));
} finally {
  await closeAzurePool();
}
