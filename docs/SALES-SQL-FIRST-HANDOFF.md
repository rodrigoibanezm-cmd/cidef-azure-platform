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

## Avance 2026-11-18 — objetivo SQL-first por run
- Selectividad agregada a `loadCommercialIdentityMap` y colores (VIN candidatos); sin filtros se mantiene ruta global.
- `createRunUniverses` separa preparaciones por `run_id` + scope de candidatos, evitando contaminar observaciones con filtros diferentes en un mismo run. Sin almacenamiento persistente ni reutilización entre runs.
- `getSalesRunFactSet()` puede preparar candidatos SQL-first para OWN_STORES + marca/modelo/sucursal numéricos + un mes; `observeSalesMany()` solo lo solicita cuando existe una única operación OBSERVE exacta. Resto conserva camino completo.
- **Interruptor de seguridad:** `SALES_SQL_FIRST_ENABLED=true` es necesario para activar este nuevo camino. Por defecto permanece apagado. No habilitar en producción sin autorización y validación certificada.
- Commits principales: `f244a343`, `bb1a6dfa` (identidad); `49be1520`, `b2ac7ad` (colores); `3fb8f6f`, `dd2a6ee`, `ba711846` (integración por run); `8023958` (flag apagado por defecto).
- Verificación estática: sintaxis JS de los cinco archivos alterados OK. Prueba aislada de `createRunUniverses`: mismo run/scope reutiliza; scopes diferentes, global y otro run quedan separados.
- Comparación real mediante MCP **desplegado anteriormente**, no código nuevo: 4 VIN contra 4 de P1, sin faltantes ni sobrantes; 5.731 ms selectivo vs 12.084 ms completo (medición aislada, no garantía de mejora general). `source_coverage_equal=false` sigue vigente. El probe no demuestra que el nuevo `getSalesRunFactSet` esté certificado ni mide la ruta aún no desplegada.
- **Bloqueo de certificación:** la cobertura/huellas del universo parcial difieren del universo completo. No presentar resultados de la ruta nueva como certificados hasta definir y validar la equivalencia de calidad/evidencia con P1; las firmas de contenido no deben mezclarse entre scopes.
- Próximo paso separado: ejecutar una validación de integración real en entorno no productivo, activando el flag solo allí, comparando VIN, campos, calidad, huellas y operación same-run con filtros distintos. Si no existe entorno seguro disponible, no habilitar el flag ni desplegar.

## 2026-11-18 — MCP validation tool ready for authorized deploy
- Implemented `sales_sql_first_validate` in `motor-test-azure/sales-sql-first-validate.js`, registered by existing `motor-test-azure/server.js` (no new service).
- Input: `OWN_STORES`, positive brand/model/store ids, monthly date_from/date_to. Read-only diagnostics compare full vs selectively prepared P1 via `getSalesRunFactSet`, VINs, selected commercial fields, coverage/validation, fingerprints and latency. Also tests reuse of same scope and isolation of other store in one run.
- `lib/data-floor/sales/preparation.js` has explicit `diagnostic_sql_first` opt-in, used only by the tool. The existing `SALES_SQL_FIRST_ENABLED` default stays OFF; diagnostic tool does not set environment variables or enable normal requests. Fixed date-guard regex in this module.
- Diagnostic status is FAIL unless records, VINs, coverage, validation, and scope-isolation checks all match. Source-fact fingerprints are reported (not expected to be equal for a subset), and partial coverage remains an open blocker.
- Code validation: syntax checks PASS for server, helper and preparation; registration, read-only annotation, opt-in and run-isolation guards checked. Live A/B requires authorized deploy of the existing MCP revision. Do not claim live validation yet.
- Commits: `11168250` (date guard), `8bc95efe` (tool initial), `b21ac81f` (helper), `177691cb` (isolated registration). No production deploy executed.

## Contrato diferencial de evidencia parcial (2026-11-18)
- Objetivo: SQL-first no puede declarar `P1_CERTIFIED` global si solo leyó los VIN candidatos.
- `getSalesRunFactSet` propaga los filtros exactos al fact set únicamente al usar SQL-first. `factSet.ref.source_scope='PARTIAL_SOURCE'` y `source_filters` describen esa cobertura. `select()` rechaza filtros diferentes o más amplios con `SALES_PARTIAL_SOURCE_FILTER_MISMATCH`.
- `observeSalesSelection()` devuelve `authority='P1_PARTIAL_SOURCE'`, `status='PARTIAL_SOURCE'`, `evidence_contract='p1.sql_first_partial_observation'` para resultados escalares selectivos (sufijo diferencial para dimensiones). Nunca reutiliza los IDs de evidencia de P1 completo. Los resultados de fuente completa mantienen el contrato original.
- `sales_sql_first_validate` exige igualdad de VIN, campos y valor, separación explícita de contratos, rechazo fuera de alcance y aislamiento dentro del run. **No exige igualdad de la cobertura global**; sigue mostrando la divergencia como dato de diagnóstico. Su PASS significa que cumple esos controles, no equivale a certificación global P1.
- Comprobación realizada: sintaxis y guardas del código en GitHub; aún no hay prueba A/B en ejecución real de esta revisión. SQL-first normal sigue desactivado por defecto. No desplegar sin autorización.
- Commits: `71004d61` / `435c0f7b` para scope en preparación/fact set; `85b68e11` / `b3eb752c` para contrato diferencial y validación MCP.

## Auditoría de ampliación SALES — 2026-11-19
- MCP desplegado: `sales_sql_first_validate` comparó P1 completo vs SQL-first para OWN_STORES, Foton G7 (brand_id=89, model_id=28). Antofagasta (store_id=5), agosto 2026: PASS 11/11, 7 VIN iguales, 26.305 ms vs 1.660 ms. Pajaritos (store_id=4), julio 2026: PASS 11/11, 2 VIN iguales, 24.926 ms vs 1.482 ms. Sin faltantes ni sobrantes; scope y aislamiento correctos.
- Controles P1 completo fuera de cobertura SQL-first: DEALERS, Foton G7, agosto 2026: 199 VIN, ~26,37 s, status CERTIFIED. OWN_STORES, Foton G7 agrupado por STORE, agosto 2026: ~32,15 s, status CERTIFIED; tienda Pajaritos 4 y Antofagasta 7, coherentes con casos selectivos anteriores. Estos controles NO certifican SQL-first para DEALERS o agrupaciones.
- Restricción real en `lib/data-floor/sales/preparation.js`: candidato selectivo solo `OWN_STORES`, `AUTO`, ids positivos escalares `store_id`/`model_id`/`brand_id`, primer día de mes a fecha final del mismo mes. `scripts/semantic-sales-prototype.mjs` obliga `store_id`, y `lib/data-floor/sales/multiObserve.js` habilita el candidato solo cuando hay una única operación OBSERVE. No existe soporte selectivo DEALERS ni agrupado; ambos preservan P1 completo.
- Próxima implementación a separar: ampliar generación de VIN candidatos/contrato y probar cobertura comparada para un segundo tipo de consulta, SIN tratar una fuente parcial como universo global ni habilitar en producción hasta validar. No modificar P1 certificado ni reutilizar entre runs.

## Ampliación SQL-first DEALERS y agrupaciones (2026-11-19) — código en main, pendiente de despliegue
- Se amplió `scripts/semantic-sales-prototype.mjs` para seleccionar candidatos por marca/modelo/mes bajo `DEALERS` (categoría raw Concesionaria) y `OWN_STORES` (Cliente General), con sucursal opcional solo en OWN_STORES. No se implementó filtro `dealer_id` individual: requiere resolver correctamente la identidad comercial antes de agregarlo.
- `lib/data-floor/sales/preparation.js` permite la ruta selectiva en ambos universos y con ausencia de sucursal; conserva filtro temporal exacto y flag `SALES_SQL_FIRST_ENABLED` APAGADO por defecto. `observeSalesMany` ya permitía `OBSERVE + group_by`; con marca/modelo/mes sin store puede usar candidatos de todas las tiendas. Las agrupaciones y otros formatos no cubiertos mantienen la ruta P1 completa.
- `motor-test-azure/sales-sql-first-validate.js` ahora admite `commercial_universe=DEALERS|OWN_STORES`, `store_id` opcional y `group_by=STORE|DEALER_GROUP`. Compara VIN, campos, valor/miembros de grupos, scope, evidencia parcial separada, rechazo fuera de alcance y aislamiento del run.
- Corrección técnica posterior: parámetros SQL contiguos cuando `store_id` está ausente (4 parámetros; con sucursal, 5).
- Revisiones locales sin acceso a DB nueva: sintaxis de los tres archivos OK, condiciones de activación/aislamiento y posiciones de parámetros revisadas. **NO se ha probado equivalencia real de DEALERS ni agrupaciones** contra P1 tras estos commits. NO declarar PASS ni activar flag hasta desplegar versión nueva y ejecutar validación MCP.
- Casos mínimos pendientes tras autorización de despliegue: (a) DEALERS, brand_id=89, model_id=28, agosto 2026, con y sin group_by=DEALER_GROUP; (b) OWN_STORES brand_id=89, model_id=28, agosto 2026 sin store, con group_by=STORE; (c) regresión OWN_STORES Pajaritos store_id=4, agosto. Si hay discrepancias, detener activación y diagnosticar cobertura por VIN.
- Cambios funcionales separados: DEALERS `ee03580e`, `05199e80`; agrupaciones `0cb5633e`, `8fd1c8ea`; herramienta validadora `72490b51`; fix placeholders `c5d692c5`. Sin despliegue.

## 2026-11-19 — alcance dealer individual (pendiente de deploy y A/B)
- Diagnóstico: `dealer_id` certificado se resuelve en `lib/ventas-commercial/buildVentasCommercialContext.js` primero por RUT de comprador `ventas_raw.cliente` + `dealers_master.rut_normalizado`, con fallback `vehiculo_canonico.dealer_id`. No se debe filtrar exclusivamente por vehículo canónico.
- Cambio funcional acotado: `scripts/semantic-sales-prototype.mjs` admite `dealer_id` positivo en universo DEALERS y aplica la unión de ambos caminos como predicado SQL sobre candidatos VIN; `lib/data-floor/sales/preparation.js` acepta `dealer_id` en ruta selectiva conservando `PARTIAL_SOURCE`, scope exacto y fallback P1 completo si no corresponde. Commits `2c48a559`, `672dc800`.
- Validador independiente: `motor-test-azure/sales-sql-first-validate.js` ahora acepta `dealer_id`, compara todas las filas y usa otro dealer como control de aislamiento. Commit `3f37147e`.
- Comprobación mínima hasta ahora: sintaxis JS de los tres archivos PASS. No se ha desplegado ni ejecutado el A/B de dealer individual. SQL-first normal sigue apagado por defecto.
- Próxima validación: tras despliegue autorizado, usar dealer_id real con ventas conocidas, misma marca/modelo/mes, comprobar 11/11, VIN, fecha, identificadores, cantidad, latencia y estados de evidencia. Si no hay equivalencia, no habilitar el alcance. El filtro seller_id requiere diagnóstico independiente: la identidad P1 pasa por resolución histórica de vendedores y no equivale a filtrar un campo RAW directamente.
