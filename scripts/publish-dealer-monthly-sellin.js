import { fetchDataSource, observeDataSource } from '../lib/data-floor/registry.js';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';

const year = Number(process.env.SELLIN_YEAR || '2026');
if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('INVALID_YEAR');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const from = year + '-01-01';
const to = year === Number(today.slice(0, 4)) ? today : year < Number(today.slice(0, 4)) ? year + '-12-31' : null;
if (!to) throw new Error('FUTURE_YEAR_NOT_ALLOWED');
const filters = { commercial_universe: 'DEALERS', date_from: from, date_to: to };

try {
  const evidence = await observeDataSource('SALES', { measure: 'VIN_SALES', filters });
  if (evidence.authority !== 'P1_CERTIFIED' || evidence.status !== 'CERTIFIED' || !evidence.evidence_id)
    throw new Error('SALES_P1_NOT_CERTIFIED');
  const fetched = await fetchDataSource('SALES', {
    filters, fields: ['sale_date', 'brand_id', 'dealer_group_id', 'vin'],
  });
  const rows = fetched.rows;
  if (!Array.isArray(rows) || !fetched.quality?.validation?.valid || evidence.payload?.value !== rows.length)
    throw new Error('SALES_P1_RECONCILIATION_FAILED');

  const groups = new Map();
  for (const sale of rows) {
    const month = String(sale.sale_date || '').slice(0, 7);
    if (!new RegExp('^' + year + '-(0[1-9]|1[0-2])$').test(month)) throw new Error('INVALID_SALE_MONTH');
    const brand = String(sale.brand_id);
    if (brand !== '89' && brand !== '71') throw new Error('UNRECOGNIZED_BRAND_' + brand);
    // 0 keeps unresolved dealer sales explicit, rather than silently losing units.
    const dealer = sale.dealer_group_id == null ? 0 : Number(sale.dealer_group_id);
    if (!Number.isSafeInteger(dealer) || dealer < 0) throw new Error('INVALID_DEALER_GROUP');
    const key = month + '|' + dealer;
    if (!groups.has(key)) groups.set(key, { month, dealer, foton: 0, dongfeng: 0 });
    groups.get(key)[brand === '89' ? 'foton' : 'dongfeng']++;
  }
  if ([...groups.values()].reduce((n, r) => n + r.foton + r.dongfeng, 0) !== rows.length)
    throw new Error('SNAPSHOT_TOTAL_MISMATCH');

  const client = await getAzurePool().connect();
  try {
    await client.query('BEGIN');
    // A year is replaced atomically; corrected historical months are included.
    await client.query('DELETE FROM dealer_monthly_sellin_snapshots WHERE period >= $1 AND period <= $2', [year + '-01', year + '-12']);
    for (const row of groups.values()) {
      await client.query(
        `INSERT INTO dealer_monthly_sellin_snapshots
          (period, dealer_group_id, foton_units, dongfeng_units, cutoff_date, sales_evidence_id)
          VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.month, row.dealer, row.foton, row.dongfeng, to, evidence.evidence_id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ year, cutoff: to, certified: true, sales: rows.length, snapshot_rows: groups.size, evidence_id: evidence.evidence_id }));
} finally {
  await closeAzurePool();
}
