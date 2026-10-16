export function buildMonthlySales(recognizedSales) {
  const counts = new Map();

  for (const sale of recognizedSales) {
    counts.set(sale.mes_venta, (counts.get(sale.mes_venta) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([month, sales]) => ({ month, sales }))
    .sort((a, b) => a.month.localeCompare(b.month));
}
