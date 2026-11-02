import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRvmWorkbooks, downloadRvmWorkbook } from '../src/loaders/rvm/source-io.js';

test('RVM lists Excel files in Azure Blob without reading R2', async () => {
  const container = {
    containerName: 'cidef',
    async *listBlobsFlat({ prefix }) {
      assert.equal(prefix, 'RVM/');
      yield { name: 'RVM/data2026.xlsx', properties: { etag: '"v1"', contentLength: 5, lastModified: new Date('2026-11-01') } };
      yield { name: 'RVM/notes.txt', properties: { etag: '"v2"', contentLength: 5 } };
    },
  };
  assert.deepEqual((await listRvmWorkbooks(container)).map(f => f.name), ['data2026.xlsx']);
});

test('RVM download pins the listed Blob version', async () => {
  const contents = Buffer.from('Excel');
  const container = {
    getBlobClient(key) {
      assert.equal(key, 'RVM/data2026.xlsx');
      return { async downloadToBuffer(_start, _count, options) {
        assert.equal(options.conditions.ifMatch, '"v1"');
        return contents;
      } };
    },
  };
  const file = { key: 'RVM/data2026.xlsx', etag: '"v1"' };
  assert.equal(await downloadRvmWorkbook(file, container), contents);
  await assert.rejects(downloadRvmWorkbook({ key: '../wrong.xlsx', etag: '"v1"' }, container));
});
