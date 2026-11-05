import { randomUUID } from 'node:crypto';
import { loadVentasRows } from '../../ventas/loadVentasRows.js';
import { loadCommercialIdentityMap, loadHistoricalSalesChannelMap, loadDealerBuyerMap } from '../../ventas-commercial/buildVentasCommercialContext.js';
import { loadVentasUniverseResources } from '../../ventas-universe/buildVentasUniverse.js';
import { loadSalesAttributes } from './attributes.js';
import { buildSalesFactSet } from './factSet.js';
import { recognizeSalesPreparation } from './recognition.js';
import { salesContentFingerprint } from './capture.js';

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
