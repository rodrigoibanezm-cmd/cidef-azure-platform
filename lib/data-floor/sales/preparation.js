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
  return withPreparationSlot(async () => {
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

// SQL-first is limited to one exact monthly store/brand/model query.
// Other shapes keep the complete certified preparation.
async function prepareRunSalesInput({candidateQuery = null} = {}) {
  if (!candidateQuery) return prepareSalesInput();
  const {semanticSalesCandidates} = await import('../../../scripts/semantic-sales-prototype.mjs');
  const result = await semanticSalesCandidates(candidateQuery);
  return prepareSalesInput({candidateVins: result.vins});
}

const getRunUniverse = createRunUniverses(prepareRunSalesInput, (prepared, options) => prepared.buildFactSet(options));

export async function getSalesRunFactSet(run_id, {commercial_universe, cutoff_date, sales_source = 'AUTO', candidate_filters = null}) {
  const universe = parseCommercialUniverse(commercial_universe);
  const f = candidate_filters;
  const selective = universe === 'OWN_STORES' && sales_source === 'AUTO' && f &&
    [f.store_id, f.model_id, f.brand_id].every(v => Number.isSafeInteger(v) && v > 0) &&
    /^\\d{4}-\\d{2}-01$/.test(f.date_from ?? '') &&
    /^\\d{4}-\\d{2}-\\d{2}$/.test(f.date_to ?? '') &&
    f.date_from.slice(0, 7) === f.date_to.slice(0, 7) &&
    f.date_to === cutoff_date &&
    Object.keys(f).every(k => ['store_id','model_id','brand_id','date_from','date_to','commercial_universe'].includes(k));
  const candidateQuery = selective ? {
    store_id:f.store_id, model_id:f.model_id, brand_id:f.brand_id,
    year:Number(f.date_from.slice(0,4)), month:Number(f.date_from.slice(5,7))
  } : null;
  const options = {commercial_universe: universe, cutoff_date, sales_source};
  const key = JSON.stringify([universe, cutoff_date, sales_source]);
  // A partial input must never be reused by a wider or different same-run query.
  const scope = candidateQuery ? JSON.stringify(candidateQuery) : null;
  const {universe: factSet, preparations, builds: recognitions} = await getRunUniverse(run_id, key, options, scope, {candidateQuery});
  return {factSet, preparations, recognitions};
}
