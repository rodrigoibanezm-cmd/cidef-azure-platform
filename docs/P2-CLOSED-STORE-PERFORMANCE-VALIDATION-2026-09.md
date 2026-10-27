# Validación SALES / Tiendas / septiembre 2026

Validación ejecutada el 26 de octubre de 2026 (America/Santiago). Helper implementado, sin despliegue.

## Resultado

69 datasets P1 mensuales certificados de Azure, enero de 2021 a septiembre de 2026. Población: 14 sucursales presentes en el STORE P1 de septiembre; suma conciliada: 373 VIN. No se infieren sucursales activas sin ventas fuera de esa población.

1 IMPROVING, 9 STABLE, 0 DETERIORATING y 4 UNKNOWN. Los cuatro UNKNOWN conservan sus ventas P1; faltan antecedentes estadísticos para clasificarlos. STABLE significa ausencia de episodio confirmado con evidencia suficiente, no ventas constantes ni ausencia de señales adversas.

| ID | Sucursal | Ventas P1 septiembre | Estado P2 | Referencia MA12 | Percentil 0–1 | Motivo |
| --- | --- | ---: | --- | ---: | ---: | --- |
| 3 | CIDEF Bellavista | 52 | IMPROVING | 38.583333 | 0.928571 | ACTIVE_MIRROR_EPISODE |
| 4 | CIDEF Pajaritos | 33 | STABLE | 35.666667 | 0.482143 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 5 | CIDEF Antofagasta | 33 | STABLE | 33 | 0.361111 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 7 | CIDEF Mall Plaza Vespucio | 30 | STABLE | 43.75 | 0.078431 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 8 | CIDEF Mall Plaza Norte | 28 | STABLE | 36.083333 | 0.204545 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 9 | CIDEF Mall Plaza Sur | 30 | STABLE | 36.583333 | 0.229167 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 10 | CIDEF Mall Plaza Oeste | 37 | STABLE | 38.25 | 0.5 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 11 | CIDEF Mall Plaza Egaña | 19 | STABLE | 34 | 0.076923 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 15 | Amunategui | 1 | UNKNOWN | — | — | BASELINE_UNAVAILABLE |
| 18 | CIDEF Concepcion | 28 | STABLE | 30 | 0.105263 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 19 | CIDEF Mall Alameda | 24 | STABLE | 16.833333 | 0.714286 | SUFFICIENT_EVIDENCE_NO_CONFIRMED_EPISODE |
| 20 | CIDEF Vicuña Mackenna | 30 | UNKNOWN | 26.416667 | — | DEVIATION_UNAVAILABLE |
| 21 | CIDEF Mall Paseo Quilin | 5 | UNKNOWN | — | — | BASELINE_UNAVAILABLE |
| 22 | CIDEF Mall Cenco Costanera | 23 | UNKNOWN | — | — | BASELINE_UNAVAILABLE |

Los decimales de esta tabla se muestran con hasta seis posiciones; los JSON conservan los números completos devueltos por P2.

## Evidencia de mejora

Bellavista confirma el episodio en septiembre, con inicio en agosto. El percentil supera 0,5 en ambos meses y el error crece estrictamente. Se reutiliza el mismo clasificador histórico sobre la reflexión aprobada.

| Mes | Ventas P1 | Referencia MA12 | Error | Percentil | Errores históricos anteriores |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-08 | 40 | 38.333333 | 1.666667 | 0.672727 | 55 |
| 2026-09 | 52 | 38.583333 | 13.416667 | 0.928571 | 56 |

## Evidencia pendiente

| Sucursal | Brecha concreta para septiembre |
| --- | --- |
| Amunategui | Sin observación de ventas/actividad suficiente en los doce meses de referencia septiembre 2025–agosto 2026. No se rellenan con cero. |
| Vicuña Mackenna | 13 meses positivos desde septiembre 2025. Primera referencia MA12 en septiembre 2026; cero errores anteriores, frente a los tres exigidos para un percentil. |
| Paseo Quilin | Tres meses positivos observados, julio–septiembre 2026. Sin doce meses de referencia. |
| Cenco Costanera | Tres meses positivos observados, julio–septiembre 2026. Sin doce meses de referencia. |

La primera venta observada no demuestra fecha de apertura. No se utilizan meses posteriores a septiembre para completar la evidencia de ese cierre. Falta además un contrato P1 que exponga actividad independiente de notas de venta para acreditar ACTIVE_ZERO cuando corresponda; no se consulta RAW desde P2 ni se cambia P1.

## Paridad y pruebas

- Coincidencia completa del estado original sobre las mismas entradas P1 en 14/14 sucursales: 10 NOT_DETERIORATING y 4 UNKNOWN. El complemento asigna una mejora entre las diez primeras; no altera la decisión original de deterioro.
- Seis archivos puros idénticos byte por byte al núcleo histórico fijado en `cidef-data-loader@16f01f381238bc058c3e25e88dca7b550aa487f7`; hashes Git comprobados por pruebas.
- 47 pruebas automatizadas locales aprobadas con Node v24.22.1: 19 específicas, incluidos 50 historiales deterministas de paridad, y 28 regresiones pertinentes de P2. Los casos sintéticos comprueban los cuatro estados, persistencia, reversión, umbrales estrictos existentes, huecos, cero sin actividad acreditada e incompatibilidades.
- Comprobación de sintaxis de los módulos nuevos y validación real reproducible aprobadas. No hay compilador/bundle específico en este paquete; `package.json` declara `node --test`.
- No se ejecutaron GitHub Actions ni una nueva versión remota de P2. El código productivo de riesgo abierto y los demás ejecutores no se modificaron.

La paridad de adquisición del runtime legacy completo NO está verificada: ese runtime utiliza reconocimiento por snapshot y actividad independiente de notas de venta no expuesta en estas entradas. La equivalencia afirmada corresponde al núcleo estadístico con las mismas observaciones certificadas, no a una comparación contra una ejecución legacy conectada a su base.

## Trazabilidad

Run P1/P3 Azure: `closed-performance-sales-stores-20261026`.

Contrato nuevo: `p2.closed_period_store_performance@0.1.0`; executor `0.1.0`. Período `2026-09`, corte `2026-09-30`.

P1 de septiembre: `p1.sales.13dbe145a07500f1f8bab67b`, contrato `p1.dimensional_quantitative_dataset@0.1.0`, identidad STORE `sucursales_master@0.1`.

SHA-256 del archivo íntegro de entradas P1: `dccd58ea70af1208959188043e0ea9ad8096def756834109b882bd4fc0049c0d`.

- [Entradas P1 originales](validation/closed-store-performance-2026-09-p1.json): objetos certificados sin reescribir sus payloads, referencias por mes y parámetros temporales.
- [Resultados y lineage P2 por sucursal](validation/closed-store-performance-2026-09-p2.json): execution_id local, parámetros, política, filas estadísticas y observaciones P1. Las referencias comunes se normalizan en `p1_refs`; cada lineage incluye `evidence_refs_pointer` hacia esa colección.
- [Resumen del journal Azure existente](validation/closed-store-performance-2026-09-p1-journal.json): 142 eventos, 140 SUCCESS y dos fallos HISTORICAL_SERIES_NOT_CERTIFIED. Incluye las evidencias mensuales utilizadas. La solicitud de serie completa por tienda agotó el transporte; el journal confirmó posteriormente su finalización exitosa en backend (227.700 ms, evidencia `p1.sales.e383a7e9f0fe15dfc91fa717`). La validación utiliza los 69 datasets STORE compartidos, no un resultado estimado del timeout.
- [Contrato y reproducción](P2-CLOSED-STORE-PERFORMANCE.md).

Los execution_id P2 de esta entrega corresponden a ejecución local del código sobre evidencia original Azure. No son eventos del nuevo helper en el journal productivo de Azure. El helper se integrará con el mecanismo P3 existente cuando se autorice un despliegue.

El commit incluye `[skip ci]` para respetar la prohibición de despliegue. Sin modificaciones de frontend, motores existentes, tablas o infraestructura.
