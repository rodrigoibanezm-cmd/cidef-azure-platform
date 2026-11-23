import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('derived runner reuses certified publishers without reloading RAW', async () => {
  const runner = await readFile(new URL('scripts/refresh-sales-derived-azure.js', root), 'utf8');
  assert.doesNotMatch(runner, /runSalesRawRefresh|runSalesRefresh/);
  for (const stage of ['vehiculo_canonico', 'dealer_monthly_sellout_snapshots',
    'dealer_monthly_model_sellin_snapshots', 'forum_ventas_snapshot_v01']) {
    assert.match(runner, new RegExp('runStage\\(client, cutoff, [\\x27\\x22]' + stage));
  }
  assert.match(runner, /publishCurrentDealerSellin\(month, cutoff, pool, client\)/);
  assert.match(runner, /refresh-forum-ventas-snapshot-azure\.js/);
  assert.match(runner, /source_date,stage,input_signature/);
  assert.match(runner, /ROLLBACK/);
});

test('existing full SALES flow and derived transaction contract remain supported', async () => {
  const code = await readFile(new URL('src/loaders/sales/refresh.js', root), 'utf8');
  assert.match(code, /publishCurrentDealerSellin\(currentMonth, date, pool\)/);
  assert.match(code, /publishCurrentDealerSellin\(period, cutoff, pool, transactionClient = null\)/);
  assert.match(code, /if \(!transactionClient\) await client\.query\('BEGIN'\)/);
  assert.match(code, /if \(!transactionClient\) await client\.query\('COMMIT'\)/);
  assert.match(code, /if \(!transactionClient\) client\.release\(\)/);
});
