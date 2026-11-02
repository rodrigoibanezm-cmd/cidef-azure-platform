import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';
import * as XLSX from 'xlsx';
import { getAzurePool, closeAzurePool } from '../lib/azure-postgres.js';

const CONTAINER = 'cidef';
const SOURCE = 'finanzas/VIN VEND 10-26.xlsx';
const PERIOD = '2026-10';

export async function refreshFinanzas() {
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connection) throw new Error('Missing AZURE_STORAGE_CONNECTION_STRING');
  const service = BlobServiceClient.fromConnectionString(connection);
  if (!new URL(service.url).hostname.endsWith('.blob.core.windows.net')) throw new Error('Azure Blob endpoint required');
  const blob = service.getContainerClient(CONTAINER).getBlobClient(SOURCE);
  const props = await blob.getProperties();
  if (!props.etag || !props.contentLength) throw new Error('Empty or unversioned Finanzas file');
  const bytes = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: props.etag } });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const book = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellFormula: true });
  const sheets = book.SheetNames.map(name => {
    const sheet = book.Sheets[name];
    const cells = Object.entries(sheet).filter(([address]) => !address.startsWith('!'))
      .map(([address, cell]) => ({ address, type: cell.t ?? null, value: cell.v ?? null,
        formula: cell.f ?? null, format: cell.z ?? null, text: cell.w ?? null }));
    return { name, range: sheet['!ref'] ?? null, cells };
  });
  const pool = getAzurePool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = await readFile(new URL('../scripts/sql/finanzas-cierre-mensual.sql', import.meta.url), 'utf8');
    await client.query(schema);
    const old = await client.query('SELECT sha256 FROM finanzas_cierre_archivos WHERE periodo=$1 FOR UPDATE', [PERIOD]);
    if (old.rows[0]?.sha256 === sha256) {
      await client.query('COMMIT');
      return { status: 'ALREADY_LOADED', period: PERIOD, sha256, sheets: sheets.length };
    }
    await client.query(`INSERT INTO finanzas_cierre_archivos(periodo,blob_path,blob_etag,sha256,archivo_bytes,hojas,actualizado_en)
      VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(periodo) DO UPDATE SET
      blob_path=EXCLUDED.blob_path,blob_etag=EXCLUDED.blob_etag,sha256=EXCLUDED.sha256,
      archivo_bytes=EXCLUDED.archivo_bytes,hojas=EXCLUDED.hojas,actualizado_en=now()`,
      [PERIOD,SOURCE,props.etag,sha256,bytes.length,sheets.length]);
    await client.query('DELETE FROM finanzas_cierre_hojas WHERE periodo=$1', [PERIOD]);
    for (let i=0; i<sheets.length; i++) {
      const s = sheets[i];
      await client.query(`INSERT INTO finanzas_cierre_hojas(periodo,orden_hoja,nombre_hoja,rango,celdas)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [PERIOD,i+1,s.name,s.range,JSON.stringify(s.cells)]);
    }
    await client.query('COMMIT');
    return { status: 'LOADED', period: PERIOD, sha256, sheets: sheets.length,
      cells: sheets.reduce((sum,s)=>sum+s.cells.length,0) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshFinanzas().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(JSON.stringify({ status: 'FAILED', code: error.code || error.name })); process.exitCode=1; })
    .finally(() => closeAzurePool());
}
