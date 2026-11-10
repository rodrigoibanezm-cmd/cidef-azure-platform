import https from 'node:https';
import { BlobServiceClient } from '@azure/storage-blob';
import { parseArgs } from 'node:util';

const BASE = 'https://gestion.anac.cl:8006';
const MAX_BYTES = 80 * 1024 * 1024;

function options(argv) {
  const { values } = parseArgs({ args: argv, options: {
    kind: { type: 'string' }, year: { type: 'string' }, month: { type: 'string' },
  } });
  if (!['preliminary', 'consolidated'].includes(values.kind)) throw Error('Invalid RVM kind');
  const year = Number(values.year);
  const month = Number(values.month);
  if (!Number.isInteger(year) || year < 2016 || year > 2100) throw Error('Invalid year');
  if (values.kind === 'consolidated' && (!Number.isInteger(month) || month < 1 || month > 12))
    throw Error('Invalid month');
  return { kind: values.kind, year, month };
}

function fetchJson(path) {
  const key = process.env.ANAC_APIKEY;
  const user = process.env.ANAC_USER;
  const password = process.env.ANAC_PASSWORD;
  if (!key || !user || !password) throw Error('Missing ANAC credentials');
  return new Promise((resolve, reject) => {
    const req = https.get(BASE + path, {
      headers: { APIKEY: key, Authorization: 'Basic ' +
        Buffer.from(user + ':' + password).toString('base64'), Accept: 'application/json' },
      timeout: 120000,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) return req.destroy(Error('ANAC JSON exceeds size limit'));
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Error('ANAC HTTP ' + res.statusCode));
        const bytes = Buffer.concat(chunks);
        try { JSON.parse(bytes.toString('utf8')); } catch { return reject(Error('ANAC returned invalid JSON')); }
        resolve(bytes);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('ANAC request timeout')));
    req.on('error', reject);
  });
}

export async function run(argv = process.argv.slice(2)) {
  const { kind, year, month } = options(argv);
  const path = kind === 'preliminary' ? '/anac/rvm/semanal' :
    '/anac/rvm/cierre/' + year + '/' + String(month).padStart(2, '0');
  const bytes = await fetchJson(path);
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connection) throw Error('Missing Azure Blob connection');
  const container = BlobServiceClient.fromConnectionString(connection)
    .getContainerClient(process.env.AZURE_CONTAINER || 'cidef');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = kind === 'preliminary' ? 'semanal' :
    'cierre/' + year + '/' + String(month).padStart(2, '0');
  const blob = 'RVM/anac/' + folder + '/' + timestamp + '.json';
  await container.getBlockBlobClient(blob).uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: 'application/json' },
    conditions: { ifNoneMatch: '*' },
  });
  return { event: 'ANAC_JSON_SAVED', kind, year, month: kind === 'consolidated' ? month : null,
    blob, bytes: bytes.length };
}

if (process.argv[1]?.endsWith('/download-anac-rvm-azure.js')) {
  run().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ event: 'ANAC_DOWNLOAD_FAILED',
      code: error.code || error.message })); process.exitCode = 1; });
}
