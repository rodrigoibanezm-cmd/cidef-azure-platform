import { azureQuery } from '../azure-postgres.js';

export function customGptDb() {
  return { query: azureQuery };
}

export const qi = (value) => `"${String(value).replace(/"/g, '""')}"`;

export async function columnsFor(sql, table) {
  const rows = await sql.query(
    `SELECT column_name, data_type, ordinal_position
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [table],
  );
  if (!rows.length) throw new Error(`Table not found: ${table}`);
  return rows;
}
