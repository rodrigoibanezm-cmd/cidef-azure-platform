import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';

const HOST = '200.12.194.108';
const USER = 'usr_cidef';
const FILE = /^(Cotizacion|Curse|Precurse)_Cidef_(\d{8})\.csv$/;
const TYPES = ['Cotizacion', 'Curse', 'Precurse'];

function sftp(commands, password) {
  return new Promise((resolve, reject) => {
    const child = spawn('sshpass', ['-e', 'sftp', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=no', '-o', 'ConnectTimeout=15', '-P', '22', '-b', '-', USER + '@' + HOST], {
      env: { ...process.env, SSHPASS: password }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) :
      reject(new Error('SFTP failed (exit ' + code + '): ' +
        (stderr.includes('Permission denied') ? 'authentication denied' : 'connection or transfer error'))));
    child.stdin.end(commands.join('\n') + '\n');
  });
}

async function inStage(stage, operation) {
  try { return await operation(); }
  catch (error) { error.stage = stage; throw error; }
}

export async function downloadForumSftp() {
  const password = process.env.FORUM_SFTP_PASSWORD;
  const connection = process.env.AZURE_STORAGE_CONNECTION_STRING;
  assert.ok(password && connection, 'FORUM_SFTP_PASSWORD and AZURE_STORAGE_CONNECTION_STRING required');
  const container = BlobServiceClient.fromConnectionString(connection)
    .getContainerClient(process.env.AZURE_CONTAINER || 'cidef');
  const listing = await inStage('sftp_list', () => sftp(['cd cidef', 'ls -1'], password));
  const remote = [...new Set(listing.split(/\r?\n/).map(s => s.trim())
    .filter(name => FILE.test(name)))].sort();
  const byDate = new Map();
  for (const name of remote) {
    const [, type, date] = name.match(FILE);
    if (!byDate.has(date)) byDate.set(date, new Set());
    byDate.get(date).add(type);
  }
  const ready = remote.filter(name => TYPES.every(type => byDate.get(name.match(FILE)[2]).has(type)));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'forum-sftp-'));
  const downloaded = [], updated = [];
  let pending = 0;
  try {
    for (const name of ready) {
      const destination = path.join(dir, name);
      await inStage('sftp_download', () => sftp(['cd cidef', 'get ' + name + ' ' + destination], password));
      const bytes = await readFile(destination);
      const blob = container.getBlockBlobClient('Forum/' + name);
      let properties;
      try { properties = await inStage('blob_check', () => blob.getProperties()); }
      catch (error) { if (error.statusCode !== 404) throw error; }
      if (!properties) {
        pending++;
        await inStage('blob_upload', () => blob.uploadData(bytes, { conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: 'text/csv' } }));
        downloaded.push(name);
        continue;
      }
      const existing = await inStage('blob_check', () =>
        blob.downloadToBuffer(undefined, undefined, { conditions: { ifMatch: properties.etag } }));
      if (bytes.equals(existing)) continue;
      await inStage('blob_upload', () => blob.uploadData(bytes, { conditions: { ifMatch: properties.etag },
        blobHTTPHeaders: { blobContentType: 'text/csv' } }));
      updated.push(name);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  return { status: 'SFTP_MIRRORED', available: remote.length, pending, downloaded, updated,
    incomplete_dates: [...byDate].filter(([, types]) => types.size !== 3).map(([date]) => date) };
}

if (process.argv[1]?.endsWith('/download-forum-sftp-azure.js')) {
  downloadForumSftp().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({
      status: 'FAILED', stage: error.stage || 'configuration',
      code: error.code || error.name,
      ...(error.statusCode ? { http_status: error.statusCode } : {}),
      ...(error.message?.startsWith('SFTP failed') ? { detail: error.message } : {}),
      ...(error.code === 'ERR_ASSERTION' && error.message === 'FORUM_SFTP_PASSWORD and AZURE_STORAGE_CONNECTION_STRING required'
        ? { missing_env: ['FORUM_SFTP_PASSWORD', 'AZURE_STORAGE_CONNECTION_STRING'].filter(name => !process.env[name]) } : {}),
      ...(error.code === 'ERR_ASSERTION' && /^Empty Forum CSV: (Cotizacion|Curse|Precurse)_Cidef_\d{8}\.csv$/.test(error.message)
        ? { detail: error.message } : {}),
    }));
    process.exitCode = 1;
  });
}
