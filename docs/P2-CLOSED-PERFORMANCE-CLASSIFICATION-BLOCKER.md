# Helper P2 de desempeño cerrado: bloqueo metodológico

Estado histórico de d866e51: propuesta que estaba pendiente. El usuario aprobó explícitamente la regla espejo el 26 de octubre de 2026. La implementación y el contrato vigentes se documentan en [P2-CLOSED-STORE-PERFORMANCE.md](P2-CLOSED-STORE-PERFORMANCE.md). Las secciones siguientes conservan el diagnóstico previo a esa aprobación.

Fecha de revisión: 26 de octubre de 2026.
Alcance inicial solicitado: SALES / OWN_STORES / STORE / septiembre de 2026.
Azure revisado: `0faeeffd19f00121d9d473e08e0c1b27b6bfd7a9`.
Referencia histórica de solo lectura: `cidef-data-loader@16f01f381238bc058c3e25e88dca7b550aa487f7`.

## Motivo de la detención

La instrucción del encargo establece: «si los criterios estadísticos existentes no permiten definir IMPROVING sin nuevas decisiones metodológicas, no inventar una regla. Documentar el bloqueo y proponer la alternativa mínima antes de implementar».

El núcleo revisado no contiene una definición productiva de mejora estadísticamente relevante. Sus resultados son DETERIORATING, NOT_DETERIORATING y UNKNOWN. NOT_DETERIORATING incluye tanto ausencia de episodio como recuperación o situaciones aún no confirmadas; no equivale por sí solo a STABLE ni IMPROVING.

El percentil histórico es una posición empírica de la desviación respecto de errores anteriores. El código no define un contraste de hipótesis, nivel de significancia ni regla de mejora. Estar por encima del percentil 0,5 no demuestra significancia estadística convencional.

Por ello no se ha creado un helper, añadido una unidad al registry, publicado un contrato ni generado nuevas clasificaciones de tiendas.

## Regla existente que debe permanecer intacta

- Grano productivo fijo: tienda; solo meses calendario cerrados en America/Santiago.
- Referencia: moving_average_12 de meses anteriores.
- Error: valor observado menos referencia.
- Percentil histórico disponible con al menos tres errores anteriores; empates con peso 0,5.
- Observación adversa: historical_percentile < 0,5.
- Confirmación: deepening_2, dos meses adversos consecutivos con error estrictamente decreciente.
- El episodio confirmado permanece activo mientras las observaciones sigan adversas.
- Una observación no adversa o un hueco UNKNOWN interrumpe la continuidad.
- La ausencia no se rellena con cero; el cero activo requiere evidencia independiente según la semántica histórica.
- Los motivos UNKNOWN incluyen falta de observación actual, referencia o desviación evaluable.

Fuentes históricas:
- [Política fija](https://github.com/rodrigoibanezm-cmd/cidef-data-loader/blob/16f01f381238bc058c3e25e88dca7b550aa487f7/lib/deterioration/deteriorationStatusInput.js).
- [Estado productivo](https://github.com/rodrigoibanezm-cmd/cidef-data-loader/blob/16f01f381238bc058c3e25e88dca7b550aa487f7/lib/deterioration/buildCurrentDeteriorationStatus.js).
- [Desviaciones](https://github.com/rodrigoibanezm-cmd/cidef-data-loader/blob/16f01f381238bc058c3e25e88dca7b550aa487f7/lib/deterioration/orgDeviations.js).
- [Persistencia](https://github.com/rodrigoibanezm-cmd/cidef-data-loader/blob/16f01f381238bc058c3e25e88dca7b550aa487f7/lib/deterioration/orgPersistence.js).

## Alternativa mínima para aprobación: regla espejo complementaria

Esta alternativa reutiliza los valores numéricos existentes, pero añade una decisión metodológica. No está aprobada ni se presenta como certificada.

1. Mantener exactamente la clasificación productiva de deterioro, con prioridad sobre cualquier mejora.
2. Definir observación favorable como percentil histórico estrictamente mayor que 0,5, con la misma referencia y cálculo de errores.
3. Confirmar mejora con dos meses favorables consecutivos y error estrictamente creciente.
4. Mantener el episodio de mejora mientras el percentil siga siendo mayor que 0,5; terminarlo ante una observación no favorable o UNKNOWN.
5. Tratar un percentil exactamente igual a 0,5 como neutral, sin activar mejora ni deterioro.
6. Exigir historia y observaciones evaluables suficientes para decidir la mejora. Si falta esa evidencia, devolver UNKNOWN, incluso si el motor anterior no confirmó deterioro.
7. Devolver STABLE solo si hay evidencia suficiente y no está activo ninguno de los dos episodios.

Precedencia propuesta:

| Evidencia | Resultado propuesto |
| --- | --- |
| Deterioro confirmado por la regla original | DETERIORATING, sin alterarlo |
| Estado original UNKNOWN, o evidencia complementaria insuficiente | UNKNOWN con motivo |
| Sin deterioro y mejora espejo confirmada/activa | IMPROVING |
| Sin deterioro ni mejora y evidencia suficiente | STABLE |

La decisión pendiente es aprobar esta simetría como criterio operativo de mejora. No debe denominarse prueba de significancia estadística sin definir y validar ese significado. Una prueba inferencial requeriría decisiones adicionales y excedería esta alternativa mínima.

## Contrato P2: requisitos para la implementación posterior

No hay contrato nuevo registrado. El contrato propuesto deberá:

- Admitir únicamente SALES, VIN_SALES, OWN_STORES y una identidad de tienda compatible en todas las evidencias.
- Evaluar un mes cerrado explícito; preservar UNKNOWN, ceros certificados y cobertura histórica.
- Consumir referencias P1 originales, con historia suficiente para reproducir la regla productiva y evaluar la mejora.
- Reutilizar las funciones estadísticas históricas sin modificar el motor productivo ni los otros motores.
- Verificar la compatibilidad de los contratos P1 con la semántica histórica de actividad; contar ventas cero no prueba por sí solo actividad de la unidad.
- Devolver state, reason, período, cutoff, estado original de deterioro, evidencia de mejora, referencia, error, percentil, períodos usados y cobertura.
- Registrar versión de política, parámetros, referencias P1 y resultado mediante el mecanismo P3 existente, sin nuevas tablas.

La carpeta del núcleo cerrado histórico no está presente en el main Azure revisado. Su adaptación a entradas P1 debe conservar la lógica y comprobar paridad, sin importar loaders Neon ni modificar el motor existente de riesgo abierto.

## Mes abierto: contrato separado

`p2.open_period_deterioration_risk@0.1.0` ya existe en Azure. Exige VIN_SALES, OWN_STORES, la misma tienda, historia cerrada y escenarios intrames al mismo día; su implementación requiere al menos 16 observaciones mensuales cerradas anteriores.

Produce riesgo de cierre y el estado previo; no sustituye la clasificación de septiembre cerrado. El nuevo helper no debe llamar este riesgo con un período artificial ni alterar su comportamiento.

## Validación pendiente

No se ejecutó clasificación real de septiembre ni se declara un helper probado. Después de aprobar el criterio:

- Verificar paridad de DETERIORATING y UNKNOWN contra el motor histórico, incluidos episodios que continúan aunque el último error deje de profundizarse.
- Probar mejora confirmada, mejora de un solo mes no confirmada, estabilidad evaluable y evidencia insuficiente.
- Probar empates en percentil 0,5, errores iguales, huecos temporales, cero activo certificado y ausencia sin evidencia.
- Rechazar evidencia incompatible/no certificada y meses abiertos.
- Consultar historia certificada de tiendas para septiembre de 2026 y reportar resultados reales, suficiencia y trazabilidad; no forzar que las tiendas cubran todos los estados.
- Separar casos sintéticos de prueba de los resultados reales certificados.
- Ejecutar regresiones pertinentes sin modificar otros motores.

Este cambio contiene exclusivamente documentación. Sin código, modificaciones de reglas, frontend, datos comerciales, infraestructura, staging, Actions ni despliegue.
