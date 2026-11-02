import { rvmDb } from '../rvm-db.js';

export async function refreshRvmMarketAggregates({ year, month, dataStatus, snapshotDate = null }) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`Invalid RVM aggregate period: ${year}-${month}`);
  }
  if (!['PRELIMINARY', 'CONSOLIDATED'].includes(dataStatus)) {
    throw new Error(`Invalid RVM aggregate data status: ${dataStatus}`);
  }
  if (dataStatus === 'PRELIMINARY' && !snapshotDate) {
    throw new Error('Missing RVM preliminary snapshot_date for aggregate refresh');
  }

  const sql = rvmDb();
  const dateClause = dataStatus === 'PRELIMINARY' ? 'AND snapshot_date=$4::date' : '';
  const historyBefore = dataStatus === 'PRELIMINARY'
    ? await sql.query(
      `SELECT COUNT(*)::int AS rows FROM public.rvm_market_monthly_v01
       WHERE year=$1 AND month=$2 AND data_status='PRELIMINARY'
         AND snapshot_date IS DISTINCT FROM $3::date`,
      [y, m, snapshotDate],
    )
    : null;

  await sql.query('BEGIN');
  try {
    const source = await sql.query(
      `SELECT COUNT(*)::int AS rows, COALESCE(SUM(cantidad),0)::bigint AS units
       FROM public.rvm_raw
       WHERE ano=$1 AND mes=$2 AND data_status=$3 ${dateClause}`,
      dataStatus === 'PRELIMINARY' ? [y, m, dataStatus, snapshotDate] : [y, m, dataStatus],
    );
    if (Number(source[0]?.rows ?? 0) === 0) {
      throw new Error(`No RVM raw rows found for ${y}-${String(m).padStart(2, '0')} ${dataStatus}`);
    }

    await sql.query(
      `DELETE FROM public.rvm_market_daily_v01 WHERE year=$1 AND month=$2`,
      [y, m],
    );
    await sql.query(
      `WITH grouped AS (
         SELECT ano AS year, mes AS month, dia AS day, marca,
                modelo_homologado AS modelo, SUM(cantidad)::int AS units
         FROM public.rvm_raw
         WHERE ano=$1 AND mes=$2 AND data_status=$3 ${dateClause}
         GROUP BY ano,mes,dia,marca,modelo_homologado
       ), cumulative AS (
         SELECT *, SUM(units) OVER (
           PARTITION BY year,month,marca,modelo ORDER BY day
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         )::int AS cumulative_units
         FROM grouped
       )
       INSERT INTO public.rvm_market_daily_v01
         (year,month,day,marca,modelo,units,cumulative_units)
       SELECT year,month,day,marca,modelo,units,cumulative_units FROM cumulative`,
      dataStatus === 'PRELIMINARY' ? [y, m, dataStatus, snapshotDate] : [y, m, dataStatus],
    );

    if (dataStatus === 'PRELIMINARY') {
      await sql.query(
        `DELETE FROM public.rvm_market_monthly_v01
         WHERE year=$1 AND month=$2 AND data_status='PRELIMINARY' AND snapshot_date=$3::date`,
        [y, m, snapshotDate],
      );
    } else {
      await sql.query(
        `DELETE FROM public.rvm_market_monthly_v01
         WHERE year=$1 AND month=$2 AND data_status='CONSOLIDATED'`,
        [y, m],
      );
    }

    await sql.query(
      `INSERT INTO public.rvm_market_monthly_v01
         (year,month,marca,modelo,data_status,snapshot_date,date_to,units)
       SELECT ano,mes,marca,modelo_homologado,$3,
              CASE WHEN $3='PRELIMINARY' THEN $4::date ELSE NULL::date END,
              MAX(fecha),SUM(cantidad)::int
       FROM public.rvm_raw
       WHERE ano=$1 AND mes=$2 AND data_status=$3 ${dateClause}
       GROUP BY ano,mes,marca,modelo_homologado`,
      dataStatus === 'PRELIMINARY' ? [y, m, dataStatus, snapshotDate] : [y, m, dataStatus, null],
    );

    const daily = await sql.query(
      `SELECT COUNT(*)::int AS rows, COALESCE(SUM(units),0)::bigint AS units
       FROM public.rvm_market_daily_v01 WHERE year=$1 AND month=$2`,
      [y, m],
    );
    const monthly = await sql.query(
      `SELECT COUNT(*)::int AS rows, COALESCE(SUM(units),0)::bigint AS units
       FROM public.rvm_market_monthly_v01
       WHERE year=$1 AND month=$2 AND data_status=$3
         AND ($3<>'PRELIMINARY' OR snapshot_date=$4::date)`,
      [y, m, dataStatus, snapshotDate],
    );
    if (Number(daily[0].units) !== Number(source[0].units)) {
      throw new Error(`RVM daily aggregate mismatch: expected ${source[0].units} units, got ${daily[0].units}`);
    }
    if (Number(monthly[0].units) !== Number(source[0].units)) {
      throw new Error(`RVM monthly aggregate mismatch: expected ${source[0].units} units, got ${monthly[0].units}`);
    }
    if (dataStatus === 'PRELIMINARY') {
      const historyAfter = await sql.query(
        `SELECT COUNT(*)::int AS rows FROM public.rvm_market_monthly_v01
         WHERE year=$1 AND month=$2 AND data_status='PRELIMINARY'
           AND snapshot_date IS DISTINCT FROM $3::date`,
        [y, m, snapshotDate],
      );
      if (Number(historyAfter[0].rows) !== Number(historyBefore[0].rows)) {
        throw new Error('Historical RVM preliminary aggregate snapshots changed');
      }
    }

    await sql.query('COMMIT');
    return {
      daily_rows: Number(daily[0].rows),
      daily_units: Number(daily[0].units),
      monthly_rows: Number(monthly[0].rows),
      monthly_units: Number(monthly[0].units),
      historical_preliminary_rows_preserved: historyBefore ? Number(historyBefore[0].rows) : undefined,
    };
  } catch (error) {
    await sql.query('ROLLBACK');
    throw error;
  }
}
