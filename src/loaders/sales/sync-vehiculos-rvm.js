import { queryDb } from './db.js';

const VEHICLES = 'public.vehiculos_raw';

function quoteTable(tableName) {
  const parts = String(tableName).split('.');
  if (!parts.length || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  return parts.map((part) => `"${part}"`).join('.');
}

export async function ensureVehicleLifecycleColumns(tableName = VEHICLES, execute = queryDb) {
  const table = quoteTable(tableName);
  await execute(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS fecha_inscripcion_rvm date,
      ADD COLUMN IF NOT EXISTS patente_rvm text,
      ADD COLUMN IF NOT EXISTS rvm_data_status text,
      ADD COLUMN IF NOT EXISTS fecha_entrega_dealer date,
      ADD COLUMN IF NOT EXISTS fecha_actualizacion_rvm timestamptz
  `);
}

export async function preserveVehicleLifecycleInSnapshot(stagingTable, execute = queryDb) {
  await ensureVehicleLifecycleColumns(VEHICLES, execute);
  await ensureVehicleLifecycleColumns(stagingTable, execute);

  const staging = quoteTable(stagingTable);
  await execute(`
    UPDATE ${staging} s
       SET fecha_inscripcion_rvm = v.fecha_inscripcion_rvm,
           patente_rvm = v.patente_rvm,
           rvm_data_status = v.rvm_data_status,
           fecha_entrega_dealer = v.fecha_entrega_dealer,
           fecha_actualizacion_rvm = v.fecha_actualizacion_rvm
      FROM public.vehiculos_raw v
     WHERE upper(btrim(s.vin_chasis)) = upper(btrim(v.vin_chasis))
  `);
}

export async function syncVehiculosFromRvm(execute = queryDb, { onlyChanged = false } = {}) {
  await ensureVehicleLifecycleColumns(VEHICLES, execute);

  const rows = await execute(`
    WITH vehicle_vins AS (
      SELECT DISTINCT upper(btrim(vin_chasis)) AS vin
      FROM public.vehiculos_raw
      WHERE vin_chasis IS NOT NULL AND btrim(vin_chasis) <> ''
    ),
    matched_rvm AS (
      SELECT
        upper(btrim(coalesce(nullif(btrim(r.vin), ''), nullif(btrim(r.n_chasis), '')))) AS vin,
        r.fecha,
        nullif(btrim(r.patente),'') AS patente,
        r.data_status,
        r.fecha_ingesta
      FROM public.rvm_raw r
      JOIN vehicle_vins v
        ON v.vin = upper(btrim(coalesce(nullif(btrim(r.vin), ''), nullif(btrim(r.n_chasis), ''))))
      WHERE coalesce(nullif(btrim(r.vin), ''), nullif(btrim(r.n_chasis), '')) IS NOT NULL
    ),
    aggregated AS (
      SELECT
        vin,
        CASE
          WHEN bool_or(data_status='CONSOLIDATED')
            THEN min(fecha) FILTER (WHERE data_status='CONSOLIDATED')
          ELSE min(fecha) FILTER (WHERE data_status='PRELIMINARY')
        END AS fecha_inscripcion_rvm,
        CASE
          WHEN bool_or(data_status='CONSOLIDATED') THEN
            (array_agg(patente ORDER BY fecha DESC NULLS LAST, fecha_ingesta DESC NULLS LAST)
              FILTER (WHERE data_status='CONSOLIDATED' AND patente IS NOT NULL))[1]
          ELSE
            (array_agg(patente ORDER BY fecha DESC NULLS LAST, fecha_ingesta DESC NULLS LAST)
              FILTER (WHERE data_status='PRELIMINARY' AND patente IS NOT NULL))[1]
        END AS patente_rvm,
        CASE
          WHEN bool_or(data_status='CONSOLIDATED') THEN 'CONSOLIDATED'
          ELSE 'PRELIMINARY'
        END AS rvm_data_status
      FROM matched_rvm
      GROUP BY vin
    ),
    proposed AS (
      SELECT v.ctid AS vehicle_row,
        CASE
          WHEN v.rvm_data_status='CONSOLIDATED' AND a.rvm_data_status='PRELIMINARY'
            THEN v.fecha_inscripcion_rvm
          ELSE a.fecha_inscripcion_rvm
        END AS new_date,
        CASE
          WHEN v.rvm_data_status='CONSOLIDATED' AND a.rvm_data_status='PRELIMINARY'
            THEN v.patente_rvm
          ELSE coalesce(a.patente_rvm, v.patente_rvm)
        END AS new_plate,
        CASE
          WHEN v.rvm_data_status='CONSOLIDATED' THEN 'CONSOLIDATED'
          ELSE a.rvm_data_status
        END AS new_status,
        v.rvm_data_status='CONSOLIDATED' AND a.rvm_data_status='PRELIMINARY' AS keep_timestamp
      FROM public.vehiculos_raw v
      JOIN aggregated a ON upper(btrim(v.vin_chasis)) = a.vin
    ),
    updated AS (
      UPDATE public.vehiculos_raw v
         SET fecha_inscripcion_rvm = p.new_date,
             patente_rvm = p.new_plate,
             rvm_data_status = p.new_status,
             fecha_actualizacion_rvm = CASE
               WHEN p.keep_timestamp THEN v.fecha_actualizacion_rvm
               ELSE now()
             END
        FROM proposed p
       WHERE v.ctid = p.vehicle_row
         AND (NOT $1::boolean OR
              (v.fecha_inscripcion_rvm, v.patente_rvm, v.rvm_data_status)
              IS DISTINCT FROM (p.new_date, p.new_plate, p.new_status))
       RETURNING 1
    )
    SELECT count(*)::int AS rows_updated FROM updated
  `, [onlyChanged]);

  return rows[0] ?? { rows_updated: 0 };
}
