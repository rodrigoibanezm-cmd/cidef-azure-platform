import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getP3Run } from '../lib/p3/executionJournal.js';

const period = process.env.COMO_VAMOS_VALIDATION_PERIOD
  || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }).slice(0, 7);
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
const port = await unusedPort();
const endpoint = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [fileURLToPath(new URL('../motor-test-azure/server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(port), MCP_AUTH_MODE: 'local-test', NODE_ENV: 'test' },
  stdio: 'ignore',
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error('Cómo vamos API test server exited before health check');
    try {
      const response = await fetch(endpoint + '/healthz', { signal: AbortSignal.timeout(3000) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, 'Cómo vamos API test server did not become ready');
  const response = await fetch(endpoint + '/api/como-vamos?period=' + encodeURIComponent(period), { cache: 'no-store' });
  assert.equal(response.status, 200, await response.text());
  const payload = await response.json();
  assert.equal(payload.period, period);
  assert.match(payload.run_id, /^como-vamos-/);
  assert.equal(payload.indicators.length, 6);
  const ids = new Set(payload.indicators.map(item => item.id));
  for (const id of ['sales', 'quotations', 'precurse', 'ufis', 'rvm_units', 'rvm_share']) assert.ok(ids.has(id), 'Missing indicator ' + id);
  const precurse = payload.indicators.find(item => item.id === 'precurse');
  assert.deepEqual(precurse.series, [], 'PRECURSE must remain a latest-snapshot stock without period series');
  for (const item of payload.indicators.filter(item => item.certified)) {
    assert.ok(item.cutoff, item.id + ' lacks its certified cutoff');
    assert.ok(item.evidence_id, item.id + ' lacks an evidence reference');
    assert.ok(item.evidence_ids?.length, item.id + ' lacks evidence IDs');
  }
  const traced = await getP3Run(payload.run_id);
  assert.ok(traced, 'API run_id was not recorded in P3');
  const events = traced.events ?? [];
  assert.ok(events.some(event => event.floor === 'P1' && event.status === 'SUCCESS'), 'P3 has no successful P1 events');
  const share = payload.indicators.find(item => item.id === 'rvm_share');
  if (share.certified) {
    assert.equal(share.certification?.authority, 'P2_EXECUTED');
    assert.ok(events.some(event => event.floor === 'P2' && event.tool_name === 'p2_execute' && event.output_json?.status === 'EXECUTED'), 'RVM share has no successful P2 trace');
  }
  console.log(JSON.stringify({
    status: 'PASS',
    database: 'AZURE_POSTGRESQL',
    period,
    run_id: payload.run_id,
    indicators: payload.indicators.map(({ id, status, certified, cutoff, evidence_ids, limitations }) => ({ id, status, certified, cutoff, evidence_count: evidence_ids?.length ?? 0, limitations })),
    p3_p1_events: events.filter(event => event.floor === 'P1').length,
    p3_p2_events: events.filter(event => event.floor === 'P2').length,
    rvm_share: share.status,
    neon_connection_or_fallback: 'NONE',
  }));
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
