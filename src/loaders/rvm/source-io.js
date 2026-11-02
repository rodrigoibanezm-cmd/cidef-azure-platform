import { BlobServiceClient } from '@azure/storage-blob';

function containerClient() {
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connection) throw new Error('AZURE_STORAGE_CONNECTION_STRING is required');
  const service = BlobServiceClient.fromConnectionString(connection);
  if (new URL(service.url).protocol !== 'https:' ||
      !new URL(service.url).hostname.endsWith('.blob.core.windows.net')) {
    throw new Error('RVM requires HTTPS Azure Blob Storage');
  }
  return service.getContainerClient(process.env.AZURE_CONTAINER || 'cidef');
}

const SOURCE_PREFIX = 'RVM/';

export async function listRvmWorkbooks(container = containerClient()) {
  const files = [];
  for await (const blob of container.listBlobsFlat({ prefix: SOURCE_PREFIX })) {
    const name = blob.name.split('/').at(-1);
    if (!/\.xlsx?$/i.test(name) || !blob.properties.etag || !blob.properties.contentLength) continue;
    files.push({
      key: blob.name, name,
      etag: blob.properties.etag,
      size: blob.properties.contentLength,
      modifiedTime: blob.properties.lastModified?.toISOString() ?? null,
      createdTime: blob.properties.createdOn?.toISOString() ?? null,
      provider: 'azure-blob',
      container: container.containerName,
    });
  }
  return files.sort((a, b) => Date.parse(b.modifiedTime || 0) - Date.parse(a.modifiedTime || 0));
}

export async function downloadRvmWorkbook(file, container = containerClient()) {
  if (!file?.key?.startsWith(SOURCE_PREFIX) || !file.etag ||
      !/\.xlsx?$/i.test(file.key) || file.key.includes('..')) {
    throw new Error('Invalid RVM workbook descriptor');
  }
  return container.getBlobClient(file.key).downloadToBuffer(undefined, undefined, {
    conditions: { ifMatch: file.etag },
  });
}
