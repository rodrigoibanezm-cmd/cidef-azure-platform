const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function shiftMonth(month, delta) {
  const match = MONTH_RE.exec(String(month || ''));
  if (!match) return null;
  const base = Number(match[1]) * 12 + Number(match[2]) - 1 + delta;
  const year = Math.floor(base / 12);
  const value = (base % 12 + 12) % 12 + 1;
  return `${year}-${String(value).padStart(2, '0')}`;
}

export function buildSalesIndex(monthlySales) {
  const index = new Map();
  for (const row of monthlySales || []) {
    if (!MONTH_RE.test(String(row?.month || ''))) continue;
    const sales = Number(row?.sales);
    if (!Number.isFinite(sales)) continue;
    index.set(row.month, sales);
  }
  return index;
}

export function getSeries(index, targetMonth, offsets) {
  const values = [];
  for (const offset of offsets) {
    const month = shiftMonth(targetMonth, offset);
    if (!month || !index.has(month)) return null;
    values.push(index.get(month));
  }
  return values;
}

export function average(values) {
  if (!Array.isArray(values) || !values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
