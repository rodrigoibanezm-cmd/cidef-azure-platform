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

## Pendiente
- Certificación de las demás unidades y combinaciones P2; no están cubiertas por el Action de `observed_sequence`.
- Despliegue del servicio independiente `motor-test-azure`, autenticación externa e integración desde ChatGPT no validados por estos Actions. Las pruebas MCP se ejecutaron desde runners de GitHub.
- Operaciones de snapshots en Azure no validadas; implican DDL y no se ejecutaron.
