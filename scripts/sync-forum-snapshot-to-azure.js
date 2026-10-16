import pg from 'pg';

const { Client } = pg;
const columns = [
  'snapshot_date', 'source_type', 'numero_operacion', 'tipo_proceso',
  'fecha_cotizacion', 'distribuidor', 'sucursal', 'vendedor', 'ejecutivo',
  'modelo_vehiculo', 'version_vehiculo', 'valor_vehiculo', 'promocion',
  'plazo_credito', 'numero_contrato', 'monto_financiado', 'fecha_pagare',
  'fecha_primera_cuota', 'ultimo_vencimiento_no_pagado', 'forma_pago', 'rut',
  'nombre_completo', 'comuna', 'ciudad', 'region', 'fecha_cancelacion',
  'motivo_cancelacion', 'cantidad_vehiculo', 'fecha_precurse', 'fecha_curse',
  'source_file', 'load_kind',
];
const keys = ['snapshot_date', 'source_type', 'numero_operacion'];
const startDate = process.argv[2];
const endDate = process.argv[3];

if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '') ||
    startDate > endDate) {
  throw new Error('Usage: node scripts/sync-forum-snapshot-to-azure.js YYYY-MM-DD YYYY-MM-DD');
}
if (!process.env.DATABASE_URL || !process.env.AZURE_DATABASE_URL) {
  throw new Error('Missing DATABASE_URL or AZURE_DATABASE_URL');
}

const neon = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const azure = new Client({ connectionString: process.env.AZURE_DATABASE_URL, ssl: { rejectUnauthorized: false } });

try {
  await Promise.all([neon.connect(), azure.connect()]);
  const { rows } = await neon.query(
    `SELECT ${columns.join(',')} FROM public.forum_funnel_raw
     WHERE snapshot_date BETWEEN $1::date AND $2::date
     ORDER BY snapshot_date, source_type, numero_operacion`,
    [startDate, endDate],
  );

  await azure.query('BEGIN');
  let affected = 0;
  const batchSize = 100;
  const mutable = columns.filter((column) => !keys.includes(column));
  const update = mutable.map((column) => `${column}=EXCLUDED.${column}`).join(',');
  const different = columns.map((column) => `forum_funnel_raw.${column}`).join(',');
  const incoming = columns.map((column) => `EXCLUDED.${column}`).join(',');
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    let index = 1;
    const tuples = batch.map((row) => `(${columns.map((column) => {
      values.push(row[column]);
      return `$${index++}`;
    }).join(',')})`);
    const result = await azure.query(
      `INSERT INTO public.forum_funnel_raw (${columns.join(',')})
       VALUES ${tuples.join(',')}
       ON CONFLICT (snapshot_date, source_type, numero_operacion)
       DO UPDATE SET ${update}
       WHERE ROW(${different}) IS DISTINCT FROM ROW(${incoming})`,
      values,
    );
    affected += result.rowCount;
  }
  await azure.query('COMMIT');
  console.log(JSON.stringify({ status: 'COMPLETE', start_date: startDate, end_date: endDate, source_rows: rows.length, azure_rows_inserted_or_updated: affected }));
} catch (error) {
  try { await azure.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await Promise.allSettled([neon.end(), azure.end()]);
}
