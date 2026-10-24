import { randomUUID } from 'node:crypto';
import { azureCompatibleSql } from '../../../lib/azure-postgres.js';
import { sourceContext } from './source-io.js';

const RAW_TABLES = new Set(['vehiculos_raw', 'ventas_raw', 'notas_venta_raw', 'notas_credito_raw']);
export const quoteIdent = value => '"' + String(value).replaceAll('"', '""') + '"';

export async function queryDb(sql, params = []) {
  // Never retry individual statements inside a transaction (especially append-only inserts).
  return (await sourceContext().client.query(azureCompatibleSql(sql), params)).rows;
}

async function columns(table) {
  return queryDb(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY a.attnum`, ['public.' + table]);
}

export async function beginTableSnapshot(tableName, names) {
  if (!RAW_TABLES.has(tableName) || !names.length) throw new Error('Invalid SALES RAW target/columns');
  const staging = tableName + '__loading_' + randomUUID().replaceAll('-', '');
  await queryDb(`CREATE TABLE ${quoteIdent(staging)} (${names.map(n => quoteIdent(n) + ' text').join(',')})`);
  return { tableName, staging, columns: names };
}

export async function appendTableRows(snapshot, rows) {
  const batchSize = Math.max(1, Math.min(500, Math.floor(8000 / snapshot.columns.length)));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = batch.flat();
    const tuples = batch.map((row, i) => '(' + row.map((_, j) => '$' + (i * snapshot.columns.length + j + 1)).join(',') + ')');
    await queryDb(`INSERT INTO ${quoteIdent(snapshot.staging)} (${snapshot.columns.map(quoteIdent).join(',')}) VALUES ${tuples.join(',')}`, values);
  }
  return { rowsLoaded: rows.length, batchSize };
}

export async function commitTableSnapshot(snapshot) {
  const target = await columns(snapshot.tableName);
  const stage = await columns(snapshot.staging);
  if (!target.length) throw new Error('Required Azure RAW table missing: ' + snapshot.tableName);
  const types = new Map(target.map(c => [c.name, c.type]));
  const missing = stage.filter(c => !types.has(c.name));
  if (missing.length) throw new Error('Azure RAW schema mismatch: ' + missing.map(c => c.name).join(','));
  const names = stage.map(c => c.name);
  // Preserve table identity, grants, indexes, defaults, and referencing views.
  await queryDb(`DELETE FROM public.${quoteIdent(snapshot.tableName)}`);
  await queryDb(`INSERT INTO public.${quoteIdent(snapshot.tableName)} (${names.map(quoteIdent).join(',')})
    SELECT ${names.map(n => `${quoteIdent(n)}::${types.get(n)}`).join(',')} FROM ${quoteIdent(snapshot.staging)}`);
  await queryDb(`DROP TABLE ${quoteIdent(snapshot.staging)}`);
}

export async function abortTableSnapshot() {
  // The daily transaction owns staging lifecycle. Its rollback removes staging too.
}

export async function replaceTableSnapshot(tableName, names, rows) {
  if (!rows.length) throw new Error('Empty SALES snapshot blocked: ' + tableName);
  const snapshot = await beginTableSnapshot(tableName, names);
  const result = await appendTableRows(snapshot, rows);
  await commitTableSnapshot(snapshot);
  return result;
}

export async function appendTableData(tableName, names, rows) {
  if (tableName !== 'notas_credito_raw') throw new Error('Only credit notes permit historical append');
  const target = await columns(tableName);
  const types = new Map(target.map(c => [c.name, c.type]));
  if (!target.length || names.some(n => !types.has(n))) throw new Error('Credit-note RAW schema mismatch');
  const batchSize = Math.max(1, Math.min(500, Math.floor(8000 / names.length)));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const tuples = batch.map((row, i) => '(' + row.map((_, j) => '$' + (i * names.length + j + 1) + '::' + types.get(names[j])).join(',') + ')');
    await queryDb(`INSERT INTO public.${quoteIdent(tableName)} (${names.map(quoteIdent).join(',')}) VALUES ${tuples.join(',')}`, batch.flat());
  }
  return { rowsLoaded: rows.length, batchSize };
}
