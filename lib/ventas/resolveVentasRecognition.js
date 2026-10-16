import { parseFechaFactura } from './parseFechaFactura.js';
import { commercialMonthRange } from './commercialMonth.js';
import {
  compareStableId,
  normalizedVin,
  recognizedSale,
  sortRecognizedSales,
  stableId,
} from './ventasContextUtils.js';

export function resolveVentasRecognition(rows) {
  const byVin = new Map();
  const nullVinRecognized = [];
  const stats = {
    non_null_vin_rows: 0,
    null_vin_rows: 0,
    parseable_fecha_factura_rows: 0,
    null_fecha_factura_rows: 0,
    unparseable_fecha_factura_rows: 0,
    unassignable_null_vin_rows: 0,
    excluded_vins_with_date_errors: 0,
    assignable_non_null_vins: 0,
    vins_single_occurrence: 0,
    vins_multiple_occurrences: 0,
    cross_month_vins: 0,
    exact_last_tie_vins: 0,
  };

  for (const row of rows) {
    const vin = normalizedVin(row.nro_vin_chasis);
    const parsed = parseFechaFactura(row.fecha_factura);

    if (vin == null) {
      stats.null_vin_rows += 1;
      if (parsed == null) {
        stats.null_fecha_factura_rows += 1;
        stats.unassignable_null_vin_rows += 1;
      } else if (parsed.error) {
        stats.unparseable_fecha_factura_rows += 1;
        stats.unassignable_null_vin_rows += 1;
      } else {
        stats.parseable_fecha_factura_rows += 1;
        nullVinRecognized.push(recognizedSale(row, parsed, 'null_vin_row', null));
      }
      continue;
    }

    stats.non_null_vin_rows += 1;
    if (!byVin.has(vin)) byVin.set(vin, { rows: [], source_count: 0, date_error: false });
    const entry = byVin.get(vin);
    entry.source_count += 1;

    if (parsed == null) {
      stats.null_fecha_factura_rows += 1;
      entry.date_error = true;
    } else if (parsed.error) {
      stats.unparseable_fecha_factura_rows += 1;
      entry.date_error = true;
    } else {
      stats.parseable_fecha_factura_rows += 1;
      entry.rows.push({ row, parsed, stable_id: stableId(row.id) });
    }
  }

  const recognizedSales = [...nullVinRecognized];

  for (const [vin, entry] of byVin.entries()) {
    if (entry.source_count === 1) stats.vins_single_occurrence += 1;
    else stats.vins_multiple_occurrences += 1;

    if (entry.date_error || !entry.rows.length) {
      stats.excluded_vins_with_date_errors += 1;
      continue;
    }

    stats.assignable_non_null_vins += 1;
    const sorted = entry.rows.slice().sort(
      (a, b) => a.parsed.date - b.parsed.date || compareStableId(a.stable_id, b.stable_id),
    );
    const firstMonth = sorted[0].parsed.month;
    const lastTime = sorted.at(-1).parsed.date.getTime();
    const lastCandidates = sorted
      .filter((item) => item.parsed.date.getTime() === lastTime)
      .sort((a, b) => compareStableId(a.stable_id, b.stable_id));
    const chosenLast = lastCandidates[0];

    if (lastCandidates.length > 1) stats.exact_last_tie_vins += 1;
    if (firstMonth !== chosenLast.parsed.month) stats.cross_month_vins += 1;
    recognizedSales.push(
      recognizedSale(chosenLast.row, chosenLast.parsed, 'vin_last_fecha_factura', vin),
    );
  }

  return {
    recognizedSales: sortRecognizedSales(recognizedSales),
    stats: {
      ...stats,
      distinct_non_null_vins: byVin.size,
      duplicate_excess_rows: stats.non_null_vin_rows - byVin.size,
      assignable_null_vin_rows: nullVinRecognized.length,
    },
  };
}


function recognitionEventBounds(startMonth, endMonth) {
  return {
    start: commercialMonthRange(startMonth).start.getTime(),
    end: commercialMonthRange(endMonth).end.getTime(),
  };
}

function recognitionEventCandidate(row, parsed, vin) {
  return {
    time: parsed.date.getTime(),
    stable_id: stableId(row.id),
    sale: recognizedSale(row, parsed, 'vin_last_fecha_factura', vin),
    count: 1,
  };
}

/**
 * Cutoff-safe transition projection of the same certified LAST fecha_factura/VIN
 * recognition rule used by resolveVentasRecognition.
 *
 * Consumers may project these transitions into historical snapshots, but they
 * must not implement an independent sales-recognition rule.
 */
export function buildVentasRecognitionEvents(rows, startMonth, endMonth) {
  const { start, end } = recognitionEventBounds(startMonth, endMonth);
  const byVin = new Map();
  const events = [];

  for (const row of rows || []) {
    const parsed = parseFechaFactura(row?.fecha_factura);
    if (!parsed || parsed.error) continue;
    const time = parsed.date.getTime();
    if (time < start || time > end) continue;
    const vin = normalizedVin(row?.nro_vin_chasis);

    if (vin == null) {
      events.push({ time, previous: null, next: recognizedSale(row, parsed, 'null_vin_row', null) });
      continue;
    }

    if (!byVin.has(vin)) byVin.set(vin, new Map());
    const byTime = byVin.get(vin);
    const current = byTime.get(time);
    if (!current) byTime.set(time, recognitionEventCandidate(row, parsed, vin));
    else {
      current.count += 1;
      if (compareStableId(stableId(row.id), current.stable_id) < 0) {
        const replacement = recognitionEventCandidate(row, parsed, vin);
        replacement.count = current.count;
        byTime.set(time, replacement);
      }
    }
  }

  let tieGroups = 0;
  for (const byTime of byVin.values()) {
    const sequence = [...byTime.values()].sort((a, b) => a.time - b.time);
    let previous = null;
    for (const item of sequence) {
      if (item.count > 1) tieGroups += 1;
      events.push({ time: item.time, previous, next: item.sale });
      previous = item.sale;
    }
  }

  events.sort((a, b) => a.time - b.time);
  return {
    authority: 'ventas_recognition_authority_v01',
    policy: 'LAST fecha_factura per VIN; lowest stable id only resolves exact-date ties',
    events,
    tie_groups_resolved: tieGroups,
  };
}
