import { azureQuery, closeAzurePool } from '../lib/azure-postgres.js';

try {
  const rows = await azureQuery(`
    SELECT snapshot_date::text AS snapshot_date, source_type, count(*)::int AS rows
    FROM public.forum_funnel_raw
    WHERE load_kind = 'DAILY_SNAPSHOT'
    GROUP BY snapshot_date, source_type
    ORDER BY snapshot_date, source_type
  `);
  process.stdout.write(JSON.stringify(rows));
} finally {
  await closeAzurePool();
}
