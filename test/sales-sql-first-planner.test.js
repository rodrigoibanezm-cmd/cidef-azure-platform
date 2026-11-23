import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSalesCandidates } from '../scripts/semantic-sales-prototype.mjs';

const base = Object.freeze({
  commercial_universe: 'OWN_STORES', brand_id: 89, model_id: 28,
  date_from: '2026-08-01', date_to: '2026-08-31',
});

test('planner accepts independent supported filters and combinations', () => {
  for (const filters of [
    base, {...base, store_id: 4}, {...base, seller_id: 232},
    {...base, store_id: 4, seller_id: 232},
    {...base, commercial_universe: 'DEALERS', dealer_id: 19},
    {...base, commercial_universe: 'DEALERS', dealer_id: 19, seller_id: 232},
  ]) {
    const result = planSalesCandidates(filters, base.date_to);
    assert.ok(result);
    assert.deepEqual(result.filters, filters);
  }
});

test('unsupported dimensions, commercial scopes, periods and values fall back', () => {
  for (const filters of [
    {...base, color: 'BLANCO'}, {...base, dealer_group_id: 1},
    {...base, version_id: 7}, {...base, brand_id: [89]},
    {...base, store_id: '4'}, {...base, model_id: undefined},
    {...base, commercial_universe: 'COMPANY'},
    {...base, commercial_universe: 'DEALERS', store_id: 4},
    {...base, dealer_id: 19}, {...base, date_from: '2026-07-01'},
  ]) assert.equal(planSalesCandidates(filters, base.date_to), null);
  assert.equal(planSalesCandidates(base, '2026-08-25'), null);
  assert.equal(planSalesCandidates(null, base.date_to), null);
});

test('legacy SALES dataset never loads VIN candidates without partial evidence', async () => {
  const source = readFileSync(new URL('../lib/data-floor/sales/dataset.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function dataset(');
  const end = source.indexOf('export function quality(', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end).replace('export async function dataset(', 'async function dataset(');
  const full = [{source_id:1}, {source_id:2}];
  const calls = [];
  const prepared = {
    recognize: (options) => { calls.push({recognize:options}); return {u:{},base:full}; },
  };
  const dataset = new Function('normalize','prepareSalesInput','match',
    body + '\nreturn dataset;')(
    input => ({filters:input.filters,commercial_universe:'OWN_STORES',sales_source:'AUTO'}),
    async (...args) => {calls.push({preparation:args});return prepared;},
    () => true,
  );
  const selected = await dataset({filters:{
    commercial_universe:'OWN_STORES', brand_id:89, model_id:28,store_id:4,
    date_from:'2026-08-01',date_to:'2026-08-31',
  }});
  assert.equal(selected.base.length,2);
  assert.equal(selected.filtered.length,2);
  assert.deepEqual(calls[0],{preparation:[]});
  assert.equal(calls.length,2);
});
