# motor-test Azure — estado comprobado (2026-10-17)

## Propósito y autoridad
- Réplica del MCP `motor-test` certificado, origen de código: `rodrigoibanezm-cmd/cidef-data-loader`.
- Destino: este repositorio, rama `main`. Origen y Neon intocables; no son dependencias de ejecución Azure.
- Contratos, herramientas, cálculos y reglas comerciales deben permanecer iguales al origen. Sin rediseños.
- El MCP PostgreSQL existente (`mcp/server.js`, `cidef-pg-mcp`) es **otro servicio**; no reemplazarlo.

## Código presente
- `lib/mcp/server.js`: copia idéntica al origen (blob SHA `006fdf6966954906855ce7baa82f3b484bd4cf6b`). Herramientas declaradas: `data_describe`, `data_inspect`, `data_fetch`, `data_resolve`, `data_observe`, `crm_observe_many`, `sales_observe_many`, `sales_observe_windows`, `p2_discover`, `p2_describe`, `p2_execute`, `run_trace`.
- `lib/p2/`: 16 archivos copiados, SHA 16/16 coincidente con origen al copiar (commit `c172327`).
- `lib/data-floor/registry.js`: copia idéntica al origen; registradores/certificadores P1 y dependencias SALES copiadas progresivamente.
- `lib/data-floor/identityResolver.js` y `lib/p3/executionJournal.js` presentes; el segundo fue adaptado para Azure.
- `lib/neon.js` en este repositorio **no conecta a Neon**: adaptador de API histórica a `lib/azure-postgres.js` (nombre heredado para compatibilidad).
- `lib/motors/ventas-monthly-dedup-sensitivity-v01.js` adaptado para eliminar cliente Neon directo.

## Ejecución y dependencias
- Base de datos de este código: PostgreSQL Azure vía `AZURE_DATABASE_URL` exclusivamente, driver `pg` en `package.json` raíz.
- `lib/azure-postgres.js`: `azureQuery`, `getAzurePool`, `closeAzurePool` y compatibilidad SQL.
- `lib/neon.js`: `queryDb`, `queryDbTransaction`, métodos de append/snapshot de tablas. Snapshots implican DDL (`CREATE/DROP/ALTER`).
- `lib/p3/executionJournal.js`: usa conexión Azure; puede crear tablas de trazabilidad al inicializar.
- SDK MCP y `zod` están declarados en `mcp/package.json`, **no** en `package.json` raíz. No hay entrada HTTP `api/mcp.js` para el motor de Azure; `mcp/server.js` es el MCP PostgreSQL existente.

## Validación efectuada
- `lib/mcp/server.js` SHA idéntico (commit `32070a7`); `registry.js` SHA idéntico (commit `0d71b61`).
- Adaptador y accesos directos adaptados: commit `beb1211`. Pruebas previas con `pg` simulado: consulta, transacción y snapshot; no equivalen a prueba real de snapshots.
- Action `.github/workflows/validate-azure-postgres-adapter.yml`, ejecución `39051308990` (**success**, 2026-10-17, commit `1ef8327`): `SELECT 1` usando `lib/neon.js`, conexión real por `AZURE_DATABASE_URL`, transacción `BEGIN READ ONLY` + `ROLLBACK`, sin fallback a Neon. Sin cambios de datos/esquema.
- Migración y conciliaciones P1 SALES/RVM/CRM/FORUM se trabajaron previamente; FORUM P1 fue validado. Eso **no** certifica todavía al MCP de motores completo.

## Aún NO validado / NO operativo como réplica completa
- Operaciones de snapshots reales en PostgreSQL Azure (son potencialmente destructivas).
- Carga integral de dependencias del MCP, herramientas y contratos en ejecución real.
- Equivalencia determinística P1/P2 extremo a extremo y trazabilidad P3 en Azure.
- Entrada HTTP independiente, autenticación, despliegue y conexión a ChatGPT del MCP de motores.

## Restricciones operativas actuales
- No usar Neon, `DATABASE_URL` ni `POSTGRES_URL` como fallback.
- No modificar origen, reglas certificadas, `mcp/server.js`, ni desplegar hasta validar lo requerido.
- No declarar paridad funcional completa por una prueba de conexión exitosa.
