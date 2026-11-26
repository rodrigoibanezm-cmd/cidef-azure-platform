import { AsyncLocalStorage } from 'node:async_hooks';
import { BlobServiceClient } from '@azure/storage-blob';

const context = new AsyncLocalStorage();
export const SOURCE_PREFIXES = [
  'ventas/Base_Unidades_por_Vistas_',
  'ventas/Estadisticas_de_Venta_por_Vista_',
  'ventas/Listado_Notas_de_Venta_',
  'ventas/NC_DFM_',
];

export function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date + 'T00:00:00Z'))
    && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
}

export function sourceContext() {
  const value = context.getStore();
  if (!value) throw new Error('SALES source context is required');
  return value;
}
export function withSourceContext(value, callback) { return context.run(value, callback); }

export function createContainer() {
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connection) throw new Error('AZURE_STORAGE_CONNECTION_STRING is required');
  const service = BlobServiceClient.fromConnectionString(connection);
  if (!service.url.startsWith('https://') || !new URL(service.url).hostname.endsWith('.blob.core.windows.net')) {
    throw new Error('An HTTPS Azure Blob Storage endpoint is required');
  }
  return service.getContainerClient(process.env.AZURE_CONTAINER || 'cidef');
}

export async function inspectDay(container, date) {
  if (!validDate(date)) throw new Error('Source date must be valid YYYY-MM-DD');
  const files = [];
  for (const prefix of SOURCE_PREFIXES) {
    const key = prefix + date.replaceAll('-', '_') + '.xlsx';
    const properties = await container.getBlobClient(key).getProperties();
    if (!properties.etag || !properties.contentLength) throw new Error('Empty/unversioned SALES source: ' + key);
    files.push({ Key: key, ETag: properties.etag, LastModified: properties.lastModified,
      size: properties.contentLength, prefix });
  }
  // Include every additional daily credit-note workbook available in the same
  // SALES batch. The baseline NC_DFM_ source remains mandatory above.
  if (typeof container.listBlobsFlat === 'function') {
    const dateSuffix = date.replaceAll('-', '_') + '.xlsx';
    for await (const blob of container.listBlobsFlat({ prefix: 'ventas/NC_' })) {
      if (!blob.name.startsWith('ventas/NC_') || !blob.name.endsWith(dateSuffix) ||
          !/^ventas\/NC_[A-Za-z0-9_-]+_\d{4}_\d{2}_\d{2}\.xlsx$/i.test(blob.name) ||
          files.some(file => file.Key === blob.name)) continue;
      const properties = await container.getBlobClient(blob.name).getProperties();
      if (!properties.etag || !properties.contentLength)
        throw new Error('Empty/unversioned SALES credit-note source: ' + blob.name);
      files.push({ Key: blob.name, ETag: properties.etag,
        LastModified: properties.lastModified, size: properties.contentLength,
        prefix: blob.name.slice(0, -dateSuffix.length) });
    }
  }
  return files.sort((a,b) => a.Key.localeCompare(b.Key));
}

export async function findDailyXlsx(prefix) {
  const file = sourceContext().files.find(item => item.prefix === prefix);
  if (!file) throw new Error('Missing preflighted daily SALES source: ' + prefix);
  return file;
}

export async function downloadBlobObject(key) {
  const { container, files } = sourceContext();
  const file = files.find(item => item.Key === key);
  if (!file) throw new Error('Source outside requested SALES batch');
  return container.getBlobClient(key).downloadToBuffer(undefined, undefined, {
    conditions: { ifMatch: file.ETag },
  });
}

export function blobSource(file) {
  return { provider: 'azure-blob', container: sourceContext().container.containerName,
    key: file.Key, etag: file.ETag, lastModified: file.LastModified, size: file.size };
}
