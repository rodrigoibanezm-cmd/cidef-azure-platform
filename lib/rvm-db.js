import { AsyncLocalStorage } from 'node:async_hooks';
import { getAzurePool, closeAzurePool } from './azure-postgres.js';

const transaction = new AsyncLocalStorage();
export function rvmDb() {
  const url = process.env.AZURE_DATABASE_URL;
  if (!url || new URL(url).hostname !== 'cidef-postgres-prod.postgres.database.azure.com') {
    throw new Error('RVM requires Azure PostgreSQL; no Neon fallback');
  }
  return {
    query: async (sql, params = []) => (await (transaction.getStore() || getAzurePool()).query(sql, params)).rows,
    transaction: async (statements) => withAzureTransaction(async () => {
      const result = [];
      for (const statement of statements) result.push(await rvmDb().query(statement));
      return result;
    }),
  };
}
export async function withAzureTransaction(work) {
  if (transaction.getStore()) throw new Error('Nested RVM transaction');
  rvmDb();
  const client = await getAzurePool().connect();
  try {
    await client.query('BEGIN');
    return await transaction.run(client, async () => {
      const result = await work();
      await client.query('COMMIT');
      return result;
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export const closeRvmDb = closeAzurePool;
