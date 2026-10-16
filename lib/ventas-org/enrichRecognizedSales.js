import {
  activeVendedorCidefAssignments,
  isVendedorCidefAtStore,
} from './vendedorCidef.js';

function identityStatus(hit) {
  if (!hit) return 'NO_RESUELTA';
  return hit.match_count === 1 ? 'RESUELTA' : 'AMBIGUA';
}

export function enrichRecognizedSale(sale, identityMaps) {
  const stores = identityMaps?.stores ?? new Map();
  const sellers = identityMaps?.sellers ?? new Map();
  const certifiedOwnStore = sale.commercial_universe === 'OWN_STORES'
    && sale.canal_salida === 'TIENDA_PROPIA';
  const certifiedDealer = sale.commercial_universe === 'DEALERS'
    && sale.canal_salida === 'DEALER';
  const storeKey = sale.sucursal_source_key ?? sale.sucursal_id ?? null;
  const sellerKey = sale.vendedor_source_key ?? sale.vendedor ?? null;
  const rawStore = storeKey == null ? null : stores.get(String(storeKey));
  const seller = sellerKey == null ? null : sellers.get(String(sellerKey));
  const rawStoreStatus = identityStatus(rawStore);
  const sellerStatus = identityStatus(seller);
  const personaId = sellerStatus === 'RESUELTA' ? seller.canonical_id : null;
  const storeId = certifiedOwnStore
    ? sale.sucursal_venta_id ?? null
    : rawStoreStatus === 'RESUELTA' ? rawStore.canonical_id : null;
  const storeStatus = certifiedOwnStore
    ? (storeId == null ? 'NO_RESUELTA' : 'RESUELTA')
    : certifiedDealer ? 'NO_APLICA' : rawStoreStatus;
  const tipoCanal = certifiedOwnStore ? 'CIDEF'
    : certifiedDealer ? 'DEALER'
      : rawStoreStatus === 'RESUELTA' ? rawStore.tipo_canal ?? null : null;
  const assignments = activeVendedorCidefAssignments(
    personaId, sale.fecha_venta_iso, identityMaps?.vendedorCidef,
  );
  const storeMatch = isVendedorCidefAtStore(
    personaId, storeId, sale.fecha_venta_iso, identityMaps?.vendedorCidef,
  );
  const eligibleVendedorCidef = sellerStatus === 'RESUELTA'
    && storeStatus === 'RESUELTA' && tipoCanal === 'CIDEF' && storeMatch;
  const eligibilityStatus = sellerStatus !== 'RESUELTA'
    ? sellerStatus
    : eligibleVendedorCidef
      ? 'ELIGIBLE_VENDEDOR_CIDEF'
      : assignments.length
        ? 'VENDEDOR_CIDEF_STORE_MISMATCH'
        : 'RESOLVED_NOT_VENDEDOR_CIDEF';

  const dealerId = certifiedDealer
    ? sale.dealer_id ?? null
    : rawStoreStatus === 'RESUELTA' ? rawStore.dealer_id ?? null : null;
  const dealer = dealerId != null ? identityMaps?.dealers?.get(String(dealerId)) : null;

  return {
    source_id: sale.source_id,
    month: sale.mes_venta,
    sucursal_source_key: storeKey,
    vendedor_source_key: sellerKey,
    sucursal_id: storeId,
    sucursal_nombre: certifiedOwnStore
      ? sale.sucursal_venta_nombre ?? null
      : rawStoreStatus === 'RESUELTA' ? rawStore.nombre_canonico : null,
    tipo_canal: tipoCanal,
    dealer_id: dealerId,
    dealer_nombre: certifiedDealer ? sale.dealer_nombre ?? dealer?.nombre_canonico ?? null : dealer?.nombre_canonico ?? null,
    dealer_group_id: certifiedDealer
      ? sale.dealer_group_id ?? null
      : rawStoreStatus === 'RESUELTA' ? rawStore.dealer_group_id ?? null : null,
    dealer_group_nombre: certifiedDealer
      ? sale.dealer_group_nombre ?? dealer?.dealer_group_nombre ?? null
      : dealer?.dealer_group_nombre ?? null,
    persona_id: personaId,
    persona_nombre: sellerStatus === 'RESUELTA' ? seller.nombre_canonico : null,
    persona_validated: sellerStatus === 'RESUELTA' ? seller.validated : null,
    store_identity_status: storeStatus,
    seller_identity_status: sellerStatus,
    seller_eligibility_status: eligibilityStatus,
    eligible_vendedor_cidef: eligibleVendedorCidef,
    vendedor_cidef_store_match: storeMatch,
    vendedor_cidef_assignment_store_ids: [...new Set(assignments
      .map((row) => String(row.sucursal_id)))].sort(),
    commercial_scope: sale.commercial_universe ? {
      universe: sale.commercial_universe,
      authority: 'certified_recognized_sale',
      valid: true,
      scope_id: 'ventas_commercial_context_v01',
    } : null,
  };
}

export function enrichRecognizedSales(recognizedSales, identityMaps) {
  return recognizedSales.map((sale) => enrichRecognizedSale(sale, identityMaps));
}
