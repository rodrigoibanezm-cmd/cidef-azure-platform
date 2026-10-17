import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { queryDb } from '../lib/neon.js';
import { closeAzurePool, getAzurePool } from '../lib/azure-postgres.js';

if (!process.env.AZURE_DATABASE_URL) {
  throw new Error('Missing required secret: AZURE_DATABASE_URL in GitHub Environment Production.');
}

const [adapterSource, postgresSource] = await Promise.all([
  readFile(new URL('../lib/neon.js', import.meta.url), 'utf8'),
  readFile(new URL('../lib/azure-postgres.js', import.meta.url), 'utf8'),
]);

assert.match(adapterSource, /from ['"]\.\/azure-postgres\.js['"]/);
assert.match(postgresSource, /process\.env\.AZURE_DATABASE_URL/);
for (const source of [adapterSource, postgresSource]) {
  assert.doesNotMatch(source, /NEON_DATABASE_URL|@neondatabase\/serverless|neon\.tech/i);
}

let transactionRolledBack = false;
try {
  const rows = await queryDb('SELECT 1 AS value');
  assert.equal(Number(rows[0]?.value), 1);

  const client = await getAzurePool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(
      "SELECT current_setting('transaction_read_only') AS read_only, 1 AS value",
    );
    assert.equal(result.rows[0]?.read_only, 'on');
    assert.equal(Number(result.rows[0]?.value), 1);
    await client.query('ROLLBACK');
    transactionRolledBack = true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  assert.equal(transactionRolledBack, true);
  console.log(JSON.stringify({
    connection: 'PASS',
    adapter: 'lib/neon.js -> lib/azure-postgres.js',
    select_1: 'PASS',
    read_only_transaction: 'PASS',
    rollback: 'PASS',
    neon_connection_or_fallback: 'NONE',
  }));
} finally {
  await closeAzurePool();
}
