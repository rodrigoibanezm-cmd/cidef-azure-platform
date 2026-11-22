import test from 'node:test';
import assert from 'node:assert/strict';
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
