# P2 · Dealers activos · septiembre 2026

## Alcance autorizado

Se evalúan únicamente los grupos con ventas P1 en septiembre. La identidad de
selección es `dealer_group_id` bajo la **agrupación comercial actual**, igual
que `scripts/publish-dealer-monthly-sellin.js`. No se reconstruye la membresía
jurídica/comercial vigente en cada mes pasado. La certificación temporal de esa
membresía documentada en b6f2757 no es un requisito de este encargo explícito.

SALES P1@0.13 y el publicador permanecen intactos. No se habilita una dimensión
P1 DEALER_GROUP ni se atribuye un contrato dimensional de identidad inexistente.
Los nombres no están publicados por estas evidencias: se entregan IDs originales,
sin inferir etiquetas desde seeds ni unir grupos por nombre.

## Contrato complementario dentro del helper existente

Unidad: `p2.closed_period_sales_performance@0.1.0`. Extensión compatible de entrada:
`dimension=DEALER_GROUP`, `member_id=<dealer_group_id>`, `cutoff_month=2026-09`.
SELLER, MODEL y STORE conservan sus rutas, entradas y resultados.

Cada slot `series_YYYY_MM_YYYY_MM` recibe el envelope original
`p1.period_observation_series@0.1.0`, SALES, VIN_SALES, DEALERS, filtrado por un
único dealer_group_id; certifier salesCertifier@0.13. Los rangos no se solapan,
sus observaciones/refs y su cobertura se concilian. P2 rechaza otros filtros,
autoridades, fuentes, versiones incompatibles, meses futuros, valores negativos,
refs componentes ausentes y coberturas inconsistentes.

La serie P1 nativa observa cada mes completo con su propio corte de fin de mes
(`salesCertifier.observePeriodObservationSeries`). No se sustituye por un FETCH
anual contado localmente ni por el temporal_fingerprint adicional. Este último
tiene `delivery.p2_input=false` y queda fuera de las entradas archivadas de P2.
Las correcciones posteriores pueden producir diferencias frente a un snapshot
anual publicado con otro corte de reconocimiento; no se ajustan para cuadrar.

## Historia y suficiencia

Primero se solicita septiembre 2025–septiembre 2026. Con 13 meses positivos hay
una sola desviación MA12: el percentil requiere tres errores anteriores y el
helper exige dos meses consecutivos evaluables para STABLE/IMPROVING.
El mínimo continuo sin ceros es, por tanto, **17 meses**: mayo 2025–septiembre
2026. Solo se agregan los cuatro meses de calentamiento cuando pueden aportar
evidencia; si hay huecos/ceros se informa el bloqueo concreto y se consulta
historia anterior cuando pueda subsanarlo. No se cambian MA12, percentiles,
precedencia, persistencia ni confirmación de episodios.

Las estadísticas usan todos los errores disponibles de la ventana explícita:
la clasificación es condicional a esa historia, no una afirmación de paridad
con una corrida de historia completa desde 2021. `policy` conserva literalmente
la política común aprobada, cuyo metadata histórico se originó en Tiendas;
`coverage.history_scope/history_start/history_end` declaran la adquisición
acotada específica de Dealers. No se cambia la historia de SELLER/MODEL/STORE.

El adaptador llama directamente a `classifyClosedPerformance`, sin copiar
fórmulas. Se compara su resultado con el mismo núcleo original sobre idénticas
observaciones. IMPROVING usa la regla espejo aprobada; DETERIORATING conserva
el deterioro original y su precedencia.

| Evidencia | Valor | Tratamiento |
| --- | --- | --- |
| P1 informa ventas positivas | valor original | OBSERVED_POSITIVE |
| P1 informa cero | 0 | ZERO_SALES_ACTIVITY_UNVERIFIED; el núcleo disperso no inventa actividad |
| Falta observación/serie | null | NO_P1_OBSERVATION; UNKNOWN/P1_HISTORY_COVERAGE_INCOMPLETE |

El cero certificado no es una falla de extracción. Tampoco acredita actividad
operativa independiente: se mantiene exactamente la regla dispersa existente.

## Ejecución reproducible y límites

Las consultas P1 y su journal corresponden a Azure. La nueva entrada P2 se
ejecuta **localmente** mediante `executeP2`, con UUID, parámetros, refs y hashes;
no se declara ejecución P2 remota ni publicación en P3 productivo. No hay
despliegue, frontend, staging, cargas, tablas ni infraestructura.

```bash
node --test test/p2-dealer-series-performance.test.js test/p2-closed-period-sales-performance.test.js test/p2-closed-period-store-performance.test.js test/p2-open-period-deterioration-risk.test.js test/p2-vertical-slice.test.js test/p2-target-attainment-seller-contribution.test.js
node scripts/validate-closed-dealer-performance.js docs/validation/closed-dealer-performance-2026-09
```

El validador solo reproduce las entradas archivadas; no consulta ni escribe la
base de datos. Escribe resultados locales en el directorio indicado. Los tests
con datos sintéticos comprueban reglas y rechazos; no son evidencia comercial.
Resultados reales y cobertura: `P2-CLOSED-DEALER-PERFORMANCE-VALIDATION-2026-09.md`.
