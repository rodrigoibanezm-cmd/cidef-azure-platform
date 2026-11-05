import { fetchDataSource, observeDataSource } from '../lib/data-floor/registry.js';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';
import { pathToFileURL } from 'node:url';

// Períodos cerrados: un snapshot se publica una vez y no se sobrescribe.
const months = [];
for (let y = 2025, m = 1; y < 2026 || m <= 10; m++) {
  if (m === 13) { y++; m = 1; }
  months.push(`${y}-${String(m).padStart(2, '0')}`);
}
export async function publishDealerMonth(period, { mutable = false, cutoffDate } = {}) {
  const client = await getAzurePool().connect();
  try {
    const [y, m] = period.split('-').map(Number);
    const cutoff = cutoffDate || new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const filters = { commercial_universe: 'DEALERS', sales_source: 'SALES',
      date_from: period + '-01', date_to: cutoff };
    const evidence = await observeDataSource('SALES', { measure: 'VIN_SALES', filters });
    const fetched = await fetchDataSource('SALES', {
      filters, fields: ['sale_date', 'dealer_group_id', 'brand_id', 'model_id', 'quantity'],
    });
    if (evidence.status !== 'CERTIFIED' || evidence.authority !== 'P1_CERTIFIED' ||
        !evidence.evidence_id || !fetched.quality?.validation?.valid ||
        fetched.rows.reduce((sum, row) => sum + Number(row.quantity), 0) !== evidence.payload.value) {
      throw new Error('P1_SALES_NOT_RECONCILED: ' + period);
    }
    const groups = new Map();
    for (const sale of fetched.rows) {
      const dealer = sale.dealer_group_id == null ? 0 : Number(sale.dealer_group_id);
      const brand = Number(sale.brand_id), model = Number(sale.model_id);
      if (String(sale.sale_date).slice(0, 7) !== period || !Number.isSafeInteger(dealer) ||
          !Number.isSafeInteger(brand) || !Number.isSafeInteger(model) || model <= 0)
        throw new Error('MODEL_OR_PERIOD_NOT_RESOLVED: ' + period);
      const key = [dealer, brand, model].join('|');
      groups.set(key, (groups.get(key) ?? 0) + Number(sale.quantity));
    }
    await client.query('BEGIN');
    try {
      const previous = await client.query(
        'SELECT 1 FROM dealer_monthly_model_sellin_snapshots WHERE period=$1 LIMIT 1', [period]);
      if (previous.rowCount && !mutable) {
        await client.query('ROLLBACK');
        return { period, status: 'ALREADY_FROZEN' };
      }
      if (mutable) await client.query('DELETE FROM dealer_monthly_model_sellin_snapshots WHERE period=$1', [period]);
      for (const [key, units] of groups) {
        const [dealer, brand, model] = key.split('|').map(Number);
        await client.query(`INSERT INTO dealer_monthly_model_sellin_snapshots
          (period, dealer_group_id, brand_id, model_id, vin_sales, cutoff_date, sales_evidence_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [period, dealer, brand, model, units, cutoff, evidence.evidence_id]);
      }
      await client.query('COMMIT');
      return { period, status: mutable ? 'UPDATED' : 'FROZEN', units: evidence.payload.value, rows: groups.size };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const period of months) console.log(JSON.stringify(await publishDealerMonth(period)));
  } finally { await closeAzurePool(); }
}
