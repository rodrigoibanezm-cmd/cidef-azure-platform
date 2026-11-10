import { readFile } from 'node:fs/promises';
import { BlobServiceClient } from '@azure/storage-blob';
import { parseAnacRvmJson } from '../lib/rvm/anac-json.js';

async function main() {
  const file = process.argv[2];
  if (!file) throw Error('Provide local .json file path or Azure Blob key');
  let bytes;
  if (file.startsWith('RVM/anac/')) {
    const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connection) throw Error('Missing AZURE_STORAGE_CONNECTION_STRING');
    const container = BlobServiceClient.fromConnectionString(connection)
      .getContainerClient(process.env.AZURE_CONTAINER || 'cidef');
    bytes = await container.getBlobClient(file).downloadToBuffer();
  } else {
    bytes = await readFile(file);
  }
  const data = parseAnacRvmJson(JSON.parse(bytes.toString('utf8')));
  console.log(JSON.stringify({ event: 'ANAC_RVM_PREVIEW', year: data.year,
    month: data.month, snapshot_date: data.snapshot_date,
    source_count: data.source_count, rows_to_load: data.rows.length,
    excluded_other_markets: data.excluded_other_markets,
    quantity: data.rows.reduce((n, r) => n + r.cantidad, 0),
    database_writes: 0 }));
}
main().catch(e => { console.error(JSON.stringify({ event: 'ANAC_RVM_PREVIEW_FAILED',
  message: e.message })); process.exitCode = 1; });
