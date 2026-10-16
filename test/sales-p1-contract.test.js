import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVentasMonthlyActual } from '../lib/motors/ventas-monthly-actual-v01.js';

test('SALES monthly engine preserves its certified result contract', () => {
  const result = calculateVentasMonthlyActual({
    cutoff_month: '2026-09',
    monthlySales: [{ month: '2026-09', sales: 42 }],
    validation: { ok: true },
    coverage: { source_rows: 50 },
    warnings: [],
  }, { cutoffMonth: '2026-09', targetMonth: '2026-09' });

  assert.deepEqual(result, {
    engine: 'ventas_monthly_actual_v01',
    version: '0.1',
    status: 'ok',
    inputs: { cutoff_month: '2026-09', target_month: '2026-09' },
    policy: {
      recognition: 'ventas_context_v01 LAST-by-VIN inside cutoff',
      temporal_guard: 'cutoff applied before VIN recognition; evidence after cutoff is excluded',
    },
    actual: { month: '2026-09', sales: 42 },
    coverage: { source_rows: 50 },
    validation: {
      ventas_context_ok: true,
      target_within_cutoff: true,
      cutoff_context_match: true,
      target_month_present: true,
      no_post_cutoff_evidence_used: true,
    },
    warnings: [],
  });
});

test('SALES monthly engine refuses a target beyond the cutoff', async () => {
  const { ventasMonthlyActualV01 } = await import('../lib/motors/ventas-monthly-actual-v01.js');
  await assert.rejects(
    ventasMonthlyActualV01({ target_month: '2026-10', cutoff_month: '2026-09' }),
    /target_month must be <= cutoff_month/,
  );
});
