export function validateVentasContext(recognizedSales, monthlySales, stats) {
  const recognizedUnits = recognizedSales.length;
  const monthlyUnits = monthlySales.reduce((sum, row) => sum + row.sales, 0);
  const expectedAssignableUnits =
    stats.assignable_non_null_vins + stats.assignable_null_vin_rows;

  const warnings = [];
  if (stats.null_fecha_factura_rows) {
    warnings.push(`${stats.null_fecha_factura_rows} rows have null/blank fecha_factura`);
  }
  if (stats.unparseable_fecha_factura_rows) {
    warnings.push(`${stats.unparseable_fecha_factura_rows} rows have unparseable fecha_factura`);
  }
  if (stats.excluded_vins_with_date_errors) {
    warnings.push(
      `${stats.excluded_vins_with_date_errors} non-null VINs have invalid/missing fecha_factura and were excluded`,
    );
  }
  if (stats.unassignable_null_vin_rows) {
    warnings.push(
      `${stats.unassignable_null_vin_rows} null-VIN rows have invalid/missing fecha_factura and were excluded`,
    );
  }
  if (stats.exact_last_tie_vins) {
    warnings.push(
      `${stats.exact_last_tie_vins} VINs have an exact LAST fecha_factura tie; lowest stable id was used`,
    );
  }

  const ok = recognizedUnits === monthlyUnits && recognizedUnits === expectedAssignableUnits;
  if (!ok) warnings.push('Ventas context reconciliation failed');

  return {
    validation: {
      recognized_units: recognizedUnits,
      monthly_units: monthlyUnits,
      expected_assignable_units: expectedAssignableUnits,
      recognized_matches_monthly: recognizedUnits === monthlyUnits,
      recognized_matches_expected: recognizedUnits === expectedAssignableUnits,
      ok,
    },
    warnings,
  };
}
