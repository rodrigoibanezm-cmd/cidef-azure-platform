# motor-test Azure — estado comprobado

## Propósito y autoridad
- Réplica del MCP `motor-test` certificado, origen: `rodrigoibanezm-cmd/cidef-data-loader`.
- Destino: este repositorio, rama `main`. Origen y Neon no son dependencias de ejecución Azure.
- Mantener contratos, herramientas, cálculos y reglas comerciales del origen.
- `mcp/server.js` (`cidef-pg-mcp`) es otro servicio; no modificarlo ni reemplazarlo.

## Componentes
- `lib/mcp/server.js`: servidor de motores copiado del origen; declara las 12 herramientas P1/P2/P3.
- `lib/p2/`: unidades P2 copiadas del origen.
- `lib/data-floor/registry.js`: registradores/certificadores P1 y dependencias SALES.
- `lib/data-floor/identityResolver.js`: resolución de identidades.
- `lib/p3/executionJournal.js`: trazabilidad P3 adaptada a Azure.
- `lib/neon.js`: adaptador de compatibilidad; usa `lib/azure-postgres.js`, no conecta a Neon.
- `lib/azure-postgres.js`: PostgreSQL Azure por `AZURE_DATABASE_URL`, driver `pg`.
- `motor-test-azure/server.js`: entrada HTTP independiente; reutiliza `createMcpServer()` y `StreamableHTTPServerTransport` stateless del origen. Acepta MCP en `POST /api/mcp`; `GET /healthz` es health check.
- `motor-test-azure/package.json` y `Dockerfile.motor-test-azure`: runtime Node aislado para esa entrada; no modifica el runtime de `cidef-pg-mcp`.
- `.github/workflows/verify-motor-test-azure-entry.yml`: construye la imagen y verifica inicio, transporte y listado de herramientas sin secretos de base de datos. No despliega ni publica imagen.

## Dependencias
- El grafo de imports de `lib/mcp/server.js` contiene módulos locales en `lib/`; las dependencias externas de ejecución son `@modelcontextprotocol/sdk`, `zod` y `pg`.
- `package.json` raíz incluye `pg`, pero no el SDK MCP ni `zod`. El paquete aislado los declara para resolver imports desde `lib/` dentro de la imagen.
- El MCP requiere `AZURE_DATABASE_URL` al invocar motores con acceso a datos. La carga del módulo, el inicio HTTP y `tools/list` no requieren conectar a una base.
- No usar `NEON_DATABASE_URL`, `DATABASE_URL` ni `POSTGRES_URL` como fallback.
- Las operaciones de snapshots realizan DDL y no forman parte de las pruebas de inicio.

## Validación comprobada en Azure
- Esquema P3: inicializado y existente en Azure. Action [39137710513](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/39137710513) pasó conexión, `SELECT 1`, transacción `READ ONLY` + `ROLLBACK` y comparación de columnas, claves e índices requeridos por `executionJournal.js`: 4 claves requeridas, 0 diferencias.
- P1 SALES: Action [39140996041](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/39140996041) pasó `data_observe` por el transporte HTTP MCP independiente contra Azure. Evidencia `P1_CERTIFIED` para `2026-09`, valor 1040; `run_trace` encontró el evento P3.
- P2/P3: Action [39141980346](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/39141980346) pasó `p2_discover`, `p2_describe` y `p2_execute` para `p2.observed_sequence` v0.1.0, usando SALES real de `2026-07` a `2026-09` (901, 1202, 1040). La repetición produjo resultado determinístico; `run_trace` devolvió los eventos P1 y dos eventos P2.
- Los tres Actions terminaron en `success`. Ejecutaron mediante `lib/neon.js -> lib/azure-postgres.js` con `AZURE_DATABASE_URL`; los logs confirman que no hubo conexión ni fallback a Neon.
- El resultado valida la unidad `observed_sequence` y este flujo probado. No constituye certificación completa de P2 ni de paridad funcional de todos los motores.

## Sincronización SALES Neon → Azure
- El flujo certificado en `cidef-data-loader/.github/workflows/refresh-sales-sources.yml` es manual: refresca las fuentes SALES en Neon y luego ejecuta `scripts/sync-ventas-raw-neon-azure.js`.
- `import-estadisticas-venta.js` aplica las fechas certificadas después de reemplazar el snapshot de Neon: 51 VIN → `2026-08-31`; 1 VIN → `2026-09-01`.
- El sincronizador compara todas las columnas de `ventas_raw` por `id`, inserta filas faltantes, actualiza filas distintas desde Neon, elimina filas solo de Azure y verifica paridad exacta antes del commit. Repetirlo sin cambios de origen deja el mismo estado final.
- En Azure, `src/loaders/ventas-raw.js` contiene las mismas listas, pero su guardia solo permite `ventas_raw_azure_validation`; no es la ruta productiva.
- El Action `validate-sales-2026-vin-dates-azure.yml` compara las 52 fechas en Neon y Azure con consultas dentro de transacciones `READ ONLY`, en dos lecturas independientes. No ejecuta cargas.
- El Action [39171133667](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/39171133667) se detuvo antes de conectar a las bases: faltan en el entorno `Production` los secretos de origen `NEON_DATABASE_URL`, `DATABASE_URL` y `POSTGRES_URL`. `AZURE_DATABASE_URL` pasó su validación de presencia. La paridad real de las 52 fechas sigue sin comprobarse.

## Matriz P2
- Registro de origen y Azure revisados en `main`: ambos tienen el mismo SHA de `lib/p2/registry.js` (`d3a3deeab679cdf84bdca9893528ae22e9e0f3c2`), 13 unidades activas y las mismas versiones/contratos.
- El Action manual [validate-motor-test-azure-p2-matrix.yml](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/workflows/validate-motor-test-azure-p2-matrix.yml) está preparado para usar `AZURE_DATABASE_URL` del entorno `Production`. Ejecuta dos veces cada unidad pendiente con evidencia P1 obtenida en la misma ejecución, compara resultados y consulta `run_trace`. No se ha ejecutado.
- `PASS` histórico corresponde a la ejecución exitosa del Action 39141980346. Las otras unidades permanecen pendientes hasta ejecutar el Action. El Action registra `FAIL`, `REQUIRES_DATA` o `BLOCKED` por unidad y continúa con las independientes.

| Unidad (contrato) | Slots P1 requeridos por el contrato original | Estado comprobado |
|---|---|---|
| `p2.pricing_window_sales` v0.2.0 | `pricing: COMMERCIAL_CONDITION_WINDOWS`; `sales: SALES_WINDOW_OBSERVATIONS` | Pendiente |
| `p2.forum_snapshot_transitions` v0.1.0 | `baseline`, `comparison: OPERATION_STATE_SNAPSHOT` | Pendiente |
| `p2.open_period_deterioration_risk` v0.1.0 | `observed_to_cutoff: CUMULATIVE_PERIOD_OBSERVATION`; `model_history: HISTORICAL_PERIOD_SERIES` | Pendiente |
| `p2.forum_funnel_performance` v0.1.0 | `converted`, `approved`, `expired`, `rejected: DIMENSIONAL_QUANTITATIVE_DATASET` | Pendiente |
| `p2.target_attainment_probability` v0.1.0 | `observed_to_cutoff: CUMULATIVE_PERIOD_OBSERVATION`; `target: REFERENCE_OBSERVATION`; `model_history: HISTORICAL_PERIOD_SERIES` | Pendiente |
| `p2.reconciled_seller_target_contribution` v0.1.0 | `seller_observed_to_cutoff: DIMENSIONAL_QUANTITATIVE_DATASET`; `seller_history: SELLER_CONTRIBUTION_HISTORY`; `store_target: REFERENCE_OBSERVATION`; `store_completion_history: HISTORICAL_PERIOD_SERIES` | Pendiente |
| `p2.reference_deviation` v0.1.0 | `observed: CUMULATIVE_PERIOD_OBSERVATION`; `reference: REFERENCE_OBSERVATION` | Pendiente |
| `p2.proportion_across_periods` v0.1.0 | `part_series`, `universe_series: PERIOD_OBSERVATION_SERIES` | Pendiente |
| `p2.observed_pair_delta` v0.1.0 | `baseline`, `comparison: QUANTITATIVE_OBSERVATION` | Pendiente |
| `p2.part_to_universe_ratio` v0.1.0 | `part`, `universe: QUANTITATIVE_OBSERVATION` | Pendiente |
| `p2.observed_sequence` v0.1.0 | `sequence: PERIOD_OBSERVATION_SERIES` | PASS — Action 39141980346 |
| `p2.period_close_estimate` v0.1.0 | `observed_to_cutoff: CUMULATIVE_PERIOD_OBSERVATION`; `period_calendar: PERIOD_CALENDAR`; `model_history: HISTORICAL_PERIOD_SERIES` | Pendiente |
| `p2.reconciled_dimension_delta` v0.1.0 | `baseline_by_member`, `comparison_by_member: DIMENSIONAL_QUANTITATIVE_DATASET` | Pendiente |

## Pendiente
- No hay validación de ejecución para las 12 unidades pendientes hasta ejecutar el Action manual. Los slots de la tabla describen los contratos, no prueban disponibilidad de evidencia en Azure.
- `forum_snapshot_transitions` necesita dos snapshots diarios certificados distintos; el Action buscará snapshots en los 30 días previos. Si no los encuentra, registrará `REQUIRES_DATA`.
- No declarar certificación completa de P2 ni paridad funcional total.
- Despliegue del servicio independiente `motor-test-azure`, autenticación externa e integración desde ChatGPT no están validados por estos Actions.
- Operaciones de snapshots en Azure no validadas; implican DDL y no se ejecutaron.
