import { enrichRecognizedSale } from '../ventas-org/enrichRecognizedSales.js';
import { commercialDateForDay, commercialMonthDays } from '../ventas/commercialMonth.js';

function emptyState() {
  return {
    recognized: 0,
    resolved: 0,
    cidef: 0,
    unresolved: 0,
    ambiguous: 0,
    unknownChannel: 0,
    stores: new Map(),
    sellers: new Map(),
    negativeSeen: false,
    negativeSellerSeen: false,
  };
}

function adjustStore(state, sale, delta, month, identityMaps) {
  if (!sale || sale.mes_venta !== month) return;
  state.recognized += delta;
  const event = enrichRecognizedSale(sale, identityMaps);
  if (event.store_identity_status === 'NO_RESUELTA') {
    state.unresolved += delta;
    return;
  }
  if (event.store_identity_status === 'AMBIGUA') {
    state.ambiguous += delta;
    return;
  }

  state.resolved += delta;
  if (!event.tipo_canal) state.unknownChannel += delta;
  if (event.tipo_canal !== 'CIDEF') return;

  state.cidef += delta;
  const key = String(event.sucursal_id);
  const current = state.stores.get(key) || {
    sucursal_id: event.sucursal_id,
    sucursal: event.sucursal_nombre,
    count: 0,
  };
  current.count += delta;
  if (current.count < 0) state.negativeSeen = true;
  state.stores.set(key, current);

  if (event.eligible_vendedor_cidef !== true) return;
  const sellerKey = `${event.sucursal_id}|${event.persona_id}`;
  const seller = state.sellers.get(sellerKey) || {
    sucursal_id: event.sucursal_id,
    sucursal: event.sucursal_nombre,
    persona_id: event.persona_id,
    persona: event.persona_nombre,
    count: 0,
  };
  seller.count += delta;
  if (seller.count < 0) state.negativeSellerSeen = true;
  state.sellers.set(sellerKey, seller);
}

function snapshot(state, month, day, cutoffDate) {
  const stores = [...state.stores.values()]
    .filter((row) => row.count > 0)
    .map((row) => ({
      sucursal_id: row.sucursal_id,
      sucursal: row.sucursal,
      month_sales_to_date: row.count,
    }))
    .sort((a, b) => Number(a.sucursal_id) - Number(b.sucursal_id));
  const sellers = [...state.sellers.values()]
    .filter((row) => row.count > 0)
    .map((row) => ({
      sucursal_id: row.sucursal_id,
      sucursal: row.sucursal,
      persona_id: row.persona_id,
      persona: row.persona,
      count: row.count,
    }))
    .map(({ count, ...row }) => ({ ...row, month_sales_to_date: count }))
    .sort((a, b) => Number(a.sucursal_id) - Number(b.sucursal_id)
      || Number(a.persona_id) - Number(b.persona_id));
  return {
    target_month: month,
    cutoff_date: cutoffDate,
    day_of_month: day,
    recognized_sales_to_date: state.recognized,
    resolved_store: state.resolved,
    cidef_owned_sales_to_date: state.cidef,
    unresolved_store: state.unresolved,
    ambiguous_store: state.ambiguous,
    unknown_channel: state.unknownChannel,
    negative_store_state_seen: state.negativeSeen,
    negative_seller_state_seen: state.negativeSellerSeen,
    stores,
    sellers,
  };
}

export function buildDailySnapshots(events, identityMaps, months) {
  const byDay = new Map();
  for (const event of events || []) {
    const day = new Date(event.time).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }

  const output = [];
  for (const month of months) {
    const state = emptyState();
    const days = [];
    for (let day = 1; day <= commercialMonthDays(month); day += 1) {
      const date = commercialDateForDay(month, day);
      for (const event of byDay.get(date) || []) {
        adjustStore(state, event.previous, -1, month, identityMaps);
        adjustStore(state, event.next, 1, month, identityMaps);
      }
      days.push(snapshot(state, month, day, date));
    }
    output.push({ target_month: month, days });
  }
  return output;
}
