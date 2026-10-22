import { queryDb } from '../neon.js';
import { resolveVentasRecognition } from '../ventas/resolveVentasRecognition.js';
import { refreshVehiculoSalidaV01 } from './vehiculo-salida-v01.js';

const VALID_VIN_PREDICATE = `
  vin_chasis IS NOT NULL
  AND btrim(vin_chasis) <> ''
  AND length(upper(btrim(vin_chasis))) = 17
  AND upper(btrim(vin_chasis)) ~ '^[A-HJ-NPR-Z0-9]{17}$'
`;

function parseRawTimestampSql(column) {
  const value = `btrim(${column}::text)`;
  return `
    CASE
      WHEN ${column} IS NULL OR ${value} = '' THEN NULL
      WHEN ${value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([[:space:]]+[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?)?$' THEN
        ${value}::timestamp
      WHEN ${value} ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}([[:space:]]+[0-9]{1,2}:[0-9]{2})?$' THEN
        to_timestamp(
          CASE WHEN ${value} ~ '[[:space:]]+[0-9]{1,2}:[0-9]{2}$' THEN ${value} ELSE ${value} || ' 0:00' END,
          'DD-MM-YYYY HH24:MI'
        )::timestamp
      WHEN ${value} ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}([[:space:]]+[0-9]{1,2}:[0-9]{2})?$' THEN
        to_timestamp(
          CASE WHEN ${value} ~ '[[:space:]]+[0-9]{1,2}:[0-9]{2}$' THEN ${value} ELSE ${value} || ' 0:00' END,
          'MM/DD/YY HH24:MI'
        )::timestamp
      WHEN ${value} ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}([[:space:]]+[0-9]{1,2}:[0-9]{2})?$' THEN
        to_timestamp(
          CASE WHEN ${value} ~ '[[:space:]]+[0-9]{1,2}:[0-9]{2}$' THEN ${value} ELSE ${value} || ' 0:00' END,
          'MM/DD/YYYY HH24:MI'
        )::timestamp
      ELSE NULL
    END
  `;
}

const BASE_REFRESH_SQL = `
WITH base AS (
  SELECT upper(btrim(vin_chasis)) AS vin, v.*
  FROM public.vehiculos_raw v
  WHERE ${VALID_VIN_PREDICATE}
),
direct_map AS (
  SELECT upper(btrim(contexto_marca_raw)) AS marca_n,
         upper(btrim(valor_raw)) AS valor_n,
         min(version_id) AS version_id
  FROM public.producto_aliases_v01
  WHERE fuente='vehiculos_raw' AND nivel='VERSION' AND estado='RESUELTO'
  GROUP BY 1,2
  HAVING count(DISTINCT version_id)=1
),
ventas_map AS (
  SELECT upper(btrim(contexto_marca_raw)) AS marca_n,
         upper(btrim(valor_raw)) AS valor_n,
         min(version_id) AS version_id
  FROM public.producto_aliases_v01
  WHERE fuente='ventas_raw' AND nivel='VERSION' AND estado='RESUELTO'
  GROUP BY 1,2
  HAVING count(DISTINCT version_id)=1
),
nv_map AS (
  SELECT upper(btrim(contexto_marca_raw)) AS marca_n,
         upper(btrim(valor_raw)) AS valor_n,
         min(version_id) AS version_id
  FROM public.producto_aliases_v01
  WHERE fuente='notas_venta_raw' AND nivel='VERSION' AND estado='RESUELTO'
  GROUP BY 1,2
  HAVING count(DISTINCT version_id)=1
),
ventas_vin AS (
  SELECT DISTINCT upper(btrim(v.nro_vin_chasis)) AS vin, vm.version_id
  FROM public.ventas_raw v
  JOIN ventas_map vm
    ON vm.marca_n=upper(btrim(v.desc_mae_marca))
   AND vm.valor_n=upper(btrim(v.desc_articulo))
  WHERE v.nro_vin_chasis IS NOT NULL AND btrim(v.nro_vin_chasis)<>''
),
nv_vin AS (
  SELECT DISTINCT upper(btrim(n.chasis)) AS vin, nm.version_id
  FROM public.notas_venta_raw n
  JOIN nv_map nm
    ON nm.marca_n=upper(btrim(n.desc_mae_marca))
   AND nm.valor_n=upper(btrim(n.modelo_comercial))
  WHERE n.chasis IS NOT NULL AND btrim(n.chasis)<>''
),
candidates AS (
  SELECT b.vin,
         dm.version_id AS direct_version,
         array_remove(array_agg(DISTINCT vv.version_id),NULL) AS ventas_versions,
         array_remove(array_agg(DISTINCT nn.version_id),NULL) AS nv_versions
  FROM base b
  LEFT JOIN direct_map dm
    ON dm.marca_n=upper(btrim(b.marca))
   AND dm.valor_n=upper(btrim(b.modelo))
  LEFT JOIN ventas_vin vv ON vv.vin=b.vin
  LEFT JOIN nv_vin nn ON nn.vin=b.vin
  GROUP BY b.vin, dm.version_id
),
resolved AS (
  SELECT c.vin,
         CASE WHEN cardinality(all_versions)=1 THEN all_versions[1] ELSE NULL END AS version_id,
         CASE
           WHEN cardinality(all_versions)>1 THEN 'CONFLICTO_CROSS_SOURCE'
           WHEN c.direct_version IS NOT NULL THEN 'VEHICULOS_RAW_ALIAS'
           WHEN cardinality(c.ventas_versions)>0 THEN 'VIN_CROSS_SOURCE_VENTAS'
           WHEN cardinality(c.nv_versions)>0 THEN 'VIN_CROSS_SOURCE_NOTAS'
           ELSE NULL
         END AS producto_match_method,
         cardinality(all_versions)>1 AS producto_conflicto
  FROM candidates c
  CROSS JOIN LATERAL (
    SELECT ARRAY(
      SELECT DISTINCT x
      FROM unnest(
        array_cat(
          array_cat(CASE WHEN c.direct_version IS NULL THEN ARRAY[]::bigint[] ELSE ARRAY[c.direct_version] END, c.ventas_versions),
          c.nv_versions
        )
      ) x
      ORDER BY x
    ) AS all_versions
  ) q
),
source_rows AS (
  SELECT
    b.vin,
    r.version_id,
    r.producto_match_method,
    r.producto_conflicto,
    btrim(b.nro_stock) AS nro_stock,
    btrim(b.marca) AS marca_raw,
    btrim(b.modelo) AS modelo_raw,
    nullif(btrim(b.patente),'') AS patente,
    nullif(btrim(b.ano),'') AS ano_raw,
    nullif(btrim(b.color),'') AS color_raw,
    coalesce(nullif(btrim(b.etapa),''), existing.etapa) AS etapa,
    btrim(b.bodega) AS bodega_fuente,
    CASE btrim(b.vigente) WHEN '1' THEN true WHEN '0' THEN false END AS vigente,
    ${parseRawTimestampSql('b.fecha_ingreso_stk')} AS fecha_ingreso_stock,
    ${parseRawTimestampSql('b.fecha_eta')} AS fecha_eta,
    ${parseRawTimestampSql('b.fecha_nv')} AS fecha_nv,
    nullif(btrim(b.nota_de_venta),'') AS nota_de_venta,
    nullif(btrim(b.factura),'') AS factura_tipo,
    nullif(btrim(b.numero_factura),'') AS numero_factura,
    ${parseRawTimestampSql('b.fecha_factura')} AS fecha_factura,
    ${parseRawTimestampSql('b.fecha_entrega_planificada')} AS fecha_entrega_planificada,
    CASE btrim(coalesce(b.pendiente_entrega,'')) WHEN '1' THEN true WHEN '0' THEN false ELSE NULL END AS pendiente_entrega,
    nullif(btrim(b.esta_fisico),'') AS esta_fisico_raw,
    CASE btrim(b.esta_reservado) WHEN '1' THEN true WHEN '0' THEN false END AS esta_reservado,
    CASE btrim(b.esta_en_transito) WHEN '1' THEN true WHEN '0' THEN false END AS esta_en_transito,
    CASE btrim(b.en_patio) WHEN '1' THEN true WHEN '0' THEN false END AS en_patio,
    nullif(btrim(b.tipo_ficha),'') AS tipo_ficha,
    b.vin_chasis AS source_vin_raw
  FROM base b
  JOIN resolved r USING (vin)
  LEFT JOIN public.vehiculo_canonico existing ON existing.vin=b.vin
),
upserted AS (
  INSERT INTO public.vehiculo_canonico (
    vin,version_id,producto_match_method,producto_conflicto,nro_stock,marca_raw,modelo_raw,
    patente,ano_raw,color_raw,etapa,bodega_fuente,vigente,fecha_ingreso_stock,fecha_eta,
    fecha_nv,nota_de_venta,factura_tipo,numero_factura,fecha_factura,fecha_entrega_planificada,
    pendiente_entrega,esta_fisico_raw,esta_reservado,esta_en_transito,en_patio,tipo_ficha,source_vin_raw
  )
  SELECT
    vin,version_id,producto_match_method,producto_conflicto,nro_stock,marca_raw,modelo_raw,
    patente,ano_raw,color_raw,etapa,bodega_fuente,vigente,fecha_ingreso_stock,fecha_eta,
    fecha_nv,nota_de_venta,factura_tipo,numero_factura,fecha_factura,fecha_entrega_planificada,
    pendiente_entrega,esta_fisico_raw,esta_reservado,esta_en_transito,en_patio,tipo_ficha,source_vin_raw
  FROM source_rows
  ON CONFLICT (vin) DO UPDATE SET
    version_id=excluded.version_id,
    producto_match_method=excluded.producto_match_method,
    producto_conflicto=excluded.producto_conflicto,
    nro_stock=excluded.nro_stock,
    marca_raw=excluded.marca_raw,
    modelo_raw=excluded.modelo_raw,
    patente=excluded.patente,
    ano_raw=excluded.ano_raw,
    color_raw=excluded.color_raw,
    etapa=excluded.etapa,
    bodega_fuente=excluded.bodega_fuente,
    vigente=excluded.vigente,
    fecha_ingreso_stock=excluded.fecha_ingreso_stock,
    fecha_eta=excluded.fecha_eta,
    fecha_nv=excluded.fecha_nv,
    nota_de_venta=excluded.nota_de_venta,
    factura_tipo=excluded.factura_tipo,
    numero_factura=excluded.numero_factura,
    fecha_factura=excluded.fecha_factura,
    fecha_entrega_planificada=excluded.fecha_entrega_planificada,
    pendiente_entrega=excluded.pendiente_entrega,
    esta_fisico_raw=excluded.esta_fisico_raw,
    esta_reservado=excluded.esta_reservado,
    esta_en_transito=excluded.esta_en_transito,
    en_patio=excluded.en_patio,
    tipo_ficha=excluded.tipo_ficha,
    source_vin_raw=excluded.source_vin_raw,
    source_table='vehiculos_raw',
    canonicalized_at=now()
  RETURNING vin
),
deleted AS (
  DELETE FROM public.vehiculo_canonico vc
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.vehiculos_raw vr
    WHERE ${VALID_VIN_PREDICATE.replaceAll('vin_chasis', 'vr.vin_chasis')}
      AND upper(btrim(vr.vin_chasis))=vc.vin
  )
  RETURNING vin
)
SELECT
  (SELECT count(*) FROM upserted) AS rows_upserted,
  (SELECT count(*) FROM deleted) AS rows_deleted;
`;

async function preflight() {
  const rows = await queryDb(`
    WITH normalized AS (
      SELECT upper(btrim(vin_chasis)) AS vin,
             CASE WHEN ${VALID_VIN_PREDICATE} THEN true ELSE false END AS valid
      FROM vehiculos_raw
    ), valid AS (
      SELECT vin FROM normalized WHERE valid
    )
    SELECT
      (SELECT count(*) FROM vehiculos_raw) AS raw_rows,
      (SELECT count(*) FROM valid) AS valid_rows,
      (SELECT count(DISTINCT vin) FROM valid) AS valid_vins,
      (SELECT count(*) - count(DISTINCT vin) FROM valid) AS duplicate_valid_rows,
      (SELECT count(*) FROM normalized WHERE NOT valid) AS invalid_or_empty_rows,
      (SELECT count(*) FROM vehiculo_canonico) AS canonical_before,
      (SELECT count(*) FROM valid v LEFT JOIN vehiculo_canonico c USING(vin) WHERE c.vin IS NULL) AS valid_missing_before,
      (SELECT count(*) FROM vehiculo_canonico c LEFT JOIN valid v USING(vin) WHERE v.vin IS NULL) AS canonical_extra_before,
      (
        SELECT count(*)
        FROM vehiculos_raw vr
        LEFT JOIN vehiculo_canonico c ON c.vin=upper(btrim(vr.vin_chasis))
        WHERE ${VALID_VIN_PREDICATE.replaceAll('vin_chasis', 'vr.vin_chasis')}
          AND nullif(btrim(vr.etapa),'') IS NULL
          AND nullif(btrim(c.etapa),'') IS NULL
      ) AS unrecoverable_etapa_rows;
  `);
  return rows[0];
}

async function ensureResolutionStatus() {
  await queryDb(`ALTER TABLE vehiculo_canonico ADD COLUMN IF NOT EXISTS resolution_status text`);
  await queryDb(`
    UPDATE vehiculo_canonico
       SET resolution_status = CASE
         WHEN NOT vendido THEN 'NOT_APPLICABLE'
         WHEN canal_salida='TIENDA_PROPIA' AND sucursal_venta_id IS NOT NULL AND dealer_id IS NULL THEN 'RESOLVED'
         WHEN canal_salida='DEALER' AND dealer_id IS NOT NULL AND sucursal_venta_id IS NULL THEN 'RESOLVED'
         ELSE 'UNRESOLVED'
       END
  `);
}


async function refreshRecognizedSaleDate() {
  await queryDb(`
    ALTER TABLE public.vehiculo_canonico
    ADD COLUMN IF NOT EXISTS fecha_venta_reconocida timestamp without time zone NULL
  `);

  const salesRows = await queryDb(`
    SELECT id, nro_vin_chasis, fecha_factura, nro_factura, categoria_cliente
    FROM public.ventas_raw
    WHERE btrim(categoria_cliente) IN ('Cliente General', 'Concesionaria')
  `);
  const { recognizedSales } = resolveVentasRecognition(salesRows);
  const assignableSales = recognizedSales.filter((sale) => sale.vin != null);
  const vins = assignableSales.map((sale) => String(sale.vin).trim().toUpperCase());
  const dates = assignableSales.map((sale) => sale.fecha_venta_iso.replace('T', ' ').replace(/Z$/, ''));
  const invoices = assignableSales.map((sale) => sale.nro_factura);

  const rows = await queryDb(`
    WITH recognized AS (
      SELECT *
      FROM unnest($1::text[], $2::timestamp[], $3::text[])
        AS r(vin, fecha, nro_factura)
    ),
    expected AS (
      SELECT
        vc.vehiculo_id,
        CASE
          WHEN recognized.vin IS NOT NULL
           AND master_norm(vc.numero_factura) IS NOT NULL
           AND master_norm(vc.numero_factura) = master_norm(recognized.nro_factura)
          THEN recognized.fecha
          ELSE NULL
        END AS expected_fecha,
        recognized.vin IS NOT NULL
          AND (
            master_norm(vc.numero_factura) IS NULL
            OR master_norm(vc.numero_factura) IS DISTINCT FROM master_norm(recognized.nro_factura)
          ) AS invoice_mismatch
      FROM public.vehiculo_canonico vc
      LEFT JOIN recognized ON recognized.vin = upper(btrim(vc.vin))
    ),
    updated AS (
      UPDATE public.vehiculo_canonico vc
         SET fecha_venta_reconocida = expected.expected_fecha
        FROM expected
       WHERE vc.vehiculo_id = expected.vehiculo_id
      RETURNING vc.vehiculo_id, vc.fecha_venta_reconocida
    )
    SELECT
      count(*) FILTER (WHERE updated.fecha_venta_reconocida IS NOT NULL)::bigint AS vin_con_fecha_reconocida,
      count(*) FILTER (WHERE updated.fecha_venta_reconocida IS NULL)::bigint AS vin_sin_fecha_reconocida,
      (SELECT count(*) FROM expected WHERE invoice_mismatch)::bigint AS vin_con_factura_no_coincidente,
      count(*) FILTER (WHERE updated.fecha_venta_reconocida IS DISTINCT FROM expected.expected_fecha)::bigint AS errores_integridad_fecha
    FROM updated
    JOIN expected USING (vehiculo_id)
  `, [vins, dates, invoices]);

  return rows[0];
}

async function postAudit() {
  const rows = await queryDb(`
    WITH valid AS (
      SELECT DISTINCT upper(btrim(vin_chasis)) AS vin
      FROM vehiculos_raw
      WHERE ${VALID_VIN_PREDICATE}
    )
    SELECT
      (SELECT count(*) FROM valid) AS valid_raw_vins,
      count(*) AS canonical_rows,
      count(*) FILTER (WHERE length(vin)<>17 OR vin !~ '^[A-HJ-NPR-Z0-9]{17}$') AS invalid_persisted,
      count(*) FILTER (WHERE producto_conflicto) AS product_conflicts,
      count(*) FILTER (WHERE vendido) AS sold,
      count(*) FILTER (WHERE canal_salida='TIENDA_PROPIA') AS tienda_propia,
      count(*) FILTER (WHERE canal_salida='DEALER') AS dealer,
      count(*) FILTER (WHERE resolution_status='RESOLVED') AS resolved,
      count(*) FILTER (WHERE resolution_status='UNRESOLVED') AS unresolved,
      count(*) FILTER (WHERE resolution_status='NOT_APPLICABLE') AS not_applicable,
      count(*) FILTER (WHERE canal_salida='TIENDA_PROPIA' AND (sucursal_venta_id IS NULL OR dealer_id IS NOT NULL)) AS store_integrity_failed,
      count(*) FILTER (WHERE canal_salida='DEALER' AND sucursal_venta_id IS NOT NULL) AS dealer_integrity_failed,
      count(*) FILTER (WHERE vendido AND canal_salida='DEALER' AND dealer_id IS NULL) AS dealer_unresolved,
      count(*) FILTER (WHERE vendido AND canal_salida IS NULL) AS channel_unresolved,
      count(*) FILTER (WHERE
        resolution_status <> CASE
          WHEN NOT vendido THEN 'NOT_APPLICABLE'
          WHEN canal_salida='TIENDA_PROPIA' AND sucursal_venta_id IS NOT NULL AND dealer_id IS NULL THEN 'RESOLVED'
          WHEN canal_salida='DEALER' AND dealer_id IS NOT NULL AND sucursal_venta_id IS NULL THEN 'RESOLVED'
          ELSE 'UNRESOLVED'
        END
      ) AS status_mismatch,
      (SELECT count(*) FROM valid v LEFT JOIN vehiculo_canonico c USING(vin) WHERE c.vin IS NULL) AS missing_from_canonical,
      (SELECT count(*) FROM vehiculo_canonico c LEFT JOIN valid v USING(vin) WHERE v.vin IS NULL) AS extra_in_canonical
    FROM vehiculo_canonico;
  `);
  return rows[0];
}

function n(value) {
  return Number(value ?? 0);
}

export function validateRefreshAudit(preflightResult, auditResult = null) {
  if (n(preflightResult?.duplicate_valid_rows) !== 0) {
    throw new Error(`refresh_vehiculo_canonico_v01 blocked: duplicate valid VIN rows=${preflightResult.duplicate_valid_rows}`);
  }
  if (n(preflightResult?.unrecoverable_etapa_rows) !== 0) {
    throw new Error(`refresh_vehiculo_canonico_v01 blocked: missing etapa without canonical fallback rows=${preflightResult.unrecoverable_etapa_rows}`);
  }
  if (!auditResult) return true;

  const failures = {
    raw_vs_canonical: n(auditResult.valid_raw_vins) === n(auditResult.canonical_rows) ? 0 : 1,
    invalid_persisted: n(auditResult.invalid_persisted),
    missing_from_canonical: n(auditResult.missing_from_canonical),
    extra_in_canonical: n(auditResult.extra_in_canonical),
    store_integrity_failed: n(auditResult.store_integrity_failed),
    dealer_integrity_failed: n(auditResult.dealer_integrity_failed),
    status_mismatch: n(auditResult.status_mismatch),
  };
  const totalFailures = Object.values(failures).reduce((sum, value) => sum + value, 0);
  if (totalFailures !== 0) {
    throw new Error(`refresh_vehiculo_canonico_v01 integrity failed: ${JSON.stringify(failures)}`);
  }
  return true;
}

export async function refreshVehiculoCanonicoV01(options = {}) {
  const dryRun = options?.dry_run === true;
  if (!dryRun) throw new Error('Azure canonical rebuild is not enabled: validate SALES/RVM parity and transaction isolation first');
  const before = await preflight();
  validateRefreshAudit(before);

  if (dryRun) {
    return {
      phase: 'refresh_vehiculo_canonico_v01',
      strategy: 'FULL_REBUILD_CURRENT_STATE',
      dry_run: true,
      before,
    };
  }

  const azureTarget = Boolean(process.env.AZURE_DATABASE_URL);
  if (azureTarget) {
    await queryDb(`
      ALTER TABLE public.vehiculo_canonico
      ADD COLUMN IF NOT EXISTS fecha_venta_reconocida timestamp without time zone NULL
    `);
  }

  const baseRows = await queryDb(BASE_REFRESH_SQL);
  const salida = await refreshVehiculoSalidaV01({ dry_run: false });
  await ensureResolutionStatus();
  const recognizedSaleDate = azureTarget ? await refreshRecognizedSaleDate() : null;
  const audit = await postAudit();
  validateRefreshAudit(before, audit);

  return {
    phase: 'refresh_vehiculo_canonico_v01',
    strategy: 'FULL_REBUILD_CURRENT_STATE',
    dry_run: false,
    before,
    base: baseRows[0],
    salida: salida.summary,
    recognized_sale_date: recognizedSaleDate,
    audit,
  };
}
