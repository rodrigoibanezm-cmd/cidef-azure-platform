import { azureQuery } from '../azure-postgres.js';

// Materialized once per SALES/RVM canonical refresh, never recomputed by an MCP request.
export async function refreshDealerSellout(execute = azureQuery) {
  await execute(`CREATE TABLE IF NOT EXISTS public.dealer_monthly_sellout_snapshots (
    period text NOT NULL, dealer_group_id bigint NOT NULL,
    brand text NOT NULL, vin_count integer NOT NULL,
    refreshed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (period, dealer_group_id, brand)
  )`);
  await execute(`DELETE FROM public.dealer_monthly_sellout_snapshots`);
  const rows = await execute(`
    INSERT INTO public.dealer_monthly_sellout_snapshots
      (period, dealer_group_id, brand, vin_count, refreshed_at)
    SELECT to_char(fecha_inscripcion_rvm, 'YYYY-MM'),
      coalesce(dealer_group_id, 0),
      CASE
        WHEN upper(btrim(marca_raw)) LIKE 'FOTON%' THEN 'FOTON'
        WHEN upper(btrim(marca_raw)) IN ('DFM','DFLM','DONGFENG','DONG FENG') THEN 'DONGFENG'
        ELSE 'UNRESOLVED'
      END,
      count(DISTINCT vin)::int, now()
    FROM public.vehiculo_canonico
    WHERE fecha_inscripcion_rvm IS NOT NULL AND canal_salida = 'DEALER' AND vendido = true
    GROUP BY 1,2,3
    RETURNING vin_count
  `);
  return { snapshots: rows.length, vins: rows.reduce((sum, row) => sum + Number(row.vin_count), 0) };
}
