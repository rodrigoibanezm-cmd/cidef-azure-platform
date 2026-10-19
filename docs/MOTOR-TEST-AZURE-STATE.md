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
- `motor-test-azure/server.js`: entrada HTTP independiente; reutiliza `createMcpServer()` y el transporte stateless del origen. `POST /api/mcp` exige bearer JWT Entra con scope delegado `access_as_user` o rol permitido; `GET /healthz` y `/readyz` son públicos, y `/readyz` ejecuta `SELECT 1`.
- `motor-test-azure/package.json` y `Dockerfile.motor-test-azure`: runtime Node aislado con `jose` para validación JWT; no modifica el runtime de `cidef-pg-mcp`. `MCP_AUTH_MODE=local-test` solo funciona en modo no productivo y enlazado a loopback.
- `.github/workflows/verify-motor-test-azure-entry.yml`: construye la imagen y verifica inicio, transporte y listado de herramientas sin secretos de base de datos. No despliega ni publica imagen.

## Dependencias
- El grafo de imports de `lib/mcp/server.js` contiene módulos locales en `lib/`; las dependencias externas de ejecución son `@modelcontextprotocol/sdk`, `zod` y `pg`.
- `package.json` raíz incluye `pg`, pero no el SDK MCP ni `zod`. El paquete aislado los declara para resolver imports desde `lib/` dentro de la imagen.
- El MCP requiere `AZURE_DATABASE_URL` para motores con acceso a datos. El inicio y `tools/list` no requieren conexión a base. `MCP_ENTRA_TENANT_ID`, `MCP_ENTRA_CLIENT_ID` y `MCP_PUBLIC_URL` son requeridos en runtime protegido.
- No usar `NEON_DATABASE_URL`, `DATABASE_URL` ni `POSTGRES_URL` como fallback.
- Las operaciones de snapshots realizan DDL y no forman parte de las pruebas de inicio.

## Despliegue independiente preparado
- El workflow manual [.github/workflows/deploy-motor-test-azure.yml](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/blob/main/.github/workflows/deploy-motor-test-azure.yml) construye la imagen y reutiliza `rg-cidef-prod`, ACR `cidefprodacr`, la identidad `id-cidef-azure-pg-mcp`, Container Apps Environment `cidef-prod-env` (usado por el despliegue exitoso del frontend en el Action 38809185012) y `AZURE_DATABASE_URL` del entorno `Production`. La verificación de `AcrPull` incluye asignaciones heredadas, igual que el workflow probado.
- El Action [39192734100](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/39192734100) creó `cidef-motor-test-azure`; su respuesta de Azure muestra `provisioningState: Succeeded`, `runningStatus: Running` y una revisión lista. Después, `az containerapp show` para consultar estado/FQDN recibió HTTP 503 HTML de ARM; Azure CLI intentó parsearlo como JSON (`JSONDecodeError`). Las verificaciones de salud, DB, OAuth y herramientas quedaron omitidas. Esto confirma el estado al cierre de ese Action, no el estado actual en vivo.
- Se registró un intento de `Microsoft.Authorization/roleAssignments/write` durante `az containerapp create --registry-identity`; fue no autorizado pero no bloqueó la creación. El workflow actual es update-only: exige que la Container App exista, revisa el `AcrPull` preexistente (incluyendo heredados) y no llama a la ruta de creación que activa el intento automático de asignar el rol. Los comandos de lectura de estado y la actualización de `MCP_PUBLIC_URL` reintentan hasta cuatro veces ante HTTP 503; otros errores no se reintentan.
- Las verificaciones de health, `SELECT 1`, metadata OAuth, rechazo anónimo (`401`), herramientas, SALES P1, P2 y P3 permanecen sin confirmar para el endpoint remoto: no llegaron a ejecutarse en 39192734100. No se pudo consultar el estado actual en vivo desde esta sesión (Azure CLI no está disponible localmente y la llamada HTTP al endpoint agotó el tiempo de espera).

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
- También existe en el origen el Action manual `refresh-azure-ventas-raw.yml`, que lee Blob, reemplaza `ventas_raw` en Azure y aplica los mismos overrides al finalizar. Se compararon las listas del origen, ese cargador directo y el loader aislado Azure: las tres coinciden exactamente (51 + 1). Esta carga directa no se ejecutó.
- El Action `validate-sales-2026-vin-dates-azure.yml` compara las 52 fechas en Neon y Azure con consultas dentro de transacciones `READ ONLY`, en dos lecturas independientes. No ejecuta cargas.
- El Action [39171133667](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/39171133667) se detuvo antes de conectar a las bases: faltan en el entorno `Production` los secretos de origen `NEON_DATABASE_URL`, `DATABASE_URL` y `POSTGRES_URL`. `AZURE_DATABASE_URL` pasó su validación de presencia. La paridad real de las 52 fechas sigue sin comprobarse.

## Matriz P2
- Registro de origen y Azure revisados en `main`: ambos tienen el mismo SHA de `lib/p2/registry.js` (`d3a3deeab679cdf84bdca9893528ae22e9e0f3c2`), 13 unidades activas y las mismas versiones/contratos.
- El Action manual [validate-motor-test-azure-p2-matrix.yml](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/workflows/validate-motor-test-azure-p2-matrix.yml) usa `AZURE_DATABASE_URL` del entorno `Production`: ejecuta dos veces cada unidad pendiente con evidencia P1 obtenida en la misma ejecución, compara resultados y consulta `run_trace`. En el run [39154653203](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/39154653203), las cuatro unidades históricas aquí señaladas se bloquearon antes de P2 con `HISTORICAL_SERIES_NOT_CERTIFIED`.
- `PASS` histórico corresponde a la ejecución exitosa del Action 39141980346. El Action registra `FAIL`, `REQUIRES_DATA` o `BLOCKED` por unidad y continúa con las independientes. Esta actualización reproduce únicamente los tests unitarios originales de los cuatro motores indicados; no cambia el estado de las demás unidades.

| Unidad (contrato) | Slots P1 requeridos por el contrato original | Estado comprobado |
|---|---|---|
| `p2.pricing_window_sales` v0.2.0 | `pricing: COMMERCIAL_CONDITION_WINDOWS`; `sales: SALES_WINDOW_OBSERVATIONS` | Pendiente |
| `p2.forum_snapshot_transitions` v0.1.0 | `baseline`, `comparison: OPERATION_STATE_SNAPSHOT` | Pendiente |
| `p2.open_period_deterioration_risk` v0.1.0 | `observed_to_cutoff: CUMULATIVE_PERIOD_OBSERVATION`; `model_history: HISTORICAL_PERIOD_SERIES` | P2 fixture PASS; P1→P2 real pendiente |
| `p2.forum_funnel_performance` v0.1.0 | `converted`, `approved`, `expired`, `rejected: DIMENSIONAL_QUANTITATIVE_DATASET` | Pendiente |
| `p2.target_attainment_probability` v0.1.0 | `observed_to_cutoff: CUMULATIVE_PERIOD_OBSERVATION`; `target: REFERENCE_OBSERVATION`; `model_history: HISTORICAL_PERIOD_SERIES` | P2 fixture PASS; P1→P2 real pendiente |
| `p2.reconciled_seller_target_contribution` v0.1.0 | `seller_observed_to_cutoff: DIMENSIONAL_QUANTITATIVE_DATASET`; `seller_history: SELLER_CONTRIBUTION_HISTORY`; `store_target: REFERENCE_OBSERVATION`; `store_completion_history: HISTORICAL_PERIOD_SERIES` | P2 fixture PASS; P1→P2 real pendiente |
| `p2.reference_deviation` v0.1.0 | `observed: CUMULATIVE_PERIOD_OBSERVATION`; `reference: REFERENCE_OBSERVATION` | Pendiente |
| `p2.proportion_across_periods` v0.1.0 | `part_series`, `universe_series: PERIOD_OBSERVATION_SERIES` | Pendiente |
| `p2.observed_pair_delta` v0.1.0 | `baseline`, `comparison: QUANTITATIVE_OBSERVATION` | Pendiente |
| `p2.part_to_universe_ratio` v0.1.0 | `part`, `universe: QUANTITATIVE_OBSERVATION` | Pendiente |
| `p2.observed_sequence` v0.1.0 | `sequence: PERIOD_OBSERVATION_SERIES` | PASS — Action 39141980346 |
| `p2.period_close_estimate` v0.1.0 | `observed_to_cutoff: CUMULATIVE_PERIOD_OBSERVATION`; `period_calendar: PERIOD_CALENDAR`; `model_history: HISTORICAL_PERIOD_SERIES` | P2 fixture PASS; P1→P2 real pendiente |
| `p2.reconciled_dimension_delta` v0.1.0 | `baseline_by_member`, `comparison_by_member: DIMENSIONAL_QUANTITATIVE_DATASET` | Pendiente |

## Pruebas P2 reproducidas en Azure
- Se copiaron literalmente los tests originales del origen: `test/p2-open-period-deterioration-risk.test.js`, `test/p2-target-attainment-seller-contribution.test.js` y `test/p2-vertical-slice.test.js`.
- `node --test --test-name-pattern='open-period deterioration risk|E06|target attainment|seller target contribution'` pasó 11/11 pruebas. Usaron los fixtures originales y los ejecutores Azure. Son pruebas unitarias de cálculo P2; no conectan a Neon/Azure ni escriben P3.
- `lib/p2/execute.js`, `lib/p2/registry.js` y los cuatro ejecutores tienen SHA idéntico al origen. Esto no certifica la integración P1→P2 ni la disponibilidad de la serie histórica real.

## Pendiente
- La integración P1→P2 real de estas cuatro unidades sigue pendiente: el Action 39154653203 recibió `HISTORICAL_SERIES_NOT_CERTIFIED` antes de invocar P2. Los slots de la tabla describen los contratos; no prueban disponibilidad de evidencia en Azure.
- No se añadieron ni ejecutaron tests unitarios de las otras unidades en esta actualización; se conserva su estado previo.
- `forum_snapshot_transitions` necesita dos snapshots diarios certificados distintos; el Action buscará snapshots en los 30 días previos. Si no los encuentra, registrará `REQUIRES_DATA`.
- No declarar certificación completa de P2 ni paridad funcional total.
- Despliegue del servicio independiente `motor-test-azure`, OAuth delegado de extremo a extremo con ChatGPT e integración desde ChatGPT siguen sin validar. El MCP original en `cidef-data-loader` no valida autenticación en `api/mcp.js`; la entrada Azure sí exige JWT Entra.
- ChatGPT requiere OAuth de usuario para un MCP protegido; no usa client credentials ni claves API personalizadas. La entrada anuncia `access_as_user`, pero el registro Entra debe permitir el callback OAuth de ChatGPT y emitir el scope/audience esperado. Ese flujo interactivo no se ha probado.
- Operaciones de snapshots en Azure no validadas; implican DDL y no se ejecutaron.
