import { parseFechaFactura } from '../motors/ventas-monthly-dedup-sensitivity-v01.js';

export function findTrainingStartMonth(rows, endMonth) {
  let first = null;
  for (const row of rows || []) {
    const parsed = parseFechaFactura(row?.fecha_factura);
    if (!parsed || parsed.error || parsed.month > endMonth) continue;
    if (first == null || parsed.month < first) first = parsed.month;
  }
  if (!first) throw new Error('No parseable ventas history found through end_month');
  return first;
}
