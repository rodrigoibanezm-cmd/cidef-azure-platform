# Publicación SALES P2 de cierre en Azure

Preparación del cierre 2026-09, corte 2026-09-30. **Sin despliegue ni ejecución remota de estos helpers en esta entrega.**

## Registro y transporte existentes

Los helpers ya están registrados como ACTIVE en `lib/p2/registry.js`, versión 0.1.0:

| Dimensión | Unidad | Parámetros |
| --- | --- | --- |
| Tiendas | p2.closed_period_store_performance | cutoff_month, store_id |
| Vendedores | p2.closed_period_sales_performance | cutoff_month, dimension=SELLER, member_id |
| Dealers actuales | p2.closed_period_sales_performance | cutoff_month, dimension=DEALER_GROUP, member_id |
| Modelos | p2.closed_period_sales_performance | cutoff_month, dimension=MODEL, member_id |

`Dockerfile.motor-test-azure` copia `lib` completo. `motor-test-azure/server.js` monta `/api/mcp`; `lib/mcp/server.js` expone `p2_discover`, `p2_describe`, `p2_execute` y `run_trace`. No hay una lista adicional que registrar ni un nuevo endpoint que crear.

`p2_execute` resuelve IDs P1 del **mismo run** mediante `resolveP1EvidenceRefs`, ejecuta el helper existente y journaliza parámetros, salida y lineage mediante `journalP3Tool`. `run_trace` recupera esos eventos de `p3_runs`/`p3_events` existentes. No se requiere DDL, migración, snapshot adicional ni persistencia en archivos para servir el cierre.

La consulta real `p2_discover`, run `prepare-sales-closed-p2-publication-20261027`, aún devuelve 13 unidades y no incluye estos dos helpers (27-10-2026). Esto comprueba el estado anterior a la publicación; el registro local de 15 unidades no prueba disponibilidad en Azure.

## Cambio mínimo

Se incorpora `scripts/validate-closed-sales-performance-mcp.js`, un cliente de validación del transporte existente. No importa ni replica el clasificador. Solo llama P1/P2/P3, concilia cantidades y comprueba recuperación. No cambia SALES P1, las reglas P2, P3, frontend, FORUM, RVM, Dockerfile ni workflows.

Para evitar sustituir fuentes vigentes por archivos archivados, el cliente:

1. Comprueba publicación y versión de ambos helpers antes de observar P1.
2. Recupera de P3 las consultas P1 originales, reutilizando sus contratos, períodos, cortes, dimensiones y filtros. Las respuestas anteriores sirven de referencia de auditoría, **nunca de entrada alternativa**.
3. Vuelve a observar P1 actual en un único run nuevo. Tiendas, Vendedores y Modelos comparten su respectivo dataset entre miembros y conservan los 69 meses 2021-01–2026-09. No se usa la historia vieja como vigente sin verificarla.
4. Dealers reutiliza los rangos no superpuestos aprobados: 2025-09–2026-09 y, donde existía, calentamiento 2025-05–2025-08. Mantiene explícito ese alcance histórico; no afirma membresía as-of. Si aparecen grupos sin plan previo, detiene la validación y pide revisar el alcance, sin inventar historia ni IDs.
5. Evalúa los IDs de septiembre: todas las tiendas publicadas, vendedores/modelos con valor positivo y dealers del `data_fetch` SALES actual. Nunca usa los 218 vendedores históricos como nómina de septiembre.
6. Conciliación independiente con observaciones cuantitativas P1 actuales por universo. No fuerza 373/1034 históricos: la validación MODEL más reciente ya había observado 1033 VIN, TM3=171 frente a 172 anteriormente.
7. Ejecuta cada miembro por `p2_execute`, conservando UNKNOWN, valor, ID, política, período, corte, versión, execution_id y refs. No clasifica por su cuenta.
8. Relee `run_trace` y exige igualdad de cada salida P2, parámetros y referencias P1 del run. El informe local es un comprobante; el origen consultable es P3.

Comparación conservadora de evidencia: se compara todo el envelope P1 salvo `evidence_id` y `temporal_fingerprint` (este último ya está excluido del input P2). Cambios de cobertura o lineage también se señalan para revisión; no todos implican variación del valor comercial.

| Dimensión | Miembros de referencia | IMPROVING | STABLE | DETERIORATING | UNKNOWN |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tiendas | 14 | 1 | 9 | 0 | 4 |
| Vendedores observados en septiembre | 69 | 4 | 12 | 0 | 53 |
| Dealers | 18 | 2 | 6 | 1 | 9 |
| Modelos | 20 | 4 | 5 | 0 | 11 |

Estos son controles de conciliación, no resultados precargados. Si P1 cambió o los conteos difieren, se conservan las salidas actuales en P3 y el informe termina `CURRENT_P1_REVIEW_REQUIRED`, exit code 2. No se sustituyen por la tabla. Un fallo de P1/P2/P3 produce error, sin fallback. No ejecutar durante cargas comerciales: estas consultas sucesivas no constituyen un snapshot transaccional de toda la base. La evidencia certificada y la hora de cada llamada quedan en P3.

## Publicar cuando se autorice

Mecanismo existente: `.github/workflows/deploy-motor-test-azure.yml`, **Deploy independent motor-test MCP to Azure**, `workflow_dispatch`, rama `main`, Environment `Production`. Usa GitHub OIDC, ACR `cidefprodacr.azurecr.io`, imagen `cidef-motor-test-azure:<SHA>` y actualiza solo la Container App existente `cidef-motor-test-azure`, resource group `rg-cidef-prod`.

El filtro push del workflow no incluye `lib/p2/**`. Este cambio solo añade cliente, pruebas y documentación, con `[skip ci]`; no se amplía el disparador ni se ejecuta publicación automáticamente. No ejecutar workflows de loaders, inicialización P3 o creación de recursos.

Tras revisar/autorizar, desde un checkout de este commit en main y con las credenciales GitHub/Azure existentes:

```bash
gh workflow run deploy-motor-test-azure.yml --ref main
gh run list --workflow deploy-motor-test-azure.yml --event workflow_dispatch --branch main --limit 5
gh run view RUN_ID_DEL_WORKFLOW --json headSha,status,conclusion,jobs
```

Usar el run cuyo `headSha` corresponda al commit revisado; si main avanzó, revisar esos cambios antes de publicar. El workflow construye el SHA de su propia ejecución, comprueba imagen/revisión activa, `/healthz`, `/readyz`, transporte y validaciones existentes. Un workflow verde **no acredita por sí solo** estas cuatro clasificaciones.

Confirmación operativa de la revisión y obtención del endpoint, sin modificar recursos:

```bash
az containerapp show --resource-group rg-cidef-prod --name cidef-motor-test-azure --query '{image:properties.template.containers[0].image,latest:properties.latestRevisionName,ready:properties.latestReadyRevisionName,fqdn:properties.configuration.ingress.fqdn}' --output json
```

La imagen debe terminar en el SHA publicado y la revisión latest debe ser ready. Configurar `MCP_URL=https://FQDN_CONFIRMADO/api/mcp` con el FQDN real devuelto; no adivinar URL.

## Validar después del despliegue

Desde la raíz del checkout, con Node >=22. Las dependencias son las mismas que instala el workflow actual; no se requieren credenciales DB en este cliente remoto:

```bash
npm install --no-save --no-package-lock --ignore-scripts @modelcontextprotocol/sdk@1.26.0 zod@3.25.76 pg@8.16.3
export MCP_URL='https://FQDN_CONFIRMADO/api/mcp'
node scripts/validate-closed-sales-performance-mcp.js --check
```

`--check` llama discovery/describe, registra su auditoría habitual P3 y no ejecuta clasificaciones ni observa ventas. Si falta un helper, detenerse: no usar informes locales para simular disponibilidad.

Para ejecutar las cuatro dimensiones con P1 vigente y registrar P2 en P3:

```bash
export RUN_ID="closed-sales-publication-$(date -u +%Y%m%dT%H%M%SZ)"
export REPORT_PATH="/tmp/$RUN_ID.json"
node scripts/validate-closed-sales-performance-mcp.js --execute
```

Se realizan lecturas comerciales P1 y escrituras de auditoría P3, no cargas comerciales. Las llamadas son secuenciales para no repetir preparación del mismo dataset por miembro ni saturar Azure. Usar un run nuevo por intento; no sobrescribir reportes (creación exclusiva). Si falla, conservar el run_id impreso al inicio y revisar `run_trace`; los eventos completados permanecen auditables. No declarar completo un run parcial.

Para recuperar después, incluso desde otro proceso, invocar el **tool existente** `run_trace` con `{ "run_id": "RUN_ID_DE_VALIDACION" }` sobre `/api/mcp`. Un cliente MCP server-side puede leerlo igual que el validador; no necesita ejecutar P1/P2 al abrir la página. En sus eventos, seleccionar:

- `floor=P2`, `tool_name=p2_execute`, `status=SUCCESS`, `output_json.status=EXECUTED`.
- `input_json.unit_id` igual a una de las dos unidades anteriores, versión 0.1.0, `parameters.cutoff_month=2026-09`.
- Tiendas por `parameters.store_id`; las otras dimensiones por `parameters.dimension` y `parameters.member_id`.
- Usar `output_json.result` y `output_json.lineage` completos. Conservar UNKNOWN aparte. En reintentos del mismo miembro, elegir el evento exitoso más reciente por sequence_no, sin sumar ejecuciones repetidas.

El frontend debe conocer el run_id completo revisado; no buscar arbitrariamente el último run ni consumir el JSON de `/tmp`. Si hay `CURRENT_P1_REVIEW_REQUIRED`, revisar las diferencias y aprobar la evidencia vigente antes de conectarlo. Este trabajo no modifica el frontend.

## Pruebas locales

```bash
node --test test/closed-sales-performance-mcp.test.js test/p2-model-identity-coverage.test.js test/p2-dealer-series-performance.test.js test/p2-closed-period-sales-performance.test.js test/p2-closed-period-store-performance.test.js test/p2-open-period-deterioration-risk.test.js test/p2-vertical-slice.test.js test/p2-target-attainment-seller-contribution.test.js
```

83 pruebas aprobadas localmente (Node 24.22.1), no en GitHub Actions. Incluyen la clasificación real P2 de 121 miembros con P1 original de prueba, filtro de 69 vendedores, cuatro conteos, cambio de P1 sin sustitución histórica, indisponibilidad P1 y falta de recuperación P3. El transporte/P3 de esas pruebas es un doble offline, **no certificación remota**. Las pruebas anteriores mantienen paridad exacta de 250 resultados STORE/SELLER/DEALER_GROUP con sus mismas entradas. Sin cambios del núcleo ni de esas entradas archivadas.

Pendiente hasta autorización: desplegar, confirmar ambos helpers mediante consulta real, ejecutar el validador contra Azure y recuperar las cuatro dimensiones de P3. No se afirma disponibilidad productiva antes de completar esos pasos.
