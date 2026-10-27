# SALES DEALER_GROUP: bloqueo de continuidad histórica

Estado: BLOQUEADO. Revisión del 27 de octubre de 2026. Se documenta la excepción solicitada: falta evidencia suficiente para certificar vigencias históricas dealer→grupo. No se habilita ni publica DEALER_GROUP como dimensión certificada y no se ejecuta su clasificación P2.

Base: c0cff5d4315792b5b129220f1d274dd7afbfa956. SALES P1 continúa en 0.13. Sin cambios en motores, reglas, frontend, FORUM, RVM, tablas, infraestructura o staging; sin despliegue.

## Conciliación disponible

P1 Azure confirma 661 VIN del canal DEALERS en septiembre de 2026. Se recuperaron 18 observaciones P1 originales mediante el filtro existente dealer_group_id; su suma concilia exactamente con la observación P1 del canal y los 18 IDs del FETCH. No hay IDs de grupo nulos en ese FETCH.

Esto acredita los valores bajo el contrato actual, que usa los maestros disponibles al consultar. No acredita qué relación dealer→grupo estaba vigente históricamente, ni habilita retrospectivamente una nueva dimensión certificada.

| Grupo ID | VIN P1 | Clasificación P2 | Evidencia P1 original |
| --- | ---: | --- | --- |
| 1 | 16 | No ejecutada: continuidad no certificada | `p1.sales.a6ed695405d454c330ecc2f9` |
| 2 | 38 | No ejecutada: continuidad no certificada | `p1.sales.00de40a8fcfa8d2daa8ce5f5` |
| 4 | 45 | No ejecutada: continuidad no certificada | `p1.sales.9472dbc0ba27fc66d7367e5f` |
| 5 | 12 | No ejecutada: continuidad no certificada | `p1.sales.214b6916e9a13d88645d3da7` |
| 6 | 5 | No ejecutada: continuidad no certificada | `p1.sales.e7b0f5adb6207506f4d498fe` |
| 8 | 1 | No ejecutada: continuidad no certificada | `p1.sales.e8716b458a59fdf2e9929f3e` |
| 10 | 40 | No ejecutada: continuidad no certificada | `p1.sales.aa84f4eb8d9ec17b90a5c1c2` |
| 11 | 23 | No ejecutada: continuidad no certificada | `p1.sales.b96a63245590220b955b03f1` |
| 12 | 9 | No ejecutada: continuidad no certificada | `p1.sales.c2522053f95f22369cec838b` |
| 13 | 54 | No ejecutada: continuidad no certificada | `p1.sales.1d35833b62db43b58620ecff` |
| 15 | 14 | No ejecutada: continuidad no certificada | `p1.sales.282f682cefa5722439bcc979` |
| 16 | 6 | No ejecutada: continuidad no certificada | `p1.sales.c50cfed9193907757b640c3b` |
| 18 | 8 | No ejecutada: continuidad no certificada | `p1.sales.ed72931c6e2a9b8b3f9a38cb` |
| 19 | 274 | No ejecutada: continuidad no certificada | `p1.sales.4b95f041f6aeb6847ec03d6b` |
| 20 | 2 | No ejecutada: continuidad no certificada | `p1.sales.7ce13e13572336634a9695ec` |
| 21 | 33 | No ejecutada: continuidad no certificada | `p1.sales.2584d756c142505ba0066ddf` |
| 22 | 55 | No ejecutada: continuidad no certificada | `p1.sales.0f99a33cf237779813df970b` |
| 29 | 26 | No ejecutada: continuidad no certificada | `p1.sales.618c72c1aca84bedf60cb71a` |
| **Total** | **661** | **0 ejecuciones P2** | Canal: `p1.sales.9974c88c62da5d463181a616` |

No se infieren nombres comerciales desde seeds o listas históricas. Los IDs se conservan tal como los entrega P1. No se asignan IMPROVING/STABLE/DETERIORATING/UNKNOWN manualmente: aún no existe una entrada dimensional certificada para ejecutar el helper. Tampoco se puede distinguir hoy qué grupo carece de historia suficiente, tiene cero ventas activo o tiene un hueco de información; esos estados necesitan evidencia temporal.

La suma es una comprobación de conciliación entre observaciones P1 nativas, no un nuevo cálculo comercial ni un motor P2 paralelo. No se agregó por grupo el FETCH para producir métricas.

## Evidencia del bloqueo

1. SALES 0.13 publica dealer_group_id como campo y filtro, pero no como dimensión con contrato/versión de identidad y cobertura de membresía histórica.
2. `loadDealerBuyerMap` lee la relación actual `dealers_master.dealer_group_id` y el nombre actual en `dealer_groups`. No recibe fecha de venta/corte ni aplica condiciones valid_from/valid_to. `certifyRecognizedSaleCommercially` usa esa relación y, como fallback, la metadata actual de `vehiculo_canonico`. El corte del reconocimiento de VIN no constituye por sí solo un corte histórico de MASTER.
3. El esquema documentado de `dealer_groups`/`dealers_master` contiene identidad, la FK de grupo actual y created_at/updated_at. Esos timestamps técnicos no prueban vigencia comercial, apertura o actividad desde 2021. Los intervalos de `dealer_supervisor` describen la asignación de supervisores; no acreditan membresía dealer→grupo.
4. Los contratos MASTER_LAYER_V0.1 y MASTER_IMPLEMENTATION_V0.1 declaran expresamente que la dimensión tiempo no fue requisito físico de su cierre. La persistencia de IDs no demuestra vigencias o membresía histórica por período.

Fuentes fijadas, consultadas en solo lectura:

- [SALES: resolución comercial actual](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/blob/c0cff5d4315792b5b129220f1d274dd7afbfa956/lib/ventas-commercial/buildVentasCommercialContext.js).
- [SALES: contrato 0.13](https://github.com/rodrigoibanezm-cmd/cidef-azure-platform/blob/c0cff5d4315792b5b129220f1d274dd7afbfa956/lib/data-floor/sales/contract.js).
- [Esquema MASTER de referencia](https://github.com/rodrigoibanezm-cmd/cidef-data-loader/blob/16f01f381238bc058c3e25e88dca7b550aa487f7/sql/010_master_schema.sql).
- [Contrato lógico MASTER](https://github.com/rodrigoibanezm-cmd/cidef-data-loader/blob/16f01f381238bc058c3e25e88dca7b550aa487f7/docs/master/MASTER_LAYER_V0.1.md).
- [Contrato físico MASTER](https://github.com/rodrigoibanezm-cmd/cidef-data-loader/blob/16f01f381238bc058c3e25e88dca7b550aa487f7/docs/master/MASTER_IMPLEMENTATION_V0.1.md).

No se inspeccionó por SQL el esquema vivo de Azure: esta sesión no tiene AZURE_DATABASE_URL ni un conector SQL Azure disponible. Por tanto NO se afirma que sea imposible que existan otras columnas/tablas históricas en Azure. Sí está verificado que el contrato y la ruta P1 revisados no las publican ni las consumen, y que la evidencia disponible no permite certificarlas. No se utiliza Neon como sustituto para certificar Azure.

## Comprobación pendiente y alternativa mínima

Queda preparado el [audit SQL de metadatos, solo lectura](../scripts/sql/audit-dealer-group-continuity-readonly.sql). No se ejecutó. Permite localizar una autoridad temporal existente y sus constraints sin crear tablas, cargar datos ni alterar maestros. Encontrar columnas con nombres temporales no basta para certificar cobertura, no solapamiento o fechas de negocio.

Antes de habilitar la dimensión hace falta una fuente validada existente que demuestre: identidad canónica; pertenencia dealer→grupo por fecha; vigencias/actividad del grupo y cobertura de los períodos exigidos por la política P2. Un grupo sin ventas no se declarará activo/cero ni inactivo solo por ausencia de ventas.

Con esa prueba, la implementación mínima es reutilizar la agrupación canónica en P1 y exponer contrato/versión, períodos, cobertura y autoridad de continuidad. Después se conecta al mismo helper P2 sin tocar MA12, percentiles ni persistencia. No se propone ni crea infraestructura o tabla nueva.

Reclasificar toda la historia con el MASTER actual sería una semántica distinta de certificar vigencias históricas. No se asume que ambas equivalgan ni se introduce ese cambio para desbloquear el resultado.

## Regresiones y restricciones

62 pruebas automatizadas locales aprobadas. Además se ejecutó el validador existente sobre copias temporales de las entradas P1 archivadas; se verificaron los hashes completos de los resultados P2 y todos sus campos salvo execution_id/executed_at, que identifican la nueva ejecución local:

| Dimensión | Resultados idénticos | IMPROVING | STABLE | DETERIORATING | UNKNOWN |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tiendas | 14/14 | 1 | 9 | 0 | 4 |
| Vendedores, censo histórico | 218/218 | 4 | 12 | 0 | 202 |
| Modelos, censo histórico | 41/41 | 0 | 0 | 0 | 41 |

Son 273 resultados sin diferencias. Es una reproducción de las evidencias congeladas anteriores, no una actualización de las fuentes históricas. Los archivos anteriores y todos los motores/contratos permanecen sin cambios. Ningún test sintético se presenta como resultado de los 18 grupos.

No se ejecutaron cargas, migraciones, DDL, refresh canónico, workflows ni despliegues. El SQL de seed/refresh de MASTER se leyó únicamente como referencia; no se ejecutó.

## Trazabilidad

Run P1/P3: `enable-sales-dealer-group-20261027`. Período/corte de selección: 2026-09 / 2026-09-30. Hay 21 eventos exitosos en el journal (describe, FETCH, total y 18 observaciones por filtro). Las observaciones nativas usan p1.quantitative_observation@0.1.0. No se fabricó p1.dimensional_quantitative_dataset para DEALER_GROUP.

- [P1, conciliación y resultados individuales](validation/dealer-group-continuity-2026-09/p1-reconciliation.json).
- [CSV de los 18 grupos](validation/dealer-group-continuity-2026-09/individual-results.csv).
- [Journal P1](validation/dealer-group-continuity-2026-09/p1-journal.json).
- [Verificación de los 273 resultados y hashes de código](validation/dealer-group-continuity-2026-09/regressions.json).
- [Referencias y límites de la revisión](validation/dealer-group-continuity-2026-09/source-review.json).

La clasificación de grupos sigue bloqueada; no hay un nuevo contrato certificado P1 ni ejecuciones P2 para grupos en esta entrega. Commit documental y de auditoría de solo lectura, con [skip ci].
