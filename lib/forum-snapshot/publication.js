export async function replaceSnapshot(client, rows, generationId, { beforeCommit } = {}) {
  if (!rows.length || rows.some(r=>!r.payload || !r.sales_cutoff || !r.forum_cutoff)) throw new Error('INCOMPLETE_SNAPSHOT');
  await client.query('BEGIN');
  try {
    for (const row of rows) {
      await client.query(`INSERT INTO public.forum_ventas_snapshot_v01 (period,network,dimension,payload,sales_cutoff,forum_cutoff,generation_id)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT (period,network,dimension) DO UPDATE SET
        payload=excluded.payload,sales_cutoff=excluded.sales_cutoff,forum_cutoff=excluded.forum_cutoff,generation_id=excluded.generation_id,updated_at=now()`,
        [row.period,row.network,row.dimension,JSON.stringify(row.payload),row.sales_cutoff,row.forum_cutoff,generationId]);
    }
    await beforeCommit?.();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
