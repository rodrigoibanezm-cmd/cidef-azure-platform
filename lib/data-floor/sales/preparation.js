import { randomUUID } from 'node:crypto';
import { loadVentasRows } from '../../ventas/loadVentasRows.js';
import { loadCommercialIdentityMap, loadHistoricalSalesChannelMap, loadDealerBuyerMap, parseCommercialUniverse } from '../../ventas-commercial/buildVentasCommercialContext.js';
import { loadVentasUniverseResources } from '../../ventas-universe/buildVentasUniverse.js';
import { createRunUniverses } from '../runUniverses.js';
import { loadSalesAttributes } from './attributes.js';
import { buildSalesFactSet } from './factSet.js';
import { recognizeSalesPreparation } from './recognition.js';
import { salesContentFingerprint } from './capture.js';

// Own the entire captured graph, including nested row values and Map entries.
// No external alias or published universe can mutate these retained inputs.
export function createSalesPreparation({rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes}, timings = null, fingerprint = true){
  const started = performance.now();
  const input=structuredClone({rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes});
  if (timings) timings.clone_ms = Math.round(performance.now() - started);
  const fingerprintStarted = performance.now();
  const content_fingerprint=fingerprint ? salesContentFingerprint({version:'p1.sales.preparation_content.v1',...input}) : null;
  if (timings) timings.fingerprint_ms = Math.round(performance.now() - fingerprintStarted);
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

// Limit concurrent SALES preparations per process; existing per-run sharing remains unchanged.
const preparationConcurrency = Number(process.env.SALES_PREPARATION_CONCURRENCY ?? '1');
const preparationWaiters = [];
let activePreparations = 0;

async function withPreparationSlot(operation) {
  if (!Number.isSafeInteger(preparationConcurrency) || preparationConcurrency < 1)
    throw new Error('SALES_PREPARATION_CONCURRENCY must be a positive integer');
  if (activePreparations < preparationConcurrency) activePreparations++;
  else await new Promise(resolve => preparationWaiters.push(resolve));
  try {
    return await operation();
  } finally {
    const next = preparationWaiters.shift();
    if (next) next();
    else activePreparations--;
  }
}

export async function prepareSalesInput({candidateVins = null, timings = null, fingerprint = true} = {}){
  const queuedAt = performance.now();
  return withPreparationSlot(async () => {
  if (timings) timings.preparation_wait_ms = Math.round(performance.now() - queuedAt);
  // Same authorities/loaders as the existing universe and SALES dataset. This
  // WP does not introduce a transaction/snapshot policy for concurrent writes.
  const started = performance.now();
  const measure = (name, promise) => promise.then(value => { if (timings) timings[name] = Math.round(performance.now() - started); return value; });
  const [rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes]=await Promise.all([
    measure('rows_ms',loadVentasRows(undefined, candidateVins)),measure('commercial_map_ms',loadCommercialIdentityMap(undefined, candidateVins)),
    measure('historical_map_ms',loadHistoricalSalesChannelMap()),measure('dealer_map_ms',loadDealerBuyerMap()),
    measure('resources_ms',loadVentasUniverseResources(undefined, timings, candidateVins)),measure('attributes_ms',loadSalesAttributes(candidateVins)),
  ]);
  const prepared = createSalesPreparation({rows,commercialMap,historicalSalesChannelMap,dealerBuyerMap,resources,attributes}, timings, fingerprint);
  if (timings) timings.preparation_total_ms = Math.round(performance.now() - started);
  return prepared;
  });
}

// SQL-first is limited to exact monthly brand/model queries; store is optional for OWN_STORES.
// Other shapes keep the complete certified preparation.
async function prepareRunSalesInput({candidateQuery = null, diagnostic_timings = null} = {}) {
  if (!candidateQuery) return prepareSalesInput({timings:diagnostic_timings});
  const {semanticSalesCandidates} = await import('../../../scripts/semantic-sales-prototype.mjs');
  const started = performance.now();
  const result = await semanticSalesCandidates(candidateQuery);
  if (diagnostic_timings) {
    diagnostic_timings.candidate_sql_ms = Math.round(performance.now() - started);
    diagnostic_timings.candidate_vins = result.vins.length;
  }
  return prepareSalesInput({candidateVins: result.vins, timings:diagnostic_timings});
}

const getRunUniverse = createRunUniverses(prepareRunSalesInput, (prepared, options) => {
  const started = performance.now();
  const result = prepared.buildFactSet(options);
  if (options.diagnostic_timings) options.diagnostic_timings.fact_set_build_ms = Math.round(performance.now() - started);
  return result;
});

export async function getSalesRunFactSet(run_id, {commercial_universe, cutoff_date, sales_source = 'AUTO', candidate_filters = null, diagnostic_sql_first = false, diagnostic_timings = null}) {
  const universe = parseCommercialUniverse(commercial_universe);
  const {planSalesCandidates} = await import('../../../scripts/semantic-sales-prototype.mjs');
  const candidateQuery = (diagnostic_sql_first === true ||
    process.env.SALES_SQL_FIRST_ENABLED === 'true') && sales_source === 'AUTO'
    ? planSalesCandidates(candidate_filters, cutoff_date) : null;
  const options = {commercial_universe: universe, cutoff_date, sales_source, diagnostic_timings,
    ...(candidateQuery ? {partial_source_filters: structuredClone(f)} : {})};
  const key = JSON.stringify([universe, cutoff_date, sales_source]);
  // A partial input must never be reused by a wider or different same-run query.
  const scope = candidateQuery ? JSON.stringify(candidateQuery) : null;
  const {universe: factSet, preparations, builds: recognitions} = await getRunUniverse(run_id, key, options, scope, {candidateQuery, diagnostic_timings});
  return {factSet, preparations, recognitions};
}
