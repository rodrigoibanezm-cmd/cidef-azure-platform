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
  assert.ok(runner.indexOf("'vehiculos_raw_rvm_sync'") < runner.indexOf("'vehiculo_canonico'"));
  assert.match(runner, /syncVehiculosFromRvm\(\(text, values\) => sql\(client, text, values\)/);
  assert.match(runner, /onlyChanged: true/);
  assert.match(runner, /latest_rvm_ingestion/);
  assert.match(runner, /pg_stat_all_tables/);
  assert.match(runner, /relfilenode/);
  assert.doesNotMatch(runner, /FROM \(SELECT md5\(to_jsonb\(t\)::text\) h FROM public\.rvm_raw t\)/);
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

test('RVM sync is change-only for derived runs; existing default is unchanged', async () => {
  const { syncVehiculosFromRvm } = await import('../src/loaders/sales/sync-vehiculos-rvm.js');
  const statements = [];
  const execute = async (sql, params = []) => {
    statements.push({ sql, params });
    return sql.includes('SELECT count(*)::int AS rows_updated') ? [{ rows_updated: 3 }] : [];
  };
  assert.deepEqual(await syncVehiculosFromRvm(execute, { onlyChanged: true }), { rows_updated: 3 });
  assert.deepEqual(statements.at(-1).params, [true]);
  assert.match(statements.at(-1).sql, /IS DISTINCT FROM \(p.new_date, p.new_plate, p.new_status\)/);
  statements.length = 0;
  await syncVehiculosFromRvm(execute);
  assert.deepEqual(statements.at(-1).params, [false]);
});

test('sell-in preserves certified VINs whose model identity is unresolved', async () => {
  const code = await readFile(new URL('src/loaders/sales/refresh.js', root), 'utf8');
  assert.match(code, /sale\.model_id == null \? 0 : Number\(sale\.model_id\)/);
  assert.match(code, /if \(model === 0\) unresolvedModels \+= Number\(sale\.quantity\)/);
  assert.match(code, /unresolved_model_vin: unresolvedModels/);
  assert.match(code, /!Number\.isSafeInteger\(brand\) \|\| brand <= 0/);
  assert.match(code, /!Number\.isSafeInteger\(model\) \|\| model < 0/);
  assert.doesNotMatch(code.slice(code.indexOf('export async function publishCurrentDealerSellin'),
    code.indexOf('export async function runSalesRefresh')), /model <= 0/);
});

test('verified RAW fingerprint chain scopes canonical VIN updates', async () => {
  const { planCanonicalScope } = await import('../scripts/refresh-sales-derived-azure.js');
  const vin = 'LVAV2JVB4TE322929';
  const client = { async query(sql) {
    if (sql.includes("stage='vehiculo_canonico'"))
      return { rows: [{ completed_at: '2026-11-25T00:00:00Z', result: {
        master_signature: 'masters', code_signature: 'engine', raw_state_signature: 'before',
      }}] };
    if (sql.includes('FROM public.sales_raw_refresh_runs'))
      return { rows: [{ result: { rawDelta: {
        rawBeforeSignature: 'before', rawStateSignature: 'after',
        requiresFull: false, changedVins: [vin],
      }}}] };
    throw new Error('Unexpected SQL: ' + sql);
  }};
  const input = { masterSignature: 'masters', codeSignature: 'engine',
    currentRawSignature: 'after', rvmStage: { skipped:true } };
  assert.deepEqual(await planCanonicalScope(client,input),
    { affectedVins: [vin], reason: 'VERIFIED_RAW_DELTA' });
  assert.deepEqual((await planCanonicalScope(client, { ...input, codeSignature:'new-code' })).reason,
    'NO_COMPATIBLE_BASELINE');
  assert.deepEqual((await planCanonicalScope(client, { ...input,
    currentRawSignature:'out-of-band' })).reason, 'RAW_CHANGED_OUTSIDE_LEDGER');
  assert.deepEqual((await planCanonicalScope(client, { ...input,
    rvmStage:{ skipped:false, result:{rows_updated:1} } })).reason, 'RVM_UPDATED');
});

test('unkeyed or discontinuous RAW snapshots cannot enter selective mode', async () => {
  const { planCanonicalScope } = await import('../scripts/refresh-sales-derived-azure.js');
  for (const delta of [
    { rawBeforeSignature:'before', rawStateSignature:'after', changedVins:[], requiresFull:true },
    { rawBeforeSignature:'untracked', rawStateSignature:'after', changedVins:[], requiresFull:false },
  ]) {
    const client = { async query(sql) {
      return { rows: sql.includes("stage='vehiculo_canonico'")
        ? [{completed_at:'2026-11-25T00:00:00Z', result:{
          raw_state_signature:'before', master_signature:'masters', code_signature:'engine',
        }}] : [{result:{rawDelta:delta}}] };
    }};
    const result = await planCanonicalScope(client, {
      masterSignature:'masters', codeSignature:'engine',
      currentRawSignature:'after', rvmStage:{skipped:true},
    });
    assert.equal(result.affectedVins, null);
    assert.equal(result.reason, 'RAW_CHAIN_NOT_CERTIFIED');
  }
});
