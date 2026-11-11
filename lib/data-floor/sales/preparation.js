import { randomUUID } from 'node:crypto';
import { loadVentasRows } from '../../ventas/loadVentasRows.js';
import { loadCommercialIdentityMap, loadHistoricalSalesChannelMap, loadDealerBuyerMap, parseCommercialUniverse } from '../../ventas-commercial/buildVentasCommercialContext.js';
import { loadVentasUniverseResources } from '../../ventas-universe/buildVentasUniverse.js';
import { loadSalesAttributes } from './attributes.js';
import { buildSalesFactSet } from './factSet.js';
import { recognizeSalesPreparation } from './recognition.js';
import { salesContentFingerprint } from './capture.js';

const salesRuns = new Map();
const RUN_IDLE_MS = 5 * 60_000;

// Own the entire captured graph, including nested row values and Map entries.
// No external alias or published universe can mutate these retained inputs.
export function createSalesPreparation({rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes}){
  const input=structuredClone({rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes});
  const content_fingerprint=salesContentFingerprint({version:'p1.sales.preparation_content.v1',...input});
  // NETWORK is captured from the same source row, before any later recognition.
  input.networkCategories=new Map(input.rows.map(row=>[String(row.id),row.categoria_cliente]));
  const preparation_id='p1.sales.prepared.'+randomUUID();
  const identity=Object.freeze({preparation_id,content_fingerprint,fingerprint_version:'p1.sales.preparation_content.v1',
    consistency:'CAPTURED_INPUTS_ONLY',dependency_revision:null});
  return Object.freeze({
    ...identity,identity,
    recognize(options={}){return recognizeSalesPreparation(input,options);},
    buildFactSet(options={}){return buildSalesFactSet(input,identity,options);},
  });
}

export async function prepareSalesInput(){
  // Same authorities/loaders as the existing universe and SALES dataset. This
  // WP does not introduce a transaction/snapshot policy for concurrent writes.
  const [rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes]=await Promise.all([
    loadVentasRows(),loadCommercialIdentityMap(),loadHistoricalSalesChannelMap(),loadDealerBuyerMap(),
    loadVentasUniverseResources(),loadSalesAttributes(),
  ]);
  return createSalesPreparation({rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes});
}

export async function getSalesRunFactSet(run_id, {commercial_universe, cutoff_date, sales_source = 'AUTO'}) {
  const universe = parseCommercialUniverse(commercial_universe);
  const options = {commercial_universe: universe, cutoff_date, sales_source};
  if (!run_id) {
    const prepared = await prepareSalesInput();
    return {factSet: prepared.buildFactSet(options), preparations: 1, recognitions: 1};
  }

  let run = salesRuns.get(run_id);
  const preparations = run ? 0 : 1;
  if (!run) {
    run = {preparation: prepareSalesInput(), factSets: new Map(), idleTimer: null};
    salesRuns.set(run_id, run);
  }
  clearTimeout(run.idleTimer);

  let prepared;
  try {
    prepared = await run.preparation;
  } catch (error) {
    if (salesRuns.get(run_id) === run) salesRuns.delete(run_id);
    throw error;
  }

  try {
    // The engine versions are fixed for this process. Building and publishing
    // a Fact Set is synchronous, so another waiter cannot build the same key.
    const key = JSON.stringify([universe, cutoff_date, sales_source]);
    const existing = run.factSets.get(key);
    if (existing) return {factSet: existing, preparations, recognitions: 0};

    const factSet = prepared.buildFactSet(options);
    run.factSets.set(key, factSet);
    return {factSet, preparations, recognitions: 1};
  } finally {
    clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(() => salesRuns.delete(run_id), RUN_IDLE_MS).unref();
  }
}
