import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeP2 } from '../lib/p2/execute.js';
import { discoverP2Units, describeP2Unit } from '../lib/p2/registry.js';
import { DIMENSIONS, monthlyPlan, validateClosedSalesMcp } from '../scripts/validate-closed-sales-performance-mcp.js';

// Archived original P1 is used ONLY in this offline test double, never by the CLI.
const read = path => JSON.parse(readFileSync(new URL('../docs/validation/' + path, import.meta.url)));
const inputs = {
  STORE: read('closed-store-performance-2026-09-p1.json'),
  SELLER: read('closed-sales-performance-2026-09/p1-seller.json'),
  MODEL: read('model-identity-coverage-2026-09/p1-inputs.json'),
  DEALER_GROUP: read('closed-dealer-performance-2026-09/p1-inputs.json'),
};

function offlineMcp({ changedModel = false, unavailableP1 = false, missingP3 = false } = {}) {
  const calls = [], events = [], observed = new Map(), baselines = new Map();
  for (const d of DIMENSIONS) {
    const source = inputs[d.id], history = d.id === 'DEALER_GROUP'
      ? Object.entries(source.groups).flatMap(([id, group]) => Object.values(group).map(p1 => ({ id, p1 })))
      : Object.values(source.evidence).map(p1 => ({ p1 }));
    const oldEvents = history.map(({ id, p1 }) => ({ floor: 'P1', tool_name: 'data_observe', status: 'SUCCESS',
      input_json: { run_id: d.run, source: 'SALES', measure: 'VIN_SALES',
        evidence_shape: d.id === 'DEALER_GROUP' ? 'PERIOD_OBSERVATION_SERIES' : 'DIMENSIONAL_QUANTITATIVE_DATASET',
        ...(d.id === 'DEALER_GROUP' ? { period_from: p1.temporal.period_from, period_to: p1.temporal.period_to }
          : { period: p1.temporal.period_identity, cutoff: p1.temporal.cutoff, dimension: d.id }),
        filters: d.id === 'DEALER_GROUP' ? { dealer_group_id: Number(id), commercial_universe: 'DEALERS' }
          : { commercial_universe: d.universe } },
      output_json: p1 }));
    baselines.set(d.run, { run: { run_id: d.run }, events: oldEvents });
  }
  const call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'p2_discover') return discoverP2Units();
    if (name === 'p2_describe') return describeP2Unit(args.unit_id, args.contract_version);
    if (name === 'run_trace') return baselines.get(args.run_id) ?? { run: { run_id: args.run_id },
      events: missingP3 ? events.filter(e => e.floor !== 'P2') : events };
    let output;
    if (name === 'data_observe') {
      if (unavailableP1) throw new Error('Azure P1 unavailable');
      if (args.evidence_shape === 'QUANTITATIVE_OBSERVATION') {
        output = structuredClone(inputs.DEALER_GROUP.total);
        output.universe.commercial_universe = args.filters.commercial_universe;
        output.payload.value = args.filters.commercial_universe === 'DEALERS' ? 661
          : args.filters.commercial_universe === 'OWN_STORES' ? 373 : changedModel ? 1032 : 1033;
      } else {
        const dimension = args.dimension ?? 'DEALER_GROUP';
        const reference = baselines.get(DIMENSIONS.find(d => d.id === dimension).run).events.find(e =>
          dimension === 'DEALER_GROUP' ? e.input_json.period_from === args.period_from
            && e.input_json.period_to === args.period_to
            && String(e.input_json.filters.dealer_group_id) === String(args.filters.dealer_group_id)
            : e.input_json.period === args.period);
        assert.ok(reference, JSON.stringify(args));
        output = structuredClone(reference.output_json);
        if (changedModel && dimension === 'MODEL' && args.period === '2026-09') {
          output.payload.members.find(m => m.member_id === '765').value--;
          output.coverage.filtered_n--; output.coverage.dimension_resolved_n--;
        }
      }
      output.evidence_id = 'test.current.' + observed.size;
      observed.set(output.evidence_id, output);
    } else if (name === 'data_fetch') output = inputs.DEALER_GROUP.roster;
    else if (name === 'p2_execute') {
      assert.ok(Object.values(args.evidence).every(id => id.startsWith('test.current.')), 'Archived ref used');
      output = await executeP2({ ...args, evidence: Object.fromEntries(Object.entries(args.evidence)
        .map(([slot, id]) => [slot, observed.get(id)])) });
    } else throw new Error('Unexpected call ' + name);
    events.push({ floor: name === 'p2_execute' ? 'P2' : 'P1', tool_name: name,
      status: 'SUCCESS', input_json: args, output_json: output });
    return output;
  };
  return { call, calls, baselines };
}

test('both existing units are active locally; current image copies their registry/core', () => {
  const units = discoverP2Units().units;
  assert.equal(units.length, 15);
  for (const id of ['p2.closed_period_store_performance', 'p2.closed_period_sales_performance']) {
    assert.equal(describeP2Unit(id, '0.1.0').status, 'ACTIVE');
  }
  const docker = readFileSync(new URL('../Dockerfile.motor-test-azure', import.meta.url), 'utf8');
  assert.match(docker, /^COPY lib \.\/lib$/m);
});

test('discovery-only mode never observes P1 or executes P2', async () => {
  const mcp = offlineMcp();
  assert.equal((await validateClosedSalesMcp(mcp.call, { runId: 'test', checkOnly: true })).executions, 0);
  assert.deepEqual(mcp.calls.map(c => c.name), ['p2_discover', 'p2_describe', 'p2_describe']);
});

test('unpublished unit stops before reading evidence or executing', async () => {
  const mcp = offlineMcp();
  const call = (name, args) => name === 'p2_discover' ? { units: [] } : mcp.call(name, args);
  await assert.rejects(validateClosedSalesMcp(call, { runId: 'test' }), /Not published/);
  assert.equal(mcp.calls.length, 0);
});

test('all 121 current members use real P2 with native P1 and recover exact outputs from the P3 test double', async () => {
  const mcp = offlineMcp(), report = await validateClosedSalesMcp(mcp.call, { runId: 'test.current' });
  assert.equal(report.status, 'MATCH_PRIOR_VALIDATION');
  assert.equal(report.executions, 121); assert.equal(report.p3_recovery, 'PASS');
  for (const d of report.dimensions) {
    assert.equal(d.prior_validation_counts_match, true);
    assert.equal(d.source_changes.length, 0);
    assert.ok(d.results.every(r => r.result.observed_sales != null));
  }
  const sellers = report.dimensions.find(d => d.dimension === 'SELLER');
  assert.equal(sellers.evaluated_members, 69);
  assert.equal(sellers.counts.UNKNOWN, 53);
  const ids = new Set(inputs.SELLER.evidence.history_2026_09.payload.members.filter(m => m.value > 0).map(m => m.member_id));
  assert.deepEqual(new Set(sellers.results.map(r => r.result.member_id)), ids);
  assert.ok(mcp.calls.filter(c => c.name !== 'run_trace').every(c => c.args.run_id === 'test.current'));
});

test('changed current P1 is executed and flagged; archived 171 VIN never replaces fresh 170', async () => {
  const mcp = offlineMcp({ changedModel: true });
  const report = await validateClosedSalesMcp(mcp.call, { runId: 'test.changed' });
  assert.equal(report.status, 'CURRENT_P1_REVIEW_REQUIRED');
  const models = report.dimensions.find(d => d.dimension === 'MODEL');
  assert.equal(models.source_changes.length, 1);
  assert.equal(models.current_p1_total.payload.value, 1032);
  assert.equal(models.results.find(r => r.result.member_id === '765').result.observed_sales, 170);
});

test('P1 outage fails without archive fallback', async () => {
  const mcp = offlineMcp({ unavailableP1: true });
  await assert.rejects(validateClosedSalesMcp(mcp.call, { runId: 'test.outage' }), /P1 unavailable/);
  assert.ok(!mcp.calls.some(c => c.name === 'p2_execute'));
});

test('missing P3 P2 events cannot pass recovery validation', async () => {
  const mcp = offlineMcp({ missingP3: true });
  await assert.rejects(validateClosedSalesMcp(mcp.call, { runId: 'test.no-p3' }), /P2 result missing in P3/);
});

test('incomplete historical P3 plan cannot be replaced by local evidence', () => {
  const mcp = offlineMcp(), d = DIMENSIONS[0];
  const trace = structuredClone(mcp.baselines.get(d.run)); trace.events.shift();
  assert.throws(() => monthlyPlan(trace, d), /Missing original P3 P1 STORE 2021-01/);
});
