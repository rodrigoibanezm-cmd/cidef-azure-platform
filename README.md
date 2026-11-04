# CIDEF Azure Platform

Backend Azure: Azure Blob -> loaders -> PostgreSQL RAW/canónico -> P1/P2 -> API/MCP -> frontend.

## Premisas vigentes
- Azure es el único runtime objetivo. Neon/Vercel/R2 son legado de referencia, no dependencias de ejecución.
- P1 certifica hechos, identidad y universos; P2 calcula de forma determinista; P3 interpreta y registra trazabilidad.
- No reemplazar reglas por prompts, ni copiar Neon como ingesta, ni destruir maestros.
- El frontend staging y producción comparten datos PostgreSQL Azure: evitar escrituras de prueba.
- Cada indicador exige fuente, período, corte y contrato. No inferir éxito de producción desde un commit.

## Recursos
rg-cidef-prod; cidef-postgres-prod; cidefprodstorage; cidefprodacr; cidef-data-loader-job; cidef-motor-test-azure.

## Documentación
AGENTS.md contiene reglas operativas; docs/ARCHITECTURE.md describe el diseño; docs/MIGRATION-STATE.md es una fotografía histórica del 8 de octubre, no estado actual. Verificar Actions, revisiones desplegadas y datos antes de declarar un módulo completo.

## Cambio reciente
Commit 8a64533 (3 de noviembre): preservar VIN históricos ausentes del inventario abreviado. No prueba una carga productiva exitosa.
