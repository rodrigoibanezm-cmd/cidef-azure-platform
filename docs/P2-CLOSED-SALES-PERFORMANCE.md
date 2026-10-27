# P2: extensión de desempeño cerrado a SALES

Estado: adaptadores SELLER y MODEL implementados, sin despliegue. Se incorpora DEALER_GROUP mediante series P1 filtradas y agrupación comercial actual, por autorización explícita del encargo posterior; no se habilita una dimensión P1 ni se certifica membresía histórica as-of. Véase [contrato Dealers](P2-CLOSED-DEALER-PERFORMANCE.md). El bloqueo dimensional histórico descrito abajo se conserva como contexto de aquel alcance, no como impedimento para esta entrada de series. Tiendas y las reglas estadísticas existentes permanecen intactas.

## Contrato y ámbito

Unidad complementaria: `p2.closed_period_sales_performance@0.1.0`.

| Dimensión | Universo fijo | Identidad P1 | Entrada |
| --- | --- | --- | --- |
| SELLER | OWN_STORES | personas_master@0.1 | Datasets mensuales SELLER originales |
| MODEL | COMPANY | modelos_master_v01@0.1 | Datasets mensuales MODEL originales |
| STORE | OWN_STORES | sucursales_master@0.1 | Conserva p2.closed_period_store_performance@0.1.0; no se cambia |
| DEALER_GROUP | DEALERS | dealer_group_id como filtro P1; agrupación actual, sin certificar membresía as-of | Series P1 originales filtradas; ver contrato Dealers |

Parámetros obligatorios: `cutoff_month` (mes cerrado), `dimension` (SELLER, MODEL o DEALER_GROUP) y `member_id` canónico o ID de grupo actual según el caso. No admite umbrales, ventanas, universos alternativos, agrupación por nombre ni meses abiertos.

**SELLER/MODEL:** cada slot `history_YYYY_MM` contiene el evidence_id original de un dataset mensual `p1.dimensional_quantitative_dataset@0.1.0`, P1_CERTIFIED/CERTIFIED, SALES VIN_SALES, con corte de fin de mes. Se exige evidencia desde 2021-01 hasta el mes solicitado, como en c3ee707. Se reutiliza cada dataset para todos los miembros. El MCP y P3 existentes resuelven/journalizan esos refs después de un despliegue autorizado; no se modifica su transporte.

## Reutilización exacta

La unidad nueva importa `classifyClosedPerformance` de c3ee707. No modifica ni copia el clasificador, el helper de Tiendas, la referencia MA12, las desviaciones, los percentiles ni la persistencia.

Se conservan IMPROVING, STABLE, DETERIORATING y UNKNOWN, su precedencia, percentil 0,5, tres errores anteriores para el percentil y dos observaciones consecutivas evaluables para confirmar/descartar mejora. Se conserva la versión de política histórica `CLOSED_STORE_PERFORMANCE_MIRROR_V01`: su nombre no convierte las evidencias SELLER/MODEL en STORE.

Los nombres de argumentos internos storeId/storeLabel se mantienen por compatibilidad del núcleo; reciben el ID/etiqueta del miembro, sin alterar dimensión, universo, payload o autoridad P1. No hay renombrado de evidencias, cálculos comerciales fuera del helper ni motor estadístico duplicado.

## Identidad, continuidad y suficiencia (SELLER/MODEL)

Los IDs canónicos y el contrato/versión de identidad deben conservarse en toda la historia. Cambios de versión o evidencia mezclada se rechazan. Dos IDs con el mismo nombre permanecen separados; un nombre que cambia con el mismo ID no rompe su continuidad. No se cosen IDs antiguos/nuevos ni se infiere relación laboral por presencia de ventas. Un ID numérico nunca observado en P1 devuelve UNKNOWN/P1_MEMBER_IDENTITY_UNCONFIRMED y no se declara canónico.

La clasificación requiere cobertura P1 mensual completa y conciliación de valores y cobertura de identidad. Si falta un dataset, devuelve UNKNOWN/P1_HISTORY_COVERAGE_INCOMPLETE. SELLER conserva el bloqueo por identidad UNRESOLVED. Para MODEL, el adaptador valida las dependencias de todas las filas estadísticas posibles: un residual bloquea al miembro si puede afectar un valor, una MA12 o un error histórico que entra en percentiles/episodios. No basta revisar los últimos 12 o 17 meses: los errores anteriores también cuentan. Los residuales sin dependencia posible se conservan en coverage.identity_validation.excluded_unresolved_periods con período, cantidad, evidence_id y motivo; no se reparten entre modelos ni se eliminan de la evidencia P1. Si hay una dependencia potencial o falta evidencia mensual, se conserva UNKNOWN. Se usa presencia posible únicamente como cota estructural, sin imputar cantidades. No se recorta historia, se mantienen todos los errores originales y no se cambian umbrales. Véase P2-MODEL-IDENTITY-COVERAGE-2026-09.md.

Con la evidencia íntegra y resuelta, los huecos de observación de un miembro se pasan al mismo núcleo disperso existente: impiden referencias completas y rompen episodios; los errores disponibles se conservan según la regla original.

## Cero frente a ausencia (SELLER/MODEL; Dealers en su contrato complementario)

| Evidencia | Valor conservado | observation_state |
| --- | --- | --- |
| Miembro con ventas positivas | Cantidad P1 | OBSERVED_POSITIVE |
| Miembro explícito con ventas cero | 0 | ZERO_SALES_ACTIVITY_UNVERIFIED |
| Dataset presente, miembro no observado | null | NOT_OBSERVED |
| No hay dataset P1 del mes | null | NO_P1_DATASET |

El cero de ventas no se convierte en ausencia ni la ausencia en cero. Sin embargo, los contratos dimensionales existentes no publican evidencia independiente de actividad para acreditar ACTIVE_ZERO. Por ello los ceros sin esa prueba siguen excluidos del índice estadístico, exactamente como en c3ee707. Si falta suficiencia, se devuelve UNKNOWN. La extensión no inventa ceros activos ni cambia esa regla.

## Dealers: distinción entre identidad dimensional histórica y agrupación actual

P1 SALES@0.13 publica `dealer_group_id` como campo/filtro, pero no como dimensión con contrato de identidad/versión, catálogo de grupos ni cobertura de membresía histórica. El contrato dimensional publicado admite MODEL, STORE, SELLER, FINANCIAL_ENTITY y NETWORK; tampoco el grouping interno añade DEALER_GROUP.

FETCH de septiembre sí devuelve IDs de grupos asociados a ventas reconocidas; no se afirma que esos datos no existan. Las observaciones escalares/series filtradas permiten medir una selección de IDs, pero no suministran el contrato dimensional de identidad y continuidad requerido para este adaptador. FETCH no tiene el evidence_id/contrato dimensional que resuelve P2. No se le añade artificialmente autoridad, versión, dimensión ni etiquetas.

El encargo posterior autoriza explícitamente usar la agrupación actual, igual que el publicador. Esa entrada ya se implementa como series P1 filtradas dentro del mismo helper, sin fabricar un dataset dimensional ni modificar P1. Véase P2-CLOSED-DEALER-PERFORMANCE.md. La eventual certificación de membresía histórica as-of sigue siendo un alcance distinto, no requerido para esa clasificación.

## Salida, validación y trazabilidad

La salida conserva valor P1 incluso con estado UNKNOWN, período/corte, dimensión/ID/etiqueta, contrato de identidad, política, estado original, episodio de mejora, filas estadísticas, suficiencia, referencias originales y distinción entre ceros y falta de observación.

El validador de septiembre usa la unión de IDs canónicos observados en la historia P1 2021-01–2026-09 para SELLER/MODEL; no es una nómina de activos. Informa por separado los miembros observados en septiembre, los que no tienen observación actual y los cuatro estados. Tiendas conserva su población original de 14 miembros y sus mismos resultados.

La ejecución de P2 es local sobre evidencia original Azure; no es una ejecución remota de la nueva unidad ni un evento P2 publicado en P3 productivo. El journal P1 original, execution_id local, parámetros, refs y hashes permiten reproducirla.

Los temporal_fingerprint adicionales tienen delivery.p2_input=false y no se utilizan ni se convierten en historia certificada de entrada. Los archivos de entrada conservan íntegro el envelope P1 utilizado, omitiendo únicamente ese contexto adicional dirigido al LLM.

Pruebas:

```bash
node --test test/p2-closed-period-sales-performance.test.js test/p2-closed-period-store-performance.test.js test/p2-open-period-deterioration-risk.test.js test/p2-vertical-slice.test.js test/p2-target-attainment-seller-contribution.test.js
```

Reproducción (no consulta fuentes, escribe los informes locales del directorio indicado):

```bash
node scripts/validate-closed-sales-performance.js docs/validation/closed-sales-performance-2026-09
```

Resultados y pendientes: [validación de septiembre](P2-CLOSED-SALES-PERFORMANCE-VALIDATION-2026-09.md). Sin frontend, FORUM, RVM, infraestructura, tablas, staging ni despliegue.
