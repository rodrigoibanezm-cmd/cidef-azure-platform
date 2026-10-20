# Cómo vamos — snapshots (contrato de arquitectura)
Status: DISEÑO ACORDADO, no asumir implementado. Leer `AGENTS.md` primero.

## Ámbito
- Solo SALES, FORUM, RVM. CRM y PRICING fuera.
- 3 tablas PostgreSQL Azure: `cv_sales_snapshots`, `cv_forum_snapshots`, `cv_rvm_snapshots`. Rankings dentro de SALES; **no** tabla aparte.
- Cada tabla guarda resultados certificados por dominio: Compañía, FOTON/DONGFENG, canales, tiendas, vendedores, dealers, modelos **solo cuando el motor certifique esas dimensiones**.
- Fuente: cargas -> Azure PostgreSQL -> P1 hechos -> P2 transformaciones necesarias -> P3 evidencia -> snapshot -> API frontend. La API no calcula métricas consultando RAW directamente. El frontend solo lee payloads certificados.

## Entornos: decisión vinculante
- **Producción y staging de “Cómo vamos” usan exactamente las mismas tres tablas** `cv_sales_snapshots`, `cv_forum_snapshots`, `cv_rvm_snapshots` y el mismo PostgreSQL Azure.
- Misma API de lectura, contratos P1/P2/P3, firmas, invalidación y bloqueo de regeneración para ambos entornos; regeneraciones idempotentes y coordinadas. Staging nunca reconstruye por separado ni sobrescribe con datos ficticios.
- La separación de entornos es de **código/despliegue del front**, no de bases, snapshots ni motores. No agregar `environment` como partición funcional de snapshots.
- **No montar ahora un staging nuevo para “Cómo vamos”**: solo cuando la versión esté suficientemente avanzada y el usuario lo autorice. Reutilizar el staging existente del frontend si aplica; no crear servicios, tablas, workflows ni infraestructura nueva por defecto.
- Si se propone aislamiento adicional, detenerse, evaluar necesidad y opción mínima; pedir aprobación explícita antes de tocar arquitectura.

## Vigencia
- Capturar `period`, `cutoff_date`, `scope` (cuando aplique), `source_signature`, `engine_signature`, `payload JSONB`, `p3_run_id`, `status`, `generated_at`. Son campos conceptuales; revisar convenciones existentes antes de crear esquema.
- Firmas de datos por dominio registradas **tras cargas exitosas**; no escanear RAW completo al abrir la página. Firma de motores/contratos invalida también si cambió la semántica.
- Apertura/navegación: comparar firmas de metadatos y leer snapshot si vigente; **no recalcular** al cambiar filtros de dimensiones ya incluidas. Invalidar solo dominio afectado.
- Al detectar firma nueva: disparar regeneración de ese dominio de inmediato, **una sola ejecución concurrente**, conservar versión anterior certificada como STALE identificada, publicar nuevo snapshot solo al completar validación; reemplazo transaccional. Nunca mostrar stale como actual.
- Si falla generación: conservar último certificado con aviso de desfase; no publicar resultados parciales ni falsos ceros.

## Pasado
- Snapshots históricos **diarios bajo demanda**: generar con P1/P2/P3 solo si se pide fecha sin snapshot válido. Persistir y reutilizar sin coste de recálculo.
- Registrar fecha de consulta, corte y firmas. Distinguir una foto original obtenida entonces de una reconstrucción posterior con fuentes corregidas. No afirmar reconstruibilidad si faltan snapshots de origen.
- Invalidación histórica **selectiva** si cambió el universo/corte/versiones pertinentes, no por cualquier carga nueva.
- PRECURSE = stock del **último snapshot FORUM**, nunca serie mensual ni stock histórico inferido; `series: []` hasta contar con contrato histórico certificado.

## Dominios y UI
- SALES: VIN, canales OWN_STORES/DEALERS, marcas, detalle y rankings certificados.
- FORUM: QUOTATIONS, PRECURSE, UFIS; cortes propios, no inferir equivalencia con SALES.
- RVM: inscripciones y participación con denominador P1 y derivación P2 certificados; corte RVM propio, no mezclar identidades sin resolver.
- Tendencias seis meses base 100: índices provenientes de P2, nunca derivados en navegador; mes abierto con cortes equivalentes **solo si certificados**.
- Mantener `/cierre-mensual` congelado e independiente.

## Implementación
- Antes de nuevas tablas/Actions/motores: localizar patrón existente reutilizable, proponer alternativa mínima. No crear megatabla, nueva infraestructura ni recalcular todo al abrir. Separar backend motores (Azure platform) y UI (front).

## Avance SALES Compañía — 20-10-2026
- Código creado en `motor-test-azure/sales-snapshot.js`: lectura por firma, bloqueo compartido para no duplicar generación y UPSERT transaccional. Reutiliza `buildComoVamosSales` de `motor-test-azure/como-vamos.js` (P1 y P3 existentes).
- DDL definido en `scripts/sql/cv-sales-snapshots.sql`. **Archivo SQL no implica tabla instalada:** verificar PostgreSQL Azure antes de afirmar que existe.
- **Pendiente obligatorio antes del primer uso real:** obtener `sourceSignature` desde metadatos verificables de la carga SALES exitosa. No aceptar una firma enviada por navegador, ni sustituirla por timestamps locales o un recuento completo de RAW.
- `SALES_ENGINE_SIGNATURE` debe cambiar cuando se modifique la semántica del generador. La firma de datos controla las cargas; son independientes.
- Aún no se conectó ninguna ruta HTTP ni se ejecutó una validación real en Azure. No afirmar snapshot certificado persistido hasta completar migración, alimentación de firma y doble lectura HIT.
- El generador SALES actual recibe `period`, **no permite solicitar arbitrariamente un corte diario histórico**. No exponer generación histórica diaria hasta ampliar/reutilizar un contrato P1 con corte explícito; no falsificar fotos de un día anterior.
- Primera entrega limitada a SALES Compañía. FORUM, RVM, rankings y otras dimensiones no se implementan en este avance.
