import { parseFechaFactura } from './parseFechaFactura.js';
import { parseVentasCutoff } from './parseVentasCutoff.js';

function isInsideCutoff(parsed, cutoff) {
  if (!parsed || parsed.error) return false;
  if (cutoff.type === 'month' || cutoff.type === 'date') return parsed.date <= cutoff.end;
  return true;
}

export function filterVentasRowsThroughCutoff(rows, options = {}) {
  const cutoff = parseVentasCutoff(options);
  if (cutoff.type === 'none') {
    return { rows: [...rows], excluded: 0, cutoff };
  }

  const kept = [];
  let excluded = 0;

  for (const row of rows) {
    const parsed = parseFechaFactura(row?.fecha_factura);
    if (isInsideCutoff(parsed, cutoff)) kept.push(row);
    else excluded += 1;
  }

  return { rows: kept, excluded, cutoff };
}
