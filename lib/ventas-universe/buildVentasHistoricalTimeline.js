import { loadVentasRows } from '../ventas/loadVentasRows.js';
import { findTrainingStartMonth } from '../daily-close-forecast/findTrainingStartMonth.js';
import { buildRecognitionEvents } from '../daily-close-backtest/buildRecognitionEvents.js';
import {
  certifyRecognizedSaleCommercially,
  loadCommercialIdentityMap,
  loadHistoricalSalesChannelMap,
} from '../ventas-commercial/buildVentasCommercialContext.js';
import { loadVentasUniverseResources } from './buildVentasUniverse.js';

export const HISTORICAL_TIMELINE_NAME = 'ventas_universe_historical_timeline_v01';

function certifySale(sale, commercialMap, historicalSalesChannelMap) {
  if (!sale) return null;
  const certified = certifyRecognizedSaleCommercially(
    sale, commercialMap, historicalSalesChannelMap,
  );
  return {
    ...certified,
    commercial_universe: certified.canonical_commercial_universe,
  };
}

export function assembleVentasHistoricalTimeline(
  rows,
  commercialMap,
  startMonth,
  endMonth,
  historicalSalesChannelMap = null,
) {
  const timeline = buildRecognitionEvents(rows, startMonth, endMonth);
  const events = timeline.events.map((event) => ({
    ...event,
    previous: certifySale(event.previous, commercialMap, historicalSalesChannelMap),
    next: certifySale(event.next, commercialMap, historicalSalesChannelMap),
  }));
  const validation = {
    event_count_reconciles: events.length === timeline.events.length,
    commercial_identity_attached: events.every((event) =>
      event.previous == null || event.previous.canonical_commercial_universe != null)
      && events.every((event) =>
        event.next == null || event.next.canonical_commercial_universe != null),
  };
  validation.valid = Object.values(validation).every(Boolean);

  return {
    timeline: HISTORICAL_TIMELINE_NAME,
    version: '0.2',
    start_month: startMonth,
    end_month: endMonth,
    events,
    tie_groups_resolved: timeline.tie_groups_resolved,
    validation,
    lineage: {
      recognition: 'ventas_recognition_authority_v01 LAST-by-VIN transition projection',
      commercial_scope: 'ventas_commercial_context_v01',
      commercial_channel_authority: 'recognized sale + sucursales_master historical mapping',
      commercial_destination_metadata: 'vehiculo_canonico only where historical destination metadata is unavailable',
      role: 'cutoff-safe projection of the single certified sales authority',
    },
  };
}

export function historicalTrainingStartMonth(rows, endMonth) {
  return findTrainingStartMonth(rows || [], endMonth);
}

async function loadHistoricalAuthority(startMonth, endMonth) {
  const [rows, commercialMap, historicalSalesChannelMap, resources] = await Promise.all([
    loadVentasRows(),
    loadCommercialIdentityMap(),
    loadHistoricalSalesChannelMap(),
    loadVentasUniverseResources(),
  ]);
  const resolvedStartMonth = startMonth ?? historicalTrainingStartMonth(rows, endMonth);
  const assembled = assembleVentasHistoricalTimeline(
    rows,
    commercialMap,
    resolvedStartMonth,
    endMonth,
    historicalSalesChannelMap,
  );
  return {
    ...assembled,
    resources,
    source_rows: rows.length,
  };
}

export async function buildVentasHistoricalTimeline(startMonth, endMonth) {
  return loadHistoricalAuthority(startMonth, endMonth);
}

export async function buildVentasHistoricalTimelineThrough(endMonth) {
  return loadHistoricalAuthority(null, endMonth);
}
