import { azureCompatibleSql, azureQuery, getAzurePool } from './azure-postgres.js';

function db() {
  return { query: queryDb };
}

export async function queryDb(query, params = []) {
  return runWithRetry(() => azureQuery(query, params));
}

export async function queryDbTransaction(statements) {
  return runWithRetry(async () => {
    const client = await getAzurePool().connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const statement of statements) {
        results.push((await client.query(azureCompatibleSql(statement))).rows);
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function stagingName(tableName) {
  return `${tableName}__loading_${Date.now()}`;
}

async function runWithRetry(fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

async function insertRows(sql, tableName, columns, rows) {
  const columnList = columns.map(quoteIdent).join(', ');
  const maxParams = 8000;
  const batchSize = Math.max(1, Math.min(50, Math.floor(maxParams / columns.length)));

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    let param = 1;
    const tuples = batch.map((row) => `(${row.map((value) => {
      values.push(value);
      return `$${param++}`;
    }).join(', ')})`);
    const query = `INSERT INTO ${quoteIdent(tableName)} (${columnList}) VALUES ${tuples.join(', ')}`;
    try {
      await runWithRetry(() => sql.query(query, values));
    } catch (error) {
      throw new Error(`Database request failed at row ${offset + 1} (batch=${batchSize}, columns=${columns.length}, params=${values.length}): ${error.message}`);
    }
  }
  return { rowsLoaded: rows.length, batchSize };
}

export async function beginTableSnapshot(tableName, columns) {
  if (!columns.length) throw new Error('No columns to load');
  const sql = db();
  const staging = stagingName(tableName);
  const columnSql = columns.map((name) => `${quoteIdent(name)} TEXT`).join(', ');
  await sql.query(`CREATE TABLE ${quoteIdent(staging)} (${columnSql})`);
  return { tableName, staging, columns };
}

export async function appendTableRows(snapshot, rows) {
  const { staging, columns } = snapshot;
  return insertRows(db(), staging, columns, rows);
}

export async function appendTableData(tableName, columns, rows) {
  if (!columns.length) throw new Error('No columns to load');
  const sql = db();
  const existing = await sql.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName],
  );

  if (!existing.length) {
    const columnSql = columns.map((name) => `${quoteIdent(name)} TEXT`).join(', ');
    await sql.query(`CREATE TABLE ${quoteIdent(tableName)} (${columnSql})`);
  } else {
    const current = existing.map((row) => row.column_name);
    const missing = columns.filter((column) => !current.includes(column));
    const extra = current.filter((column) => !columns.includes(column));
    if (missing.length || extra.length) {
      throw new Error(`Append schema mismatch for ${tableName}: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
    }
  }

  const result = await insertRows(sql, tableName, columns, rows);
  return { rowsLoaded: rows.length, columnsLoaded: columns.length, table: tableName, batchSize: result.batchSize };
}

export async function commitTableSnapshot(snapshot) {
  const sql = db();
  await sql.query(`DROP TABLE IF EXISTS ${quoteIdent(snapshot.tableName)}`);
  await sql.query(`ALTER TABLE ${quoteIdent(snapshot.staging)} RENAME TO ${quoteIdent(snapshot.tableName)}`);
}

export async function abortTableSnapshot(snapshot) {
  const sql = db();
  await sql.query(`DROP TABLE IF EXISTS ${quoteIdent(snapshot.staging)}`).catch(() => {});
}

export async function replaceTableSnapshot(tableName, columns, rows) {
  const snapshot = await beginTableSnapshot(tableName, columns);
  try {
    const result = await appendTableRows(snapshot, rows);
    await commitTableSnapshot(snapshot);
    return { rowsLoaded: rows.length, columnsLoaded: columns.length, table: tableName, batchSize: result.batchSize };
  } catch (error) {
    await abortTableSnapshot(snapshot);
    throw error;
  }
}
