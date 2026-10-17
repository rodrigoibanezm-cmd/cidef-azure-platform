import { calculateVentasContext } from '../../ventas/buildVentasContext.js';
import { parseCommercialUniverse, scopeRecognizedSalesToCommercialUniverse } from '../../ventas-commercial/buildVentasCommercialContext.js';
import { assembleVentasUniverse } from '../../ventas-universe/buildVentasUniverse.js';
import { enrichSalesAttributes } from './attributes.js';
import { normalizeNetworkCategory } from './network.js';
import { freezeSalesValue } from './capture.js';

// Independent recognition/certification boundary on privately captured inputs.
// All recognition, scope, universe and enrichment authorities remain unchanged.
// This focal result never projects or replaces the historical timeline.
export function recognizeSalesPreparation(input,{commercial_universe='COMPANY',cutoff_date=null,cutoff_month=null}={}){
  const universe=parseCommercialUniverse(commercial_universe);
  const context=calculateVentasContext(input.rows,{cutoffDate:cutoff_date,cutoffMonth:cutoff_month});
  const commercial=scopeRecognizedSalesToCommercialUniverse({
    recognizedSales:context.recognizedSales,commercialMap:input.commercialMap,
    historicalSalesChannelMap:input.historicalSalesChannelMap,dealerBuyerMap:input.dealerBuyerMap,universe,
  });
  const u=assembleVentasUniverse({...commercial,source_context:{
    motor:'ventas_context_v01',cutoff_date,cutoff_month,version:context.version,
    effective_cutoff_date:context.cutoff_date,effective_cutoff_month:context.cutoff_month,
    coverage:context.coverage,validation:context.validation,warnings:context.warnings,policy:context.policy,
  }},input.resources);
  const base=freezeSalesValue(enrichSalesAttributes(u.analytical_events,input.attributes));
  freezeSalesValue(u);
  return Object.freeze({u,base,commercial_universe:universe,cutoff_date,cutoff_month,
    effective_cutoff_date:context.effective_cutoff_date,
    network(row){return normalizeNetworkCategory(input.networkCategories.get(String(row.source_id)));},
  });
}
