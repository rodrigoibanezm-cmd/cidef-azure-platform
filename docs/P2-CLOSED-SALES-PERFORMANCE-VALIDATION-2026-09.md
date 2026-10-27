# Validación de desempeño SALES — septiembre 2026

Validación local del 27 de octubre de 2026 sobre P1 Azure. Sin despliegue ni ejecución remota del nuevo helper.

## Resumen y población

| Dimensión | Miembros evaluados | IMPROVING | STABLE | DETERIORATING | UNKNOWN | Alcance |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Tiendas | 14 | 1 | 9 | 0 | 4 | Población original c3ee707 |
| Vendedores | 218 | 4 | 12 | 0 | 202 | Unión de IDs observados 2021-01–2026-09 |
| Modelos | 41 | 0 | 0 | 0 | 41 | Unión de IDs observados 2021-01–2026-09 |
| Dealers / grupos | 0 | — | — | — | — | Bloqueado; 18 IDs de grupo presentes en FETCH de septiembre |

La unión histórica no es una nómina de activos: incluye 149 vendedores y 21 modelos sin observación en septiembre. No se convierten esas ausencias en cero. El helper conserva UNKNOWN. Tiendas mantiene exactamente su población original de 14 sucursales.

Para los miembros con observación en septiembre:

| Dimensión | Miembros | IMPROVING | STABLE | DETERIORATING | UNKNOWN | Ventas P1 conciliadas |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vendedores / OWN_STORES | 69 | 4 | 12 | 0 | 53 | 373 |
| Modelos / COMPANY | 20 | 0 | 0 | 0 | 20 | 1034 |

## Resultados individuales

El [CSV completo](validation/closed-sales-performance-2026-09/individual-results.csv) contiene los 14 resultados de Tiendas, 218 de vendedores, 41 de modelos y 18 IDs de grupos bloqueados. Cada clasificación incluye ID/etiqueta, ventas de septiembre, estado/motivo, referencia/error/percentil disponibles, cobertura y execution_id local. Los grupos bloqueados no reciben un estado P2 inventado.

Los [resultados JSON](validation/closed-sales-performance-2026-09/p2-results.json) añaden los cuatro meses recientes, estado original, episodio de mejora, política, parámetros, cobertura por período, hash de la salida completa y lineage con referencias P1 comunes.

Vendedores con episodio de mejora activo en septiembre:

| ID | Vendedor canónico | Ventas septiembre | Referencia MA12 | Error | Percentil | Inicio / confirmación del episodio |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 57 | BASANTA GUEVARA DOUGLAS JOSE | 14 | 9.166667 | 4.833333 | 0.833333 | 2026-07 / 2026-08 |
| 62 | JEREZ CORTEZ DIEGO ANDRES | 8 | 7.833333 | 0.166667 | 0.521739 | 2026-07 / 2026-08 |
| 180 | HERRERA FERNANDEZ NICOLAS ALEXIS | 4 | 3.75 | 0.25 | 0.6 | 2026-06 / 2026-07 |
| 232 | TAMPOA GUANIPA VIRGINIA CENOBIA | 30 | 18.25 | 11.75 | 0.946429 | 2026-08 / 2026-09 |

Las cifras decimales de esta tabla son de presentación; el JSON conserva la precisión numérica. STABLE significa evidencia suficiente sin episodio confirmado, no ventas constantes ni ausencia de una señal adversa de un solo mes.

## Cobertura y UNKNOWN

Vendedores: 69 datasets mensuales originales, sin meses P1 faltantes ni identidades UNRESOLVED. De los 202 UNKNOWN históricos, 149 no tienen observación actual. Entre los 69 observados en septiembre, los 53 UNKNOWN se descomponen así:

| Motivo | Cantidad en septiembre | Evidencia faltante |
| --- | ---: | --- |
| BASELINE_UNAVAILABLE | 45 | Doce meses anteriores completos de observación utilizable. |
| DEVIATION_UNAVAILABLE | 7 | Al menos tres errores anteriores para el percentil. |
| TWO_CONSECUTIVE_EVALUABLE_MONTHS_REQUIRED | 1 | Un segundo mes evaluable consecutivo para declarar estabilidad/mejora. |

Los períodos y valores de cada miembro se conservan en las entradas P1 y la cobertura individual. No se rellenan meses ausentes, no se unen IDs por nombre ni se infiere antigüedad laboral o actividad.

Modelos: los 69 datasets mensuales están disponibles. Junio de 2021 contiene una venta UNRESOLVED (evidencia `p1.sales.d206310734aff7679a6a06e9`). La regla de suficiencia exige historia con identidad resuelta y no permite repartir ese residual ni cambiar el inicio histórico. Por ello 41 IDs históricos, incluidos los 20 observados en septiembre, devuelven UNKNOWN/P1_IDENTITY_COVERAGE_INCOMPLETE. No se ejecuta el núcleo estadístico para producir estados de modelo con esa cobertura incompleta.

Pendiente concreto: VIN `LVAV2MAB8MC001013`, factura `10013`, operación `2802`, junio de 2021, sin model_id en P1. El [diagnóstico de identidad](validation/closed-sales-performance-2026-09/model-identity-gap.json) es una proyección de FETCH para localizar el caso y no se utiliza como entrada P2. No se asignó modelo, corrigió RAW/maestros ni ejecutó carga.

Ceros: estas observaciones dimensionales no entregaron miembros explícitos con cero; las ausencias se conservan como null/NOT_OBSERVED. Las pruebas separan un cero explícito de la ausencia, pero no acreditan actividad comercial independiente con ninguno de los dos. ACTIVE_ZERO sigue pendiente de evidencia P1 de actividad; no se cambia la política de c3ee707.

## Dealers: bloqueo de contrato

P1 SALES@0.13 publica dealer_group_id como campo/filtro, pero no una dimensión con contrato/versión de identidad de grupos ni membresía histórica. El FETCH de septiembre devuelve 661 ventas reconocidas y estos 18 IDs de grupo:

`1, 2, 4, 5, 6, 8, 10, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 29`.

Los campos y filtros sí existen: el bloqueo no es falta de ventas. Falta el contrato P1 para certificar identidad y continuidad del conjunto de grupos. Las series escalares filtradas no se recodifican como datasets dimensionales. No se convirtió FETCH en un envelope P1 ni se agregaron ventas por grupo fuera de P2. Los 18 casos constan individualmente como BLOCKED_P1_IDENTITY_CONTRACT, sin clasificaciones ni recuentos de estado ficticios.

Alternativa mínima: exponer en P1 la agrupación canónica ya existente con su identidad/versión, cobertura y semántica de membresía histórica. No hacen falta tablas nuevas. Requiere un encargo P1 separado; no se implementa en este commit.

La [evidencia de capacidades](validation/closed-sales-performance-2026-09/dealer-group-capability.json) conserva el FETCH original y las dimensiones publicadas por el contrato. P3: data_fetch, secuencia 4973. El diagnóstico de junio usa data_fetch, secuencia 5117.

## Paridad de Tiendas y pruebas

- Replay de las evidencias originales archivadas en c3ee707: coincidencia completa de los 14 resultados, valores, cobertura, observaciones por mes y estados originales; 1 IMPROVING, 9 STABLE, 0 DETERIORATING, 4 UNKNOWN.
- No se actualizaron ni sobrescribieron los archivos históricos de Tiendas. Este replay no es una nueva fotografía de las fuentes actuales.
- El núcleo, la política, los seis archivos estadísticos históricos y todos los ejecutores existentes permanecen byte por byte sin cambios; la nueva unidad importa el mismo clasificador.
- 62 pruebas automatizadas locales aprobadas con Node v24.22.1: 15 nuevas y 47 regresiones existentes. Cubren los cuatro estados en ambas dimensiones, continuidad/persistencia, ceros/ausencia, identidad desconocida, cambios de etiqueta sin fusiones, versiones incompatibles, historia incompleta, evidencia no certificada, rechazo de dealers sin contrato y paridad exacta de Tiendas.
- Validación real y comprobaciones de sintaxis aprobadas. No hay bundle/compilador de aplicación en este paquete; las pruebas cargan y ejecutan los módulos.
- Ningún GitHub Action ejecutado ni despliegue solicitado. Commit con [skip ci].

## Fuentes y trazabilidad

Run P1/P3 Azure nuevo: `extend-closed-sales-performance-20261027`. Journal: 141 eventos exitosos, sin errores. Hay 138 observaciones mensuales (69 SELLER y 69 MODEL), un describe y dos FETCH diagnósticos. Los temporal_fingerprint dirigidos al LLM no se utilizaron como entradas P2.

Run original de Tiendas: `closed-performance-sales-stores-20261026`.

- [P1 SELLER original](validation/closed-sales-performance-2026-09/p1-seller.json): OWN_STORES, personas_master@0.1. SHA-256 `210e6afe5d651c05d380487d03dcd032a67e91cf9e10ce5a7a0109645101a0d7`.
- [P1 MODEL original](validation/closed-sales-performance-2026-09/p1-model.json): COMPANY, modelos_master_v01@0.1. SHA-256 `d5b197e6c40dee2e5841f727d2c2c170644d70e4852b4e9718973b9f028e7a7a`.
- [Journal P1](validation/closed-sales-performance-2026-09/p1-journal.json): secuencias, entradas, evidence_id y fingerprint_id originales para auditoría; los fingerprints no alimentan el helper.
- [Resultados P2](validation/closed-sales-performance-2026-09/p2-results.json): execution_id local, versión 0.1.0, parámetros, hashes de código y salida, referencias originales y motivos de insuficiencia.
- [Contrato y reproducción](P2-CLOSED-SALES-PERFORMANCE.md).

La unidad p2.closed_period_sales_performance está implementada y registrada en código; sus resultados se ejecutaron localmente sobre evidencia P1 original de Azure. No se presentan como ejecuciones remotas del helper ni como eventos P2 del journal productivo. No se modifica P3.

Sin cambios en P1, el clasificador existente, frontend, FORUM, RVM, tablas, infraestructura, staging o producción.
