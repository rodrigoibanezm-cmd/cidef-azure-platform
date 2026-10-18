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

## Validación
- El Action `validate-azure-postgres-adapter.yml`, run `39051308990`, pasó conexión real, `SELECT 1` mediante `lib/neon.js` y transacción `BEGIN READ ONLY` + `ROLLBACK`.
- El workflow nuevo verifica el MCP en contenedor sin configuración de base: inicio, transporte HTTP Streamable, y las 12 herramientas. No invoca herramientas de negocio ni escribe datos.
- No declarar paridad funcional completa por conexión o prueba de inicio exitosa.

## Pendiente
- Ejecutar el nuevo workflow y confirmar el resultado del runtime.
- Despliegue, autenticación externa y conexión a ChatGPT del MCP de motores siguen fuera de esta preparación.
- Equivalencia determinística P1/P2 y trazabilidad P3 extremo a extremo en Azure siguen pendientes.
- Snapshots reales en Azure no validados.
