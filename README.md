# CIDEF Azure Platform

Plataforma independiente de ingesta, normalización, motores, APIs y MCP de CIDEF sobre Azure.

## Reglas invariables

- La operación Neon/Vercel/R2 en `rodrigoibanezm-cmd/cidef-data-loader` sigue activa y no se modifica desde este repositorio.
- Nunca copiar tablas desde Neon como mecanismo de ingesta. Leer fuentes originales, almacenar respaldos en Azure Blob y procesarlas en Azure.
- Neon puede consultarse para conciliación de resultados, no es una dependencia de ejecución.
- Ninguna publicación o actualización de este repositorio debe desplegar en la infraestructura de Neon/Vercel.
- PostgreSQL Azure es la base de esta plataforma; operaciones destructivas requieren autorización explícita.
- No declarar una vertical certificada sin pruebas reproducibles y conciliación.

## Estado inicial

Repositorio nuevo, sin despliegue automático habilitado. La carga de `ventas_raw` ya se validó en Azure usando el proceso existente; su código y pipeline todavía deben trasladarse y certificarse aquí antes de sustituir ese despliegue.

## Orden de construcción

1. Configurar autenticación OIDC GitHub → Azure específica de esta repo.
2. Trasladar loader streaming de `ventas_raw` y pipeline, conservando el Job de Azure hasta probar la nueva ruta.
3. Implementar loader de `vehiculos_raw` desde archivos fuente de Azure Blob.
4. Incorporar dependencias canónicas y sus pruebas (`notas_venta_raw`, alias de producto, reglas de salida).
5. Implementar progresivamente motores SALES, RVM, CRM, PRICING y FORUM en Azure.

Ver `docs/ARCHITECTURE.md` y `docs/MIGRATION-STATE.md`.
