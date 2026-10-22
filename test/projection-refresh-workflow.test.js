import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const yaml = readFileSync(new URL('../.github/workflows/refresh-inteligencia-comercial-staging.yml', import.meta.url), 'utf8');
const script = yaml.split("<<'NODE'\n")[1].split('\n          NODE')[0].replace(/^\s*import .+?;$/gm, '');
const source = { status: 'READY', generation_id: 'certified-sales-1', source_signature: 'sig-1', sales_cutoff: '2026-10-21', forum_cutoff: '2026-10-20' };
const state = extra => ({ ok: true, environment: 'staging', week_start: '2026-10-19', cutoff_date: '2026-10-22', snapshot_version: 'v1', source_state: source, ...extra });
const complete = state({ status: 'completed', job_id: 'new-job', sources: source, version: 'v1' });

async function run(states) {
  const requests = [], summaries = [];
  class Exit extends Error { constructor(code) { super('exit'); this.code = code; } }
  const context = { AbortSignal, Date, URL, encodeURIComponent,
    process: { env: { BASE_URL: 'https://cidef-intel-comercial-staging.calmforest-1c67ab46.chilecentral.azurecontainerapps.io' }, exit: code => { throw new Exit(code); } },
    console: { log: text => summaries.push(text) }, appendFile: async () => {}, setTimeout: cb => queueMicrotask(cb),
    fetch: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET' });
      const value = options.method === 'POST' ? { ok: true } : url.includes('status=1') ? states.shift() : {
        ok: true, storeSales: [{ sucursal_id: '1' }], snapshot: { generation_id: 'snapshot-1' },
        admin: { projections: [], sent_not_invoiced: [] },
      };
      if (!value) throw new Error('Unexpected request');
      return { ok: true, status: 200, json: async () => value };
    },
  };
  try { await vm.runInNewContext(`(async()=>{${script}\n})()`, context); }
  catch (error) { if (!(error instanceof Exit && error.code === 0)) throw error; }
  return { requests, summaries };
}

test('unready source and already processed source never call the generator', async () => {
  for (const input of [state({ status: 'idle', source_state: { status: 'BUILDING' } }), complete, state({ status: 'running' })]) {
    const result = await run([input]);
    assert.equal(result.requests.filter(r => r.method === 'POST').length, 0);
  }
});
test('new SALES publication and expired lease each call the existing generator once', async () => {
  for (const status of ['idle', 'expired']) {
    const result = await run([state({ status }), complete]);
    assert.equal(result.requests.filter(r => r.method === 'POST').length, 1);
    assert.equal(result.requests.filter(r => !r.url.includes('status=1') && r.method === 'GET').length, 3);
    assert.ok(result.summaries.some(line => line.includes('company → store → company')));
  }
});
test('new FORUM publication is processed even after an earlier SALES completion', async () => {
  const forum = { ...source, generation_id: 'certified-forum-2', source_signature: 'sig-2' };
  const result = await run([state({ ...complete, job_id: 'old-sales-job', source_state: forum }), state({ ...complete, job_id: 'forum-job', sources: forum, source_state: forum })]);
  assert.equal(result.requests.filter(r => r.method === 'POST').length, 1);
});
test('generation failure fails the Action instead of reporting success', async () => {
  await assert.rejects(run([state({ status: 'idle' }), state({ status: 'failed', job_id: 'new-job', error: 'MOTOR_FAILED' })]), /MOTOR_FAILED/);
});

test('deployment pending never calls the older generator API', async () => {
  const result = await run([state({ status: 'idle', snapshot_version: undefined })]);
  assert.equal(result.requests.filter(r => r.method === 'POST').length, 0);
  assert.ok(result.summaries.some(line => line.includes('deployment pending')));
});
