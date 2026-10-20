import pg from 'pg';

const { Pool } = pg;
let pool;

export function getAzurePool() {
  if (pool) return pool;
  const connectionString = process.env.AZURE_DATABASE_URL;
  if (!connectionString) throw new Error('Missing required environment variable: AZURE_DATABASE_URL');
  pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

export function azureCompatibleSql(statement) {
  let output = '';
  let cursor = 0;
  const calls = /\bmaster_norm\s*\(/gi;
  let match;
  while ((match = calls.exec(statement)) !== null) {
    const open = match.index + match[0].lastIndexOf('(');
    let depth = 1;
    let quote = null;
    let close = open + 1;

    for (; close < statement.length && depth > 0; close++) {
      const char = statement[close];
      if (quote) {
        if (char === quote) {
          if (statement[close + 1] === quote) close++;
          else quote = null;
        } else if (char === '\\' && quote === "'" && close + 1 < statement.length) {
          close++;
        }
        continue;
      }
      if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
    }

    if (depth !== 0) throw new Error('Unbalanced master_norm SQL expression');
    const expression = statement.slice(open + 1, close - 1);
    output += statement.slice(cursor, match.index);
    output += `NULLIF(regexp_replace(upper(trim(replace(${expression}, chr(160), ' '))), '\\\\s+', ' ', 'g'), '')`;
    cursor = close;
    calls.lastIndex = close;
  }
  return output ? output + statement.slice(cursor) : statement;
}

export async function azureQuery(text, params = []) {
  return (await getAzurePool().query(azureCompatibleSql(text), params)).rows;
}

// Runs a single query with a transaction-local statement timeout; the pool default is 120 seconds.
export async function azureQueryWithTimeout(text, params = [], timeoutMs = 120000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid statement timeout');
  }

  const client = await getAzurePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('statement_timeout', $1, true)",
      [String(timeoutMs) + 'ms'],
    );
    const result = await client.query(azureCompatibleSql(text), params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Keep the original query error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAzurePool() {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
