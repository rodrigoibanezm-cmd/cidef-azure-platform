import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PERIOD = '2026-09', CUTOFF = '2026-09-30', VERSION = '0.1.0';
const STORE_UNIT = 'p2.closed_period_store_performance';
const SALES_UNIT = 'p2.closed_period_sales_performance';
// These are provenance references and validation expectations, never result data.
export const DIMENSIONS = [
  { id: 'STORE', universe: 'OWN_STORES', run: 'closed-performance-sales-stores-20261026', expected: [1, 9, 0, 4] },
  { id: 'SELLER', universe: 'OWN_STORES', run: 'extend-closed-sales-performance-20261027', expected: [4, 12, 0, 53] },
  { id: 'DEALER_GROUP', universe: 'DEALERS', run: 'closed-active-dealers-sales-20261027', expected: [2, 6, 1, 9] },
  { id: 'MODEL', universe: 'COMPANY', run: 'resolve-sales-model-performance-20261027', expected: [4, 5, 0, 11] },
];
const STATES = ['IMPROVING', 'STABLE', 'DETERIORATING', 'UNKNOWN'];
const historySlot = month => 'history_' + month.replaceAll('-', '_');
const seriesSlot = e => 'series_' + e.temporal.period_from.replaceAll('-', '_') + '_' + e.temporal.period_to.replaceAll('-', '_');

function certified(e) {
  assert.equal(e.authority, 'P1_CERTIFIED');
  assert.equal(e.status, 'CERTIFIED');
  assert.equal(e.source, 'SALES');
  assert.equal(e.measure?.id, 'VIN_SALES');
  assert.ok(e.evidence_id);
}

// Compare complete certified focus, conservatively including coverage/lineage.
// The LLM-only fingerprint is explicitly excluded by the existing P2 contract.
function focus(e) {
  const { evidence_id, temporal_fingerprint, ...rest } = e;
  return rest;
}

export function monthlyPlan(trace, dimension) {
  const byMonth = new Map();
  for (const e of trace.events ?? []) {
    const p1 = e.output_json;
    if (e.floor !== 'P1' || e.tool_name !== 'data_observe' || e.status !== 'SUCCESS'
      || p1?.payload?.dimension?.id !== dimension.id
      || p1?.evidence_contract !== 'p1.dimensional_quantitative_dataset'
      || p1?.universe?.commercial_universe !== dimension.universe) continue;
    const month = p1.temporal.period_identity;
    if (month >= '2021-01' && month <= PERIOD) byMonth.set(month, e);
  }
  const months = Array.from({ length: 69 }, (_, i) =>
    new Date(Date.UTC(2021, i, 1)).toISOString().slice(0, 7));
  return months.map(month => {
    const event = byMonth.get(month);
    assert.ok(event, `Missing original P3 P1 ${dimension.id} ${month}; no archived fallback`);
    return { slot: historySlot(month), event };
  });
}

export function currentMembers(e, dimension) {
  certified(e);
  const rows = e.payload.members.filter(m => /^\d+$/.test(String(m.member_id))
    && (dimension === 'STORE' || m.value > 0));
  assert.equal(new Set(rows.map(m => String(m.member_id))).size, rows.length);
  assert.equal(e.coverage.dimension_unresolved_n, 0, 'Unresolved current roster needs review');
  assert.equal(rows.reduce((n, m) => n + m.value, 0), e.coverage.filtered_n);
  return rows;
}

export async function validateClosedSalesMcp(call, { runId, checkOnly = false, progress = () => {} }) {
  assert.ok(runId);
  progress({ run_id: runId, phase: 'DISCOVERY' });
  const discovery = await call('p2_discover', { run_id: runId });
  for (const unit_id of [STORE_UNIT, SALES_UNIT]) {
    assert.ok(discovery.units?.some(u => u.unit_id === unit_id && u.contract_version === VERSION && u.status === 'ACTIVE'),
      `Not published: ${unit_id}@${VERSION}`);
    const contract = await call('p2_describe', { run_id: runId, unit_id, contract_version: VERSION });
    assert.equal(contract.unit_id, unit_id);
    assert.equal(contract.contract_version, VERSION);
    assert.equal(contract.status, 'ACTIVE');
  }
  if (checkOnly) return { run_id: runId, discovery: 'PASS', executions: 0 };

  const report = { run_id: runId, period: PERIOD, cutoff: CUTOFF,
    mode: 'REMOTE_MCP_CURRENT_P1_P2_P3', generated_at: new Date().toISOString(), dimensions: [] };
  const executions = [];
  const refresh = async (event, changes) => {
    assert.equal(event.input_json.source, 'SALES');
    const fresh = await call('data_observe', { ...event.input_json, run_id: runId });
    certified(fresh);
    if (!isDeepStrictEqual(focus(fresh), focus(event.output_json))) changes.push({
      previous_evidence_id: event.output_json.evidence_id, current_evidence_id: fresh.evidence_id,
      temporal: fresh.temporal,
    });
    return fresh;
  };
  const totals = new Map();
  const totalFor = async universe => {
    if (!totals.has(universe)) {
      const e = await call('data_observe', { run_id: runId, source: 'SALES', measure: 'VIN_SALES',
        evidence_shape: 'QUANTITATIVE_OBSERVATION',
        filters: { commercial_universe: universe, date_from: PERIOD + '-01', date_to: CUTOFF } });
      certified(e);
      assert.equal(e.evidence_contract, 'p1.quantitative_observation');
      assert.equal(e.universe?.commercial_universe, universe);
      assert.equal(e.temporal?.date_from, PERIOD + '-01');
      assert.equal(e.temporal?.date_to, CUTOFF);
      assert.ok(Number.isSafeInteger(e.payload?.value) && e.payload.value >= 0);
      totals.set(universe, e);
    }
    return totals.get(universe);
  };
  for (const d of DIMENSIONS) {
    progress({ dimension: d.id, phase: 'CURRENT_P1' });
    const baseline = await call('run_trace', { run_id: d.run });
    assert.equal(baseline.run?.run_id, d.run, 'Required existing P3 run is unavailable');
    const changes = [], evidenceByMember = new Map();
    let members, shared;
    if (d.id !== 'DEALER_GROUP') {
      shared = {};
      for (const { slot, event } of monthlyPlan(baseline, d)) shared[slot] = await refresh(event, changes);
      members = currentMembers(shared.history_2026_09, d.id);
    } else {
      // P1 current grouping, exactly as the approved dealer adapter/publication.
      const roster = await call('data_fetch', { run_id: runId, source: 'SALES', fields: ['dealer_group_id'],
        filters: { commercial_universe: 'DEALERS', date_from: PERIOD + '-01', date_to: CUTOFF } });
      assert.equal(roster.source, 'SALES');
      assert.equal(roster.quality?.validation?.valid, true);
      assert.ok(roster.rows.every(r => /^\d+$/.test(String(r.dealer_group_id))), 'Unresolved dealer group');
      members = [...new Set(roster.rows.map(r => String(r.dealer_group_id)))].sort((a, b) => Number(a) - Number(b))
        .map(member_id => ({ member_id, value: roster.rows.filter(r => String(r.dealer_group_id) === member_id).length }));
      for (const m of members) {
        const plan = new Map();
        for (const e of baseline.events ?? []) {
          const p1 = e.output_json, t = p1?.temporal;
          if (e.floor !== 'P1' || e.tool_name !== 'data_observe' || e.status !== 'SUCCESS'
            || p1?.source !== 'SALES' || p1?.evidence_contract !== 'p1.period_observation_series'
            || String(e.input_json.filters?.dealer_group_id) !== m.member_id) continue;
          if ((t.period_from === '2025-09' && t.period_to === PERIOD)
            || (t.period_from === '2025-05' && t.period_to === '2025-08')) plan.set(seriesSlot(p1), e);
        }
        assert.ok(plan.has('series_2025_09_2026_09'), `No approved P1 series scope for dealer ${m.member_id}; review source change`);
        const refs = {};
        for (const [slot, event] of plan) refs[slot] = await refresh(event, changes);
        evidenceByMember.set(m.member_id, refs);
      }
    }
    assert.ok(members.length, `No current members: ${d.id}`);
    const total = await totalFor(d.universe);
    assert.equal(members.reduce((n, m) => n + m.value, 0), total.payload.value, `${d.id} current P1 reconciliation`);
    const rows = [], counts = Object.fromEntries(STATES.map(s => [s, 0]));
    for (const m of members) {
      const evidence = Object.fromEntries(Object.entries(shared ?? evidenceByMember.get(m.member_id))
        .map(([slot, p1]) => [slot, p1.evidence_id]));
      const args = { run_id: runId, unit_id: d.id === 'STORE' ? STORE_UNIT : SALES_UNIT, contract_version: VERSION,
        evidence, parameters: { cutoff_month: PERIOD, ...(d.id === 'STORE'
          ? { store_id: String(m.member_id) } : { dimension: d.id, member_id: String(m.member_id) }) } };
      const output = await call('p2_execute', args);
      assert.equal(output.status, 'EXECUTED', JSON.stringify(output.error));
      assert.equal(output.lineage?.run_id, runId);
      assert.equal(output.lineage?.unit_id, args.unit_id);
      assert.equal(output.lineage?.contract_version, VERSION);
      assert.ok(output.lineage?.execution_id);
      assert.deepEqual(output.lineage.parameters, args.parameters);
      assert.deepEqual(Object.fromEntries(output.lineage.evidence_refs.map(r => [r.slot, r.evidence_id])), evidence);
      const r = output.result;
      assert.equal(r.period, PERIOD); assert.equal(r.cutoff, CUTOFF);
      assert.equal(r.commercial_universe, d.universe);
      assert.equal(String(d.id === 'STORE' ? r.store_id : r.member_id), String(m.member_id));
      if (d.id !== 'STORE') assert.equal(r.dimension, d.id);
      assert.equal(r.observed_sales, m.value);
      assert.ok(STATES.includes(r.state));
      counts[r.state]++; rows.push(output); executions.push({ args, output });
    }
    report.dimensions.push({ dimension: d.id, baseline_p3_run_id: d.run, current_p1_total: total,
      source_changes: changes, counts, evaluated_members: rows.length,
      prior_validation_counts_match: isDeepStrictEqual(STATES.map(s => counts[s]), d.expected), results: rows });
    progress({ dimension: d.id, phase: 'P2_EXECUTED', counts, source_changes: changes.length });
  }
  // A second read proves recovery from existing P3, rather than a local result file.
  const trace = await call('run_trace', { run_id: runId });
  assert.equal(trace.run?.run_id, runId);
  for (const { args, output } of executions) {
    const event = trace.events?.find(e => e.floor === 'P2' && e.tool_name === 'p2_execute'
      && e.status === 'SUCCESS' && e.output_json?.lineage?.execution_id === output.lineage.execution_id);
    assert.ok(event, `P2 result missing in P3: ${output.lineage.execution_id}`);
    assert.deepEqual(event.input_json, args);
    assert.deepEqual(event.output_json, output);
    for (const id of Object.values(args.evidence)) assert.ok(trace.events.some(e =>
      e.floor === 'P1' && e.tool_name === 'data_observe' && e.status === 'SUCCESS' && e.output_json?.evidence_id === id),
    `P1 evidence missing in current P3 run: ${id}`);
  }
  report.p3_recovery = 'PASS';
  report.executions = executions.length;
  report.status = report.dimensions.every(d => !d.source_changes.length && d.prior_validation_counts_match)
    ? 'MATCH_PRIOR_VALIDATION' : 'CURRENT_P1_REVIEW_REQUIRED';
  return report;
}

async function main() {
  assert.ok(process.env.MCP_URL, 'MCP_URL must explicitly identify the deployed /api/mcp endpoint');
  assert.ok(process.argv.includes('--check') || process.argv.includes('--execute'), 'Use --check or --execute');
  assert.ok(!(process.argv.includes('--check') && process.argv.includes('--execute')), 'Choose one mode');
  const checkOnly = process.argv.includes('--check');
  assert.ok(checkOnly || process.env.REPORT_PATH, 'REPORT_PATH is required for --execute');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'closed-sales-publication-validation', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL)));
    const call = async (name, args) => {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
      assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
      assert.ok(response.structuredContent, `${name} has no structured content`);
      return response.structuredContent;
    };
    const report = await validateClosedSalesMcp(call, {
      runId: process.env.RUN_ID || 'closed-sales-publication-' + randomUUID(), checkOnly,
      progress: event => console.error(JSON.stringify(event)),
    });
    if (!checkOnly) await writeFile(process.env.REPORT_PATH, JSON.stringify(report) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ run_id: report.run_id, discovery: report.discovery, status: report.status,
      executions: report.executions, p3_recovery: report.p3_recovery,
      dimensions: report.dimensions?.map(({ dimension, counts, evaluated_members, prior_validation_counts_match, source_changes }) =>
        ({ dimension, counts, evaluated_members, prior_validation_counts_match, source_changes: source_changes.length })) }));
    if (report.status === 'CURRENT_P1_REVIEW_REQUIRED') process.exitCode = 2;
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
