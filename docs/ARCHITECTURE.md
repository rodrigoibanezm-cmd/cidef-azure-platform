# Azure platform — architecture contract

## Runtime

- Storage: Azure Blob Storage, cuenta `cidefprodstorage` (Chile Central), contenedor `cidef` para fuentes de operación según configuración efectiva.
- Compute: Azure Container Apps Jobs (ingesta), servicios Azure por definir para API y MCP.
- DB: Azure PostgreSQL Flexible Server `cidef-postgres-prod.postgres.database.azure.com`, PostgreSQL 17, base `postgres`.
- Container registry: `cidefprodacr`.
- Resource group: `rg-cidef-prod`; suscripción: `ANAC-AZURE`.

## Data flow

Origen externo → Azure Blob (archivo versionado) → loader streaming validado → tabla RAW → canonicalización → motores → API/MCP.

## Independence

- NO usar secrets, deployment environments ni workflows del repositorio antiguo por defecto.
- NO registrar trabajos Azure que modifiquen Neon.
- NO copiar tablas Neon → Azure como pipeline de producción.
- Mantener contratos del negocio comprobados; adaptar implementación a PostgreSQL Azure.
- Registrar fuente, corte, versión de archivo, ejecución, conteos, rechazos y auditoría.
- Evitar replace destructivo de tablas sin controles transaccionales, respaldo y autorización.

## Delivery

GitHub Actions + federated OIDC independiente, ACR, Azure Container Apps, tests y validación contra fuentes. Credencial federada del repositorio anterior no cubre necesariamente este repositorio.
