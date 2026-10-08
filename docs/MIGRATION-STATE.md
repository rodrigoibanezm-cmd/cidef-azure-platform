# Migration state — 2026-10-08

## Separate systems

LEGACY: `rodrigoibanezm-cmd/cidef-data-loader` → Neon + Vercel + R2. Mantener íntegro y operativo.
AZURE: `rodrigoibanezm-cmd/cidef-azure-platform` → loaders y motores nuevos Azure. Repositorio separado.

## Verified Azure `ventas_raw`

Query reported from Azure PostgreSQL on 2026-10-08:

- total rows: 46,185
- Excel serial dates unconverted: 0
- min fecha_factura: 2020-05-31
- max fecha_factura: 2026-10-07

Prior reconciliation with Neon: 46,185 rows, 45,238 distinct VINs; Cliente General 24,376; Concesionaria 21,809. Detailed VIN-by-VIN parity not yet certified.

Existing Azure streaming loader is in the old repository at `scripts/refresh-azure-ventas-raw.js`; date conversion was corrected in commit `61ddd38`. Its build workflow is `.github/workflows/build-azure-data-loader-image.yml`. **Do not disable, delete or modify existing Actions during repository bootstrap.** The job/image deployment should eventually be owned by this new repository after independent CI/CD is verified.

## Canonical vehicle dependencies

Old canonical implementation: `lib/canonical/refresh-vehiculo-canonico-v01.js`.
Inputs: `vehiculos_raw`, `ventas_raw`, `notas_venta_raw`, `producto_aliases_v01`, and vehicle salida logic. It validates VIN formatting, duplication, product conflict and channel resolution. Rebuild on Azure should preserve these semantic checks.

## Pending

- Dedicated GitHub OIDC trust for `cidef-azure-platform` (and environment if used).
- Restore Azure loader code and tests here without altering old repo.
- Ensure Blob filenames/schemas are verified before implementing `vehiculos_raw` loading.
- Run loaders against Azure staging or isolated targets; preserve currently verified tables until new pipeline certified.
