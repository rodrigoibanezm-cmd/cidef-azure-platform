# Bitácora — mejora de latencia del motor comercial

Actualizado: 2026-11-13. Estado: **desplegado; pendiente medición real de latencia y trazabilidad P3**.

## Problema y objetivo
Las consultas P1/P2/P4 del MCP `cidef-motor-test-azure` estaban tardando demasiado. Se busca separar el costo de selección de herramientas por el LLM del costo real de P1, SQL y reconstrucciones históricas, sin alterar cifras ni certificación. P1 aporta hechos certificados, P2 transformaciones deterministas, P3 evidencia/runs y P4 investigaciones.

## Evidencia inicial
- Consulta sencilla: promedio mensual de ventas de Virginia Tampoa (seller_id=232), mayo–octubre 2026. Resultado 119 VIN, 19,8/mes; reproducción directa 110,3 s, de los cuales 97,9 s en P1 según P3. Run: `audit-latency-sales-seller-232-1794326966875`.
- Control octubre: 22 VIN; 29,5 s totales, 28,3 s P1. Run: `audit-latency-sales-seller-232-control-1794327106916`.
- Esto demuestra lentitud dentro de P1 incluso sin búsqueda inicial del LLM. No atribuirla exclusivamente al modelo.

## Intervenciones de noviembre
1. Se avanzó en el resolvedor declarativo P1 y adaptadores SALES/FORUM/RVM, conservando contratos y trazabilidad; revisar historial Git para cambios previos específicos.
2. `331eefcf1bc53af0f5d8d50302b2c285ef9b6892`: caché por run de huella histórica SALES en `lib/data-floor/salesCertifier.js`.
3. `2e774835fbfeb5efda83b1a2fabb6c35622e7435`: propagación de `runId` desde `lib/data-floor/registry.js` para reutilizar la reconstrucción histórica en observaciones del mismo run.
4. Durante la validación se detectó código FORUM duplicado/corrupto y SQL UFIS malformado; reparaciones culminadas en `f4b9ad08e2433e84a20da1e53b10a23a315054b4`, que dejó `lib/data-floor/forum/observations.js` en 376 líneas. Este saneamiento fue necesario para cargar el registro del motor.
5. Prueba **local** con PostgreSQL simulado: dos observaciones SALES, mismo `run_id` y ventana, sucursales distintas. Reconstrucciones históricas: 2 antes, 1 después. Resultados por sucursal: 2 y 1 VIN; filtros, identificadores y 25 puntos de huella idénticos. Tiempo 22,0 ms antes y 21,5 ms después: **no extrapolar a Azure**.
6. Despliegue de `f4b9ad08`: GitHub Actions [run 43516131331](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/actions/runs/43516131331), job `132198433581`, PASS. Container App `cidef-motor-test-azure`, revisión activa `cidef-motor-test-azure--0000043`, imagen con tag del commit verificada en logs.

## Punto exacto actual
Se ejecutó un análisis comercial amplio Pajaritos vs Plaza Oeste (agosto–13 noviembre 2026, comparativo 2025, SALES y FORUM). Run reportado: `comparativo-pajaritos-plazaoeste-20261113-01`. La respuesta entregó cifras, pero **no entregó duración total ni desglose de P1/P2/P3/P4**. Por tanto, no está acreditado aún que el despliegue haya reducido la latencia real.

## Siguiente tarea: solo diagnóstico, sin modificar código
1. Recuperar en P3 el run `comparativo-pajaritos-plazaoeste-20261113-01` y verificar que exista.
2. Medir duración total, por herramienta, por motor y por operación SQL/reconstrucción histórica si la telemetría lo permite; distinguir tiempo LLM de backend.
3. Comparar con runs anteriores equivalentes solo cuando filtros, períodos y complejidad sean comparables. Verificar si la caché SALES realmente se reutilizó dentro de ese run.
4. Reportar números y cuello de botella restante; indicar campos no instrumentados. **No afirmar mejora por la prueba simulada**.
5. Si se identifica un problema nuevo, proponer un único cambio pequeño en una tarea posterior.

## Restricciones operativas
Una modificación funcional por ejecución; máximo dos archivos; pruebas mínimas locales; no ejecutar certificaciones/test en Actions; no desplegar sin autorización específica; separar diagnóstico, implementación y despliegue. No modificar contratos comerciales para acelerar consultas.
