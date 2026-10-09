# Azure SALES loader — isolation and safety

Source: original `scripts/refresh-azure-ventas-raw.js` from `cidef-data-loader/main`, copied on 2026-10-09. The loader is **not executed** by the CI workflow. No deployment occurs.

## Current behavior inherited from certified loader

- Reads latest matching XLSX from Azure Blob (`ventas/Estadisticas_de_Venta_por_Vista_`) or local `AZURE_SALES_XLSX_PATH`.
- Streams workbook with ExcelJS, normalizes `fecha_factura` serials, filters commercial brands/customer categories.
- Connects using `AZURE_DATABASE_URL` and Azure Blob connection string.
- **WARNING:** When executed, creates staging table then drops/replaces `ventas_raw` in target database; date overrides are subsequently applied. Never run against existing certified Azure production table until explicit approval, safety improvements and parity checks.
- No Neon dependencies.

## CI scope

`.github/workflows/build-sales-loader.yml` builds and syntax-checks an isolated Docker image. It does NOT push to ACR, update Container Apps Jobs, or run loader.

## Next gates

1. Refactor replace operation for safe atomic swap with schema/index/privilege compatibility.
2. Add unit tests for date conversion, category filters and workbook mapping.
3. Run against isolated Azure staging target.
4. Verify counts, VIN-level parity, dates and repeatability.
5. Only after approval, enable Azure deployment from this repo. Do not alter old repo/actions.
