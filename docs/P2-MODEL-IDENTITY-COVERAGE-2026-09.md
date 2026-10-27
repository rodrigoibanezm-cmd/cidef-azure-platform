# SALES P2 · cobertura de identidad de Modelos · septiembre 2026

**Bloqueo global corregido: 9 de los 20 modelos actuales se clasifican.** Se concilian **1.033 VIN** contra SALES P1 actual. Se conservan los 69 meses de enero 2021 a septiembre 2026, el núcleo estadístico y todos sus errores históricos. No se asigna identidad al VIN ni se modifica P1.

## Resultado

| Estado | Modelos |
| --- | ---: |
| IMPROVING | 4 |
| STABLE | 5 |
| DETERIORATING | 0 |
| UNKNOWN | 11 |

| ID | Modelo canónico P1 | VIN septiembre | Estado | Motivo |
| ---: | --- | ---: | --- | --- |
| 4 | T5 EVO | 3 | STABLE | Sin episodio confirmado con evidencia suficiente |
| 17 | TM5 | 177 | IMPROVING | Mejora espejo confirmada |
| 23 | HUGE | 6 | UNKNOWN | Referencia MA12 actual incompleta |
| 28 | G7 | 185 | UNKNOWN | Residual histórico con dependencia estadística potencial |
| 84 | AEOLUS Y3 | 34 | STABLE | Sin episodio confirmado con evidencia suficiente |
| 176 | MIDI | 113 | UNKNOWN | Residual histórico con dependencia estadística potencial |
| 181 | DF6 | 1 | UNKNOWN | Residual histórico con dependencia estadística potencial |
| 217 | SX6 | 58 | UNKNOWN | Residual histórico con dependencia estadística potencial |
| 228 | V7 | 30 | STABLE | Sin episodio confirmado con evidencia suficiente |
| 396 | AEOLUS GS | 23 | STABLE | Sin episodio confirmado con evidencia suficiente |
| 399 | T5 L | 12 | IMPROVING | Mejora espejo confirmada |
| 409 | WONDER | 2 | UNKNOWN | Referencia MA12 actual incompleta |
| 426 | V9 | 63 | IMPROVING | Mejora espejo confirmada |
| 435 | G9 | 45 | IMPROVING | Mejora espejo confirmada |
| 457 | RICH 6 | 3 | UNKNOWN | Referencia MA12 actual incompleta |
| 481 | MAGE | 54 | STABLE | Sin episodio confirmado con evidencia suficiente |
| 501 | T5 | 7 | UNKNOWN | Referencia MA12 actual incompleta |
| 612 | VIEW GRAND | 44 | UNKNOWN | Referencia MA12 actual incompleta |
| 765 | TM3 | 171 | UNKNOWN | Residual histórico con dependencia estadística potencial |
| 811 | T5 HEV | 2 | UNKNOWN | Referencia MA12 actual incompleta |

## Identidad SALES P1 y VIN investigado

P1 obtiene la identidad desde el SKU reconocido de ventas_raw, normalizado y cruzado con producto_aliases_v01: fuente ventas_raw, nivel MODELO/VERSION, estado RESUELTO y modelo canónico informado. buildProductModelResolutionMap acepta un único modelo del alias certificado; resolveSaleModel conserva model_id null para claves sin resolución o ambiguas. Los candidatos informativos no se convierten en identidad. buildVentasUniverse publica ese modelo; salesCertifier agrupa por MODEL/modelos_master_v01@0.1 y conserva el residual UNRESOLVED.

Consulta P1 actual de junio 2021: VIN **LVAV2MAB8MC001013**, factura **10013**, operación **2802**, model_id **null**, brand_id 89. Sigue existiendo una sola venta dimensional UNRESOLVED en ese mes. El FETCH público no expone el SKU ni el detalle del alias fallido: no se inventa una causa física más específica ni un modelo sustituto. No se consultó RVM ni se modificaron RAW/maestros.

Fuentes de código verificadas en el commit base 36cb581:

- lib/ventas-universe/buildVentasUniverse.js: enrichVentasUniverseEvents.
- lib/ventas-product/loadProductIdentityMap.js: filtro de aliases certificados.
- lib/product-model-resolution/buildResolutionMap.js y resolveSalesModels.js: resolución única o identidad no resuelta.
- lib/data-floor/sales/dataset.js y salesCertifier.js: proyección del modelo y dataset dimensional con residual explícito.
- Hashes Git originales en [p1-source-review.json](validation/model-identity-coverage-2026-09/p1-source-review.json).

## Corrección mínima del adaptador

La validación anterior imponía UNKNOWN a todos los modelos ante cualquier residual de los 69 meses. Ahora se comprueban las dependencias de cada modelo antes de decidir si ese residual impide ejecutar el mismo clasificador.

Una fila estadística necesita observación positiva del mes y los 12 meses anteriores. El análisis usa los meses positivos certificados y los meses con residual como cota de presencia posible; no les asigna cantidades ni identidades. Examina todas las ventanas posibles de 13 meses. Un residual sigue bloqueando si puede afectar el valor o la referencia de cualquier fila histórica, porque todos esos errores pueden entrar en percentiles posteriores y en episodios. También se consideran filas que el residual podría hacer calculables: no se valida solo sobre las filas conocidas.

No se reduce el período a los últimos 12 o 17 meses. Se mantienen todas las observaciones, todos los errores, la persistencia, MA12, mínimo de tres errores previos y las reglas aprobadas. La nueva lógica es exclusivamente una validación estructural de cobertura, no otro motor estadístico. Si falta un dataset mensual, no se exonera su cobertura y se mantiene UNKNOWN. SELLER conserva su validación original; STORE y DEALER_GROUP no cambian.

El residual de junio 2021 es ajeno a todas las filas estadísticas posibles de **15 modelos**. Esos casos conservan período, cantidad, evidence_id y motivo en coverage.identity_validation.excluded_unresolved_periods. La exclusión afecta únicamente al bloqueo de validación: el registro original y el dataset P1 íntegro siguen archivados. No se elimina ni reparte el VIN y no se cambia su model_id.

Para **G7, MIDI, DF6, SX6 y TM3**, junio 2021 puede afectar referencias/errores históricos que utiliza el motor. Conservan UNKNOWN/P1_IDENTITY_COVERAGE_INCOMPLETE. DF6 y SX6 además tienen referencias actuales incompletas. No se publican percentiles calculados sobre esa incertidumbre como si fueran certificados.

Entre los otros 15, nueve cumplen la suficiencia estadística y seis siguen UNKNOWN/BASELINE_UNAVAILABLE: HUGE, WONDER, RICH 6, T5, VIEW GRAND y T5 HEV. No se rellenan ausencias con ceros ni se infiere actividad comercial.

## Historia insuficiente: meses sin observación utilizable en la referencia actual

Los datasets P1 del período sí existen. Estos son huecos del miembro dentro de septiembre 2025–agosto 2026, no fallas de extracción:

| Modelo | Meses sin observación positiva utilizable |
| --- | --- |
| HUGE | 2025-09 |
| DF6 | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06, 2026-08 |
| SX6 | 2025-12 |
| WONDER | 2026-03, 2026-07 |
| RICH 6 | 2026-01, 2026-04, 2026-06 |
| T5 | 2025-12 |
| VIEW GRAND | 2025-09, 2025-10, 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05 |
| T5 HEV | 2025-11 |

## Conciliación y cambio de fuente

La suma de los 20 miembros coincide con el total COMPANY P1: **1.033 VIN**, sin identidad de modelo pendiente en septiembre. El informe original archivado tenía 1.034: la única diferencia en los payloads de los 69 meses es TM3 (modelo 765), septiembre **172 → 171**. El resto de los valores de modelo coincide. Se conserva la fotografía anterior sin sobrescribirla y se informa la lectura actual; este cambio de fuente no se provoca ni se corrige desde P2.

## Pruebas y trazabilidad

- **75 pruebas locales aprobadas**, Node v24.22.1; sin GitHub Actions. Incluyen los cuatro estados del núcleo, conservación íntegra de historia, identidad dentro/fuera de dependencias, filas potenciales, residuales múltiples y pruebas sintéticas de invariancia de errores al excluir residuales irrelevantes.
- **250 resultados anteriores idénticos** con sus mismas entradas archivadas: 14 Tiendas, 218 Vendedores y 18 Dealers. Es una regresión del código, no una nueva consulta comercial para esas dimensiones.
- Núcleo classifyClosedPerformance, seis fuentes estadísticas legacy y reglas productivas intactos. La sintaxis de los módulos nuevos se validó con Node; el paquete no define build.
- Run P1/P3 Azure: **resolve-sales-model-performance-20261027**. 73 eventos exitosos y una conexión fallida de septiembre 2025, recuperada. Los 69 datasets originales y el total P1 utilizado se cotejaron íntegramente contra las respuestas exitosas del journal. No quedan meses P1 faltantes.
- P2 **local**, p2.closed_period_sales_performance@0.1.0. Se guardan UUID, parámetros, contratos, período/corte, referencias originales y SHA-256 de código/entradas/resultados. No se afirma ejecución P2 remota ni evento P2 productivo. Los temporal_fingerprint adicionales no son entradas P2; se omiten también del archivo del journal para no duplicar ese contexto LLM. Las demás entradas/salidas y los fingerprint_id de P3 se conservan; el run remoto completo permanece intacto.
- Para evitar duplicar referencias, p2-results.json comparte p1_refs/p2_evidence_refs; cada resultado conserva sus observaciones y punteros. El validador reconstruye cada resultado completo y verifica su hash canónico con claves ordenadas.

Archivos: [CSV individual](validation/model-identity-coverage-2026-09/individual-results.csv), [resultados P2](validation/model-identity-coverage-2026-09/p2-results.json), [entradas P1](validation/model-identity-coverage-2026-09/p1-inputs.json), [journal P1/P3](validation/model-identity-coverage-2026-09/p1-journal.json), [VIN diagnosticado](validation/model-identity-coverage-2026-09/model-identity-gap.json) y [checks](validation/model-identity-coverage-2026-09/checks.json).

Reproducción local, sin consultas ni escrituras a bases de datos:

```bash
node --test test/p2-model-identity-coverage.test.js test/p2-dealer-series-performance.test.js test/p2-closed-period-sales-performance.test.js test/p2-closed-period-store-performance.test.js test/p2-open-period-deterioration-risk.test.js test/p2-vertical-slice.test.js test/p2-target-attainment-seller-contribution.test.js
node scripts/validate-model-identity-coverage.js docs/validation/model-identity-coverage-2026-09
```

El validador escribe informes locales en el directorio indicado. Sin cambios en SALES P1, RAW, maestros, frontend, FORUM, RVM, tablas o infraestructura. Sin despliegue.
