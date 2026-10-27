# P2: clasificación de desempeño de tiendas en meses cerrados

Estado: IMPLEMENTADO, sin despliegue. La regla espejo propuesta en d866e51 fue aprobada explícitamente por el usuario el 26 de octubre de 2026.

## Contrato

Unidad: `p2.closed_period_store_performance@0.1.0`.
Alcance exclusivo: SALES / VIN_SALES / OWN_STORES / STORE.
No admite vendedores, dealers, modelos, FORUM, RVM, meses abiertos ni parámetros estadísticos alternativos.

Parámetros obligatorios:
- `cutoff_month`: mes calendario cerrado YYYY-MM según America/Santiago.
- `store_id`: una identidad canónica de sucursales_master.

Evidencia: una referencia P1 original por mes en slots `history_YYYY_MM`, desde 2021-01 hasta cutoff_month. Cada referencia debe ser `p1.dimensional_quantitative_dataset@0.1.0`, P1_CERTIFIED / CERTIFIED, SALES VIN_SALES OWN_STORES, dimensión STORE, sin filtros adicionales y con corte al último día calendario del mes. Se comparte la misma colección de referencias entre todas las tiendas; no se consultan las fuentes de nuevo por tienda.

El inicio 2021-01 reutiliza el alcance histórico de la política P1 existente E06_V0_1_HISTORY. No es un nuevo mínimo estadístico ni un parámetro ajustable del usuario. La suficiencia efectiva la determina el núcleo: referencia de doce meses anteriores completos, al menos tres errores anteriores para el percentil y dos meses evaluables consecutivos para descartar/confirmar mejora. La ausencia de un dataset P1 mensual completo produce UNKNOWN, no una clasificación con historia truncada.

Se utiliza este contrato P1 mensual existente porque, durante la validación, HISTORICAL_PERIOD_SERIES falló con HISTORICAL_SERIES_NOT_CERTIFIED y la serie mensual completa por tienda excedió el tiempo de respuesta del transporte; P3 confirmó después su finalización exitosa en backend. No se modificó P1 para sortear esos errores. El MCP genérico ya resuelve las referencias de todos los slots en el mismo run_id y registra la ejecución con P3; no requiere cambios de transporte ni tablas.

Ejemplo conceptual de llamada al MCP una vez autorizado y realizado el despliegue:

```json
{
  "run_id": "mismo-run-que-las-consultas-P1",
  "unit_id": "p2.closed_period_store_performance",
  "contract_version": "0.1.0",
  "parameters": {"cutoff_month": "2026-09", "store_id": "3"},
  "evidence": {
    "history_2021_01": "evidence_id-P1-original-de-enero-2021",
    "history_2026_09": "evidence_id-P1-original-de-septiembre-2026"
  }
}
```

El ejemplo abrevia las referencias intermedias: son obligatorias para obtener un resultado evaluable. El helper no está publicado en Azure por este commit.

## Reutilización y reglas

Se clonaron sin cambios seis archivos puros del núcleo histórico de solo lectura `cidef-data-loader@16f01f381238bc058c3e25e88dca7b550aa487f7` dentro de `lib/p2/closed-performance/legacy/`. Los hashes Git originales están en `test/fixtures/closed-performance-legacy-hashes.json` y se verifican automáticamente. No se copiaron loaders, conexiones, consultas ni motores de adquisición.

El helper importa el cálculo original de moving_average_12, desviación, percentiles con empates a mitad y la clasificación original completa. El motor productivo existente no se modifica.

| Estado | Regla |
| --- | --- |
| DETERIORATING | Resultado DETERIORATING del núcleo original: dos meses adversos consecutivos con errores estrictamente decrecientes; persiste mientras siga adverso. Tiene prioridad. |
| IMPROVING | Percentil >0,5 en dos meses consecutivos con errores estrictamente crecientes; persiste mientras siga favorable. |
| STABLE | Mes actual y anterior evaluables, sin ninguno de los dos episodios confirmado/activo. Puede contener una señal de un solo mes aún no confirmada. |
| UNKNOWN | Falta observación, referencia, errores históricos, segundo mes evaluable o evidencia P1 mensual completa. |

Para la mejora se reflejan los errores (error → -error) y los percentiles (p → 1-p) y se llama al MISMO clasificador original. Así se reutilizan exactamente sus reglas de continuidad, confirmación y persistencia. Un percentil igual a 0,5 no activa episodios. No se implementa un contraste de hipótesis ni se afirma significancia inferencial.

La matriz de precedencia y el motivo se devuelven explícitamente. UNKNOWN no se transforma en STABLE.

## Ceros, historia y alcance de la paridad

Un mes ausente en STORE no se rellena con cero. Un cero explícito sin evidencia independiente de actividad tampoco se convierte en ACTIVE_ZERO. Ambos quedan UNKNOWN en el índice disperso, y si impiden una referencia de doce meses o la evidencia consecutiva se obtiene UNKNOWN. Los errores históricos disponibles se conservan a través de huecos como hace el núcleo original; los episodios sí pierden continuidad.

La equivalencia demostrada es **paridad del estado original sobre las mismas observaciones P1**: estado, motivo, observación, valores, inicio, confirmación y meses de evidencia. La mejora complementa ese resultado sin cambiarlo.

No se declara paridad de adquisición con el runtime legacy completo. El runtime histórico usa snapshots de reconocimiento y actividad independiente de notas de venta; las evidencias mensuales utilizadas aquí no exponen esa actividad ni reconstruyen toda la historia al corte de cada ventana previa. Cambios retrospectivos de reconocimiento e identidades también pueden producir diferencias. Si se requiere equivalencia integral de adquisición, hace falta que P1 exponga esa evidencia ya certificada; no se recrea consultando RAW desde P2 ni se modifica P1 en este encargo.

## Salida y trazabilidad

La salida conserva estado/motivo, período/corte, tienda, política fija, parámetros efectivos, suficiencia y cobertura, estado original completo, episodio de mejora y filas estadísticas con ventas, referencia, error, percentil y número de errores anteriores.

Incluye referencias originales P1 con versión, corte y lineage, y observaciones usadas por período. `executeP2` añade execution_id, run_id, unidad, contrato/executor/versiones, parámetros y referencias; el MCP productivo utiliza su journal P3 existente después del despliegue autorizado.

La validación de esta entrega ejecuta el código P2 localmente sobre objetos originales P1 recuperados de Azure. No se presenta como ejecución remota del nuevo helper ni como un evento P2 ya publicado en P3 Azure.

## Validación reproducible

Pruebas específicas y regresiones pertinentes:

```bash
node --test test/p2-closed-period-store-performance.test.js test/p2-open-period-deterioration-risk.test.js test/p2-vertical-slice.test.js test/p2-target-attainment-seller-contribution.test.js
```

Validación de septiembre sobre evidencias originales archivadas:

```bash
node scripts/validate-closed-store-performance.js docs/validation/closed-store-performance-2026-09-p1.json /tmp/closed-store-performance-results.json
```

El script exige ejecución válida, verifica paridad del estado original sobre las mismas entradas y reconcilia la población de tiendas con el total P1 de septiembre. El informe contiene hash SHA-256 del archivo de entradas, run_id, evidencia por período y lineage P2 por tienda. Las pruebas sintéticas cubren los cuatro estados sin forzar que los datos reales presenten todos.

Ver `docs/P2-CLOSED-STORE-PERFORMANCE-VALIDATION-2026-09.md` para resultados, límites y pendientes de la validación real. Sin frontend, infraestructura, tablas, staging ni despliegue.
