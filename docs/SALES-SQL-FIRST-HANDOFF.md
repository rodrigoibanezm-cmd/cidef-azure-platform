# P1 SALES SQL-first — handoff para LLM
Actualizado: 2026-11-18. Estado: implementación parcial en main, SIN validación posterior ni despliegue confirmado.

## Instrucciones de lectura
Leer primero AGENTS.md, luego este documento, luego docs/MOTOR-LATENCY-IMPROVEMENT-LOG.md. Comprobar el estado real de main y del despliegue antes de actuar. Esta nota prevalece para la decisión reciente SQL-first; la bitácora anterior documenta etapas históricas.

## Objetivo y problema observado
Reducir latencia de P1 SALES sin alterar resultados certificados. Consultas pequeñas cargaban y procesaban ~47.000 filas de ventas_raw, catálogos y relaciones, además de calcular fingerprint sobre todo el input. Se observaron latencias excesivas incluso en una llamada directa, sin decisiones adicionales del LLM: vendedor Virginia Tampoa, 119 VIN mayo-octubre 2026, 97,9 s en P1 y 110,3 s totales; octubre 22 VIN, 28,3 s en P1. Ver bitácora para runs.
La selección inicial de herramientas por el LLM también introduce variabilidad, pero NO explica toda la latencia.

## Hipótesis y evidencia
Ejecutar primero SQL selectivo en Azure PostgreSQL para obtener VIN candidatos y cargar solo sus filas relacionadas; después aplicar reconocimiento/certificación P1 existente. No reemplazar las reglas comerciales de P1 por SQL ad hoc.
Caso acotado validado mediante scripts/diagnose-sales-first-cut.mjs y scripts/semantic-sales-prototype.mjs:
- OWN_STORES, brand_id=89, model_id=28, store_id=4, 2026-08-01 a 2026-08-31 (Foton G7, Pajaritos).
- SQL selectivo: 4 VIN; P1 completo: 4 VIN; sin registros faltantes/sobrantes en comparación realizada.
- El SQL de candidatos es experimental y NO constituye certificación universal de P1.
- Una medición anterior de P1 completo: 10.644 ms; preparación 7.339 ms; fingerprint 3.686 ms. Otra: 11.683 ms; preparación 8.492 ms; fingerprint 4.402 ms. No extrapolar estas mediciones a todos los casos.
- El fingerprint completo de las ~47.000 filas es costoso. No eliminar fingerprints de contratos/evidencias sin revisar consumidores.

## Decisiones cerradas por el usuario
1. SQL selectivo primero, sobre PostgreSQL existente; no cargar todas las ventas si el filtro permite reducir candidatos.
2. Reutilizar resultados y preparación SOLO dentro del mismo run_id. Entre runs, volver a consultar. P3 mantiene evidencia/trazabilidad y reutilización existente.
3. NO agregar cachés persistentes, tablas auxiliares, snapshots, versiones mensuales ni invalidación cross-run para esta optimización.
4. Reutilizar código existente, preservar P1/P2/P3 y exactitud comercial.
5. Una modificación funcional por ejecución, máximo dos archivos, pruebas mínimas, sin despliegue automático; separar implementación, validación y despliegue.
6. Priorizar cambios concretos, pequeños y medibles; no reabrir discusión arquitectónica ya resuelta.

## Estado exacto del código (verificar en main)
- scripts/semantic-sales-prototype.mjs: semanticSalesCandidates() obtiene VIN candidatos mediante SQL con filtros de sucursal, marca, modelo, mes; está declarado experimental/no certificado.
- lib/ventas/loadVentasRows.js: loadVentasRows(sql, candidateVins) ya admite filtrado de filas relacionadas por VIN.
- lib/data-floor/sales/preparation.js: prepareSalesInput({candidateVins,timings,fingerprint}) admite cargar filas por VIN; createSalesPreparation conserva reconocimiento P1 y fingerprint opcional.
- lib/data-floor/runUniverses.js: createRunUniverses() comparte preparación/universos por run_id, con limpieza por inactividad. Mantener este comportamiento.
- lib/data-floor/sales/factSet.js: mantiene certificación, selecciones y huellas de evidencia.
- Commit 84771ae6caa378c535cd5e0f1960e681a5432c16, en main: modificación de UN archivo, lib/data-floor/sales/dataset.js. Si NO se entrega una preparación explícita y los filtros son exactamente OWN_STORES + brand_id/model_id/store_id numéricos + date_from primer día del mes + date_to mismo mes, llama a semanticSalesCandidates() y pasa candidateVins a prepareSalesInput(). Las demás consultas conservan carga completa.
- IMPORTANTE: este commit NO conecta todavía la selección SQL al camino general getSalesRunFactSet() que reutiliza la preparación por run_id. NO afirmar que todo P1 ya está optimizado.
- No se ejecutó una validación posterior al commit 84771ae ni se autorizó despliegue de ese cambio. No afirmar que está en producción.

## Por qué esta ruta
El cuello de botella medido incluye carga/preparación de datos globales para preguntas locales. Ya existe un mecanismo de reutilización dentro del run, y el SQL de candidatos produjo los mismos 4 VIN para un caso concreto. Por eso el siguiente trabajo es conectar gradualmente selección temprana al camino certificado, sin crear otra capa de almacenamiento o invalidación.

## Dirección y siguiente paso
1. VALIDACIÓN mínima del commit 84771ae: ejecutar caso Foton G7 Pajaritos agosto 2026 por el camino dataset() modificado, comparar los 4 VIN certificados y medir tiempo; revisar errores. Sin GitHub Actions de tests.
2. Si pasa, IMPLEMENTACIÓN independiente: estudiar la interfaz de filtros y preparación compartida en getSalesRunFactSet()/createRunUniverses(), y habilitar SQL selectivo en el camino de consultas por run_id SIN que una preparación parcial se reutilice erróneamente para filtros distintos. Elegir un cambio acotado, sin crear caché entre runs. No asumir que el prototipo cubre otros universos, rangos, vendedores o consultas.
3. Validar el cambio concreto con una consulta cubierta y un control de reutilización dentro del mismo run. Si falla equivalencia, no desplegar.
4. DESPLIEGUE solo con autorización explícita del usuario, usando el flujo existente. GitHub Actions de despliegue no debe ejecutar pruebas.
5. Ampliar cobertura SQL selectivo incrementalmente, manteniendo fallback certificado para filtros no soportados.

## Alertas para el próximo LLM
- No confundir «SQL probado para 4 VIN» con «integración general lista».
- No confundir dataset() independiente con getSalesRunFactSet() por run_id.
- No declarar una mejora de latencia sin medir el camino real.
- No volver a proponer versiones mensuales, cachés persistentes o nuevas tablas.
- No desplegar por iniciativa propia.
- Informar en una línea qué cambió, commit, prueba y próximo bloqueo.
