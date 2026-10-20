# Cómo vamos — snapshots (contrato de arquitectura)
Status: DISEÑO ACORDADO, no asumir implementado. Leer `AGENTS.md` primero.

## Ámbito
- Solo SALES, FORUM, RVM. CRM y PRICING fuera.
- 3 tablas PostgreSQL Azure: `cv_sales_snapshots`, `cv_forum_snapshots`, `cv_rvm_snapshots`. Rankings dentro de SALES; **no** tabla aparte.
- Cada tabla guarda resultados certificados por dominio: Compañía, FOTON/DONGFENG, canales, tiendas, vendedores, dealers, modelos **solo cuando el motor certifique esas dimensiones**.
- Fuente: cargas -> Azure PostgreSQL -> P1 hechos -> P2 transformaciones necesarias -> P3 evidencia -> snapshot -> API frontend. La API no calcula métricas consultando RAW directamente. El frontend solo lee payloads certificados.

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
