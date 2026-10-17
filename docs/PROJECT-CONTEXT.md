# Contexto operativo — Migración CIDEF a Azure
Actualizado: 2026-10-17. Este documento describe decisiones y resultados reportados; comprobar el estado vivo en Azure antes de afirmar disponibilidad.

## Meta
Sustituir Vercel/Neon por **una sola plataforma productiva en Azure**. No es una convivencia permanente ni arquitectura híbrida. Mantener el legacy operativo e intacto hasta la transición validada, sin obligar a los nuevos fronts a consultar Neon.

## Arquitectura
`Fuentes originales -> Azure Blob (cidefprodstorage/cidef) -> loaders -> PostgreSQL Flexible Server cidef-postgres-prod -> universos/maestros -> P1 -> P2 -> API/MCP Azure -> front Azure Container Apps`.
Código y CI/CD en GitHub. Backend: `cidef-azure-platform`; front: `cidef-inteligencia-comercial`. El contenedor desplegado ejecuta `mcp/server.js`; **no asumir** que registra automáticamente las herramientas declaradas en `lib/mcp/server.js`.

## Estado de motores reportado
- P1 SALES, RVM, CRM, FORUM y PRICING clonados y operativos sobre Azure PostgreSQL, con pruebas de paridad específicas contra Neon; último despliegue general P1 exitoso reportado: GitHub Actions run 39040712355.
- P2: se identificaron 13 unidades en `lib/p2/registry.js`, pero sus herramientas genéricas `p2_discover`, `p2_describe` y `p2_execute` no están expuestas actualmente por el entrypoint MCP desplegado. Verificar al implementar.
- SALES desplegado expone `ventas_monthly_actual_v01` con período/corte mensual; para «Cómo vamos» faltan corte diario, dimensión marca y series/observaciones ampliadas que existen en el origen.
- FORUM expone `forum_data_observe`: QUOTATIONS y UFIS disponibles. **Precurse no tiene aún indicador P1 propio**: no sustituir por APPLICATIONS.
- RVM expone `rvm_data_observe` para unidades y series; el porcentaje de participación requiere numerador/denominador comparables certificados por P1 y cálculo P2 publicado. No unir `DFM`, `DONGFENG` y `DONG FENG` por texto.
- CRM y PRICING ya desplegados, aunque no están entre las seis cards iniciales.
- Datos de PRICING del 14-10-2026 conciliados en Azure: 64/64 registros; 899/899 episodios; versiones DONGFENG 007 y 008 incluidas. FORUM septiembre: ocho indicadores conciliados. Estas son verificaciones de los cortes indicados, no garantías de frescura futura.

## Front mensual — decisión de producto
- `/como-vamos` sigue siendo placeholder; no recibe indicadores en vivo.
- Crear primero vista Compañía con **seis cards**: Ventas, Cotizaciones, Precurse, UFIs ejecutadas, RVM inscripciones, participación RVM. Todas con total CIDEF, FOTON y DONGFENG; series mensuales comparables, evolución del mes abierto y corte explícito por fuente.
- Al **abrir el front** y al cambiar el período, consulta al backend para la evidencia más reciente disponible. Sin despliegues diarios ni textos/cálculos comerciales hardcodeados; usar P1 + P2. Si falta contrato o fuente, mostrar indisponibilidad.
- La API de servidor del front consulta MCP/API Azure con autenticación Entra de servidor, sin mostrar secretos al navegador; evitar caché de resultados obsoletos.
- No integrar el antiguo `/api/health/database` que usa Neon a la nueva ruta viva. Revisar y retirar dependencias legacy cuando corresponda en migración específica.
- `/cierre-mensual` permanece como foto inmóvil: no modificar JSON ni su semántica ahora. Hay discrepancias históricas de conteos SALES en ese cierre que requieren auditoría por separado.
- La lectura ejecutiva automática queda pendiente para una etapa posterior.

## Siguiente trabajo (secuencia)
1. Completar y publicar en el **MCP realmente desplegado** las observaciones P1 SALES con corte diario, marca y series; definir y certificar la medida Precurse sin confundirla con APPLICATIONS.
2. Exponer P2 requerido para proporciones, evolución y comparaciones; fijar universo de participación RVM e identidad comercial de marca usando contratos certificados.
3. Comprobar credenciales, permisos y conectividad server-to-server de front Azure a motores Azure. Definir endpoint agregador liviano: sin lógica comercial duplicada.
4. Construir las seis cards vivas en `/como-vamos`; validar cifras, cortes y actualizaciones al abrir.
5. Solo al final, lectura ejecutiva dinámica.

## Forma de trabajar
Continuar por diagnóstico -> propuesta -> implementación cuando la tarea sea amplia. Pedir a Codex que lea este documento y `AGENTS.md` al comenzar cada nueva sesión. Mantener prompts breves. No repetir importaciones ni reconstruir infraestructura o motores funcionales. No alterar `cidef-data-loader`, Neon, Vercel ni el cierre mensual salvo autorización específica.
