import { queryDb } from './db.js';

const KEEP_COLUMNS = [
  'nro_stock', 'vin_chasis', 'marca', 'modelo', 'patente', 'ano', 'color',
  'etapa', 'bodega', 'vigente', 'fecha_nv', 'nota_de_venta', 'vendedor',
  'factura', 'numero_factura', 'fecha_factura', 'rut', 'cliente',
  'fecha_entrega_planificada', 'pendiente_entrega', 'esta_fisico',
  'esta_reservado', 'esta_en_transito', 'en_patio', 'fecha_ingreso_stk',
  'tipo_ficha', 'fecha_eta',
];

const DATE_COLUMNS = [
  'fecha_nv',
  'fecha_factura',
  'fecha_entrega_planificada',
  'fecha_ingreso_stk',
  'fecha_eta',
];

const q = (value) => `"${String(value).replace(/"/g, '""')}"`;
const receiptDate = `CASE WHEN TRIM(fecha_recibo) ~ '^\\d{1,2}/\\d{1,2}/\\d{2} \\d{1,2}:\\d{2}$'
  THEN to_timestamp(TRIM(fecha_recibo), 'MM/DD/YY HH24:MI') END`;

const commercialEvidenceScore = `
  (CASE WHEN NULLIF(TRIM(fecha_factura), '') IS NOT NULL THEN 16 ELSE 0 END) +
  (CASE WHEN NULLIF(TRIM(numero_factura), '') IS NOT NULL OR NULLIF(TRIM(factura), '') IS NOT NULL THEN 8 ELSE 0 END) +
  (CASE WHEN NULLIF(TRIM(nota_de_venta), '') IS NOT NULL THEN 4 ELSE 0 END) +
  (CASE WHEN UPPER(TRIM(COALESCE(etapa, ''))) IN ('CL', 'CL - CLIENTE') THEN 2 ELSE 0 END) +
  (CASE WHEN TRIM(COALESCE(vigente, '')) = '1' THEN 1 ELSE 0 END)
`;

function normalizedDate(column) {
  const c = q(column);
  const value = `BTRIM(${c}::text)`;
  return `CASE
    WHEN ${c} IS NULL OR ${value} = '' THEN NULL
    WHEN ${value} ~ '^\\d{1,2}-\\d{1,2}-\\d{4}( \\d{1,2}:\\d{2})?$'
      THEN to_timestamp(${value}, CASE WHEN ${value} ~ ' ' THEN 'DD-MM-YYYY HH24:MI' ELSE 'DD-MM-YYYY' END)::timestamp
    WHEN ${value} ~ '^\\d{1,2}/\\d{1,2}/\\d{4}( \\d{1,2}:\\d{2})?$'
      THEN to_timestamp(${value}, CASE WHEN ${value} ~ ' ' THEN 'DD/MM/YYYY HH24:MI' ELSE 'DD/MM/YYYY' END)::timestamp
    WHEN ${value} ~ '^\\d{1,2}/\\d{1,2}/\\d{2}( \\d{1,2}:\\d{2})?$'
      THEN to_timestamp(${value}, CASE WHEN ${value} ~ ' ' THEN 'MM/DD/YY HH24:MI' ELSE 'MM/DD/YY' END)::timestamp
    ELSE NULL
  END`;
}

async function normalizeDateColumns(sql, table, availableColumns) {
  const t = q(table);
  const dateColumns = DATE_COLUMNS.filter((column) => availableColumns.includes(column));
  for (const column of dateColumns) {
    await sql.query(
      `ALTER TABLE ${t} ALTER COLUMN ${q(column)} TYPE timestamp without time zone USING ${normalizedDate(column)}`,
    );
  }
  return dateColumns;
}

export async function cleanVehicleSource(table) {
  const sql = { query: queryDb };
  const t = q(table);
  const [{ count: before }] = await sql.query(`SELECT COUNT(*)::int count FROM ${t}`);

  const excluded = await sql.query(
    `DELETE FROM ${t} WHERE tipo IS NULL OR TRIM(tipo) <> 'Vehiculo Nuevo' RETURNING 1`,
  );
  const duplicateVin = await sql.query(`WITH ranked AS (
    SELECT ctid, ROW_NUMBER() OVER (
      PARTITION BY TRIM(vin_chasis)
      ORDER BY ${commercialEvidenceScore} DESC,
        ${receiptDate} DESC NULLS LAST,
        CASE WHEN TRIM(nro_recibo) ~ '^\\d+$' THEN TRIM(nro_recibo)::bigint END DESC NULLS LAST,
        ctid DESC
    ) rn FROM ${t} WHERE NULLIF(TRIM(vin_chasis), '') IS NOT NULL
  ) DELETE FROM ${t} x USING ranked r WHERE x.ctid = r.ctid AND r.rn > 1 RETURNING 1`);
  const duplicateStock = await sql.query(`WITH ranked AS (
    SELECT ctid, ROW_NUMBER() OVER (
      PARTITION BY TRIM(nro_stock)
      ORDER BY ${receiptDate} DESC NULLS LAST,
        CASE WHEN TRIM(nro_recibo) ~ '^\\d+$' THEN TRIM(nro_recibo)::bigint END DESC NULLS LAST,
        ctid DESC
    ) rn FROM ${t} WHERE NULLIF(TRIM(vin_chasis), '') IS NULL
  ) DELETE FROM ${t} x USING ranked r WHERE x.ctid = r.ctid AND r.rn > 1 RETURNING 1`);

  const columns = await sql.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  const availableColumns = columns.map((r) => r.column_name);
  const normalized_date_columns = await normalizeDateColumns(sql, table, availableColumns);
  const drop = availableColumns.filter((name) => !KEEP_COLUMNS.includes(name));
  if (drop.length) await sql.query(`ALTER TABLE ${t} ${drop.map((name) => `DROP COLUMN ${q(name)}`).join(', ')}`);

  const [{ count: after }] = await sql.query(`SELECT COUNT(*)::int count FROM ${t}`);
  return {
    before, after,
    removed: {
      non_vehicle_new: excluded.length,
      duplicate_vin_rows: duplicateVin.length,
      duplicate_stock_rows_without_vin: duplicateStock.length,
    },
    normalized_date_columns,
    kept_columns: KEEP_COLUMNS,
  };
}
