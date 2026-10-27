# Validación P2 · Dealers · septiembre 2026

18 grupos activos en septiembre, **661 VIN conciliados**, bajo la agrupación comercial actual de SALES P1@0.13. Se reutiliza el helper P2 existente y su núcleo estadístico sin cambios. No hubo despliegue.

## Resumen

| Estado | Grupos |
| --- | ---: |
| IMPROVING | 2 |
| STABLE | 6 |
| DETERIORATING | 1 |
| UNKNOWN | 9 |

## Resultados individuales

IDs comerciales originales; las evidencias consultadas no publican nombres de grupo. No se inventaron etiquetas.

| dealer_group_id | VIN septiembre | Estado | Historia P1 usada | Meses positivos | Motivo |
| ---: | ---: | --- | --- | ---: | --- |
| 1 | 16 | STABLE | 2025-05–2026-09 | 17 | Evidencia suficiente; sin episodio confirmado |
| 2 | 38 | STABLE | 2025-05–2026-09 | 17 | Evidencia suficiente; sin episodio confirmado |
| 4 | 45 | UNKNOWN | 2025-09–2026-09 | 12 | Cero dentro de los 12 meses de referencia; MA12 no disponible |
| 5 | 12 | STABLE | 2025-05–2026-09 | 17 | Evidencia suficiente; sin episodio confirmado |
| 6 | 5 | UNKNOWN | 2025-09–2026-09 | 12 | Cero dentro de los 12 meses de referencia; MA12 no disponible |
| 8 | 1 | STABLE | 2025-05–2026-09 | 17 | Evidencia suficiente; sin episodio confirmado |
| 10 | 40 | STABLE | 2025-05–2026-09 | 17 | Evidencia suficiente; sin episodio confirmado |
| 11 | 23 | UNKNOWN | 2025-05–2026-09 | 14 | Solo dos errores MA12; no alcanza el mínimo de tres errores anteriores |
| 12 | 9 | DETERIORATING | 2025-05–2026-09 | 17 | Deterioro original confirmado |
| 13 | 54 | IMPROVING | 2025-05–2026-09 | 17 | Mejora espejo confirmada |
| 15 | 14 | UNKNOWN | 2025-09–2026-09 | 3 | Cero dentro de los 12 meses de referencia; MA12 no disponible |
| 16 | 6 | UNKNOWN | 2025-09–2026-09 | 5 | Cero dentro de los 12 meses de referencia; MA12 no disponible |
| 18 | 8 | UNKNOWN | 2025-09–2026-09 | 6 | Cero dentro de los 12 meses de referencia; MA12 no disponible |
| 19 | 274 | STABLE | 2025-05–2026-09 | 17 | Evidencia suficiente; sin episodio confirmado |
| 20 | 2 | UNKNOWN | 2025-09–2026-09 | 8 | Cero dentro de los 12 meses de referencia; MA12 no disponible |
| 21 | 33 | UNKNOWN | 2025-09–2026-09 | 7 | Cero dentro de los 12 meses de referencia; MA12 no disponible |
| 22 | 55 | IMPROVING | 2025-05–2026-09 | 17 | Mejora espejo confirmada |
| 29 | 26 | UNKNOWN | 2025-09–2026-09 | 4 | Cero dentro de los 12 meses de referencia; MA12 no disponible |

## Cobertura e historia adicional

P1 entregó los 13 meses septiembre 2025–septiembre 2026 para los 18 grupos, sin gaps. En diez grupos se consultaron mayo–agosto 2025: 17 meses es el mínimo continuo para MA12, tres errores anteriores y dos percentiles consecutivos. Se conservan todos los errores de la ventana indicada, sin ajustar umbrales ni episodios. Son resultados condicionados a esa ventana explícita; no se presentan como una corrida desde 2021.

Los grupos 4, 6, 15, 16, 18, 20, 21 y 29 tienen ceros certificados en la referencia actual. El núcleo existente excluye ceros sin evidencia independiente de actividad; más meses antiguos no reparan su MA12 actual. Los ceros se conservan como 0, nunca como ausencia de información.

El grupo 11 tiene ventas positivas desde agosto 2025 en la ventana consultada: solo genera errores MA12 en agosto y septiembre 2026. Para verificar si había historia anterior aprovechable se solicitó un agregado P1 de enero 2021–abril 2025: **0 VIN**, evidence_id `p1.sales.5e71374940e232f785d265a5`. Mayo–julio 2025 también son cero en la serie P1. Por ello ninguna observación anterior dentro de la política histórica puede añadir desviaciones evaluables y se conserva UNKNOWN. El agregado se archiva como auditoría de suficiencia; no se transforma en serie ni se introduce en P2.

No quedan meses solicitados pendientes por fallas de Azure. El journal conserva tres fallas de conexión y todas las consultas exitosas recuperadas. UNKNOWN expresa insuficiencia estadística/actividad no acreditada, no una falla de extracción. No se crea un contrato de membresía histórica as-of ni se modifica SALES P1.

## Conciliación y trazabilidad

- P1 total DEALERS: `p1.sales.9974c88c62da5d463181a616`, 661 VIN. Las 18 observaciones P1 de septiembre suman 661 y cada una coincide con el roster FETCH certificado del mismo run.
- Run Azure/P3: `closed-active-dealers-sales-20261027`. Los 28 envelopes de series originales utilizados por P2 se verificaron contra su salida original en ese journal. Son 274 observaciones mensuales. No se usa temporal_fingerprint como entrada P2.
- P2: `p2.closed_period_sales_performance@0.1.0`, dimensión lógica DEALER_GROUP, parámetros y evidence_refs originales. Ejecución **local** mediante executeP2; UUID, hashes, evidencia estadística y paridad con el deterioro original en p2-results.json. No se declara un evento P2 remoto/productivo.
- Agrupación: actual, igual que `scripts/publish-dealer-monthly-sellin.js` (blob `56e8ac9c546e1dcb34822a819fd296ed524ccb5d`). P1 observa cada mes completo con su propio corte; no se reemplaza la serie por conteos anuales del publicador.

## Pruebas

**67 pruebas locales aprobadas, 0 fallidas**, Node 24.22.1; no GitHub Actions. Incluyen cuatro estados, paridad exacta del núcleo con idéntica entrada, persistencia, percentiles, evidencia insuficiente, ceros frente a ausencia y rechazo de evidencia incompatible. El paquete no define un paso de build; se comprobó sintaxis Node de los módulos nuevos.

Replay de evidencia previa: **273 resultados idénticos por SHA-256 del resultado**: 14 Tiendas, 218 Vendedores y 41 Modelos. El núcleo, el helper de Tiendas y los adaptadores originales de datasets no cambian. Las comprobaciones de fuente legacy permanecen aprobadas.

## Archivos reproducibles

- [Contrato del adaptador](P2-CLOSED-DEALER-PERFORMANCE.md).
- [Resultados individuales CSV](validation/closed-dealer-performance-2026-09/individual-results.csv).
- [Resultados P2 completos](validation/closed-dealer-performance-2026-09/p2-results.json).
- [Entradas P1 originales](validation/closed-dealer-performance-2026-09/p1-inputs.json).
- [Journal Azure/P3 original](validation/closed-dealer-performance-2026-09/p1-journal.json).
- [Checks y regresiones](validation/closed-dealer-performance-2026-09/checks.json).

Para reproducir: `node scripts/validate-closed-dealer-performance.js docs/validation/closed-dealer-performance-2026-09`. Escribe informes locales; no consulta ni modifica bases de datos.
