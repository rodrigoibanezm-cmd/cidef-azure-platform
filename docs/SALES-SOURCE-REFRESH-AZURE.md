# SALES: actualización completa bajo demanda en Azure

Entrada CLI: `scripts/refresh-sales-sources-azure.js`.
Entrada importable: `runSalesRefresh({ dates, log })` de `src/loaders/sales/refresh.js`.
Importar el módulo no ejecuta cargas ni abre conexiones.

```sh
# Credenciales existentes, suministradas al proceso mediante variables de entorno:
# AZURE_DATABASE_URL, AZURE_STORAGE_CONNECTION_STRING
# AZURE_CONTAINER es opcional; por defecto cidef.
node scripts/refresh-sales-sources-azure.js --dates 2026-10-23
node scripts/refresh-sales-sources-azure.js --from 2026-10-21 --to 2026-10-23
```

Estos comandos escriben datos cuando se ejecutan; no forman parte de la validación local.
El intervalo incluye todos los días. También se admite `--dates 2026-10-21,2026-10-22,2026-10-23`.
Las fechas son obligatorias, válidas, únicas y se procesan en orden ascendente.
No se selecciona el último archivo de cada prefijo ni se consulta Neon/R2.

## Fuentes y orden

| Archivo de Azure Blob para YYYY_MM_DD | Tabla | Comportamiento heredado |
|---|---|---|
| ventas/Base_Unidades_por_Vistas_YYYY_MM_DD.xlsx | vehiculos_raw | Snapshot, limpieza, deduplicación, conservación y sincronización del ciclo RVM |
| ventas/Estadisticas_de_Venta_por_Vista_YYYY_MM_DD.xlsx | ventas_raw | Snapshot, marcas/categorías y excepciones de fecha existentes |
| ventas/Listado_Notas_de_Venta_YYYY_MM_DD.xlsx | notas_venta_raw | Snapshot, columnas y filtro de marcas existentes |
| ventas/NC_DFM_YYYY_MM_DD.xlsx | notas_credito_raw | Append histórico por clave/ETag, metadatos y número de fila de origen |

Después de las cuatro cargas se llama al `refreshVehiculoCanonicoV01` existente.
No se ejecutan publicadores de tableros, builds, despliegues, Actions ni P1/P2/P3 remotos.

## Reutilización

Los cuatro importadores, `vehicle-source-cleaning`, `sync-vehiculos-rvm` y el parser
se adaptaron del proceso `refresh_sales_sources_v01` de `cidef-data-loader`.
Se conservaron filtros, puntuación de deduplicación, fechas, reglas NC y SQL RVM.
`xlsx@^0.18.5` es la misma dependencia del proceso de referencia y permite mantener
su parser, formatos y detección de cabeceras sin crear otro parser Excel.
Los cargadores aislados anteriores mantienen sus destinos y protecciones.

La adaptación cambia el acceso a archivos y DB. La publicación de snapshots RAW
conserva la identidad de las tablas productivas mediante DELETE/INSERT transaccional,
sin DROP/RENAME del destino, manteniendo índices, permisos y vistas dependientes.
Se exige que las cuatro tablas RAW y los maestros/canónico existentes estén instalados;
un esquema incompatible aborta y revierte el día. Se bloquean snapshots de vehículos
vacíos después de la limpieza y snapshots vacíos de ventas/notas de venta.

## Atomicidad, repetición y trazabilidad

- Se verifican las cuatro claves del día antes de iniciar la transacción; cada descarga
  usa `If-Match` con el ETag observado. Si falta/cambia un archivo, el día no se publica.
- Una transacción por día incluye cuatro RAW, ciclo RVM, canónico y registro de éxito.
  El canónico recibe el mismo ejecutor transaccional en todos sus helpers; su entrada
  de escritura sin ejecutor explícito continúa bloqueada.
- El bloqueo asesor compartido `cidef_ventas_raw_neon_azure_sync` impide solaparse con
  otra ejecución de este proceso y con la sincronización Azure heredada que lo respeta.
  Los bloqueos de tablas también coordinan escritores durante cada transacción.
- Al primer uso autorizado se crea `public.sales_refresh_runs` en la propia transacción.
  Guarda fecha, firma SHA-256 de las cuatro claves/ETags/tamaños, UUID, resultados,
  fuentes y cambios por VIN con estado canónico anterior/posterior. Incluye los VIN
  que desaparecen del snapshot actual; no se pierde su estado anterior registrado.
  Los Excel diarios de Blob siguen siendo la evidencia histórica RAW; NC conserva
  todas sus versiones cargadas. No se crean copias históricas completas de las RAW.
- Repetir una fecha con la misma firma devuelve `ALREADY_LOADED` sin importar ni
  recalcular el canónico. Las notas de crédito además conservan su idempotencia
  original por `source_key`/`source_etag`.
- Una fuente corregida del último día registrado puede reprocesarse. Si pertenece
  a una fecha anterior, se bloquea para evitar sustituir el estado actual por uno
  histórico: la corrección/reconstrucción histórica queda fuera de esta entrada.
- La primera fecha no se infiere de las tablas preexistentes: el operador indica
  qué días están pendientes. A partir de la primera ejecución, el registro evita
  retroceder respecto de fechas ya completadas por esta entrada.
- Si falla un día, se revierte ese día, no se ejecutan los siguientes y los anteriores
  completados permanecen. Repetir el intervalo omite los días ya completados.
- La CLI emite JSON por día y termina con código distinto de cero ante un fallo.
  El código de error y la fecha se registran sin imprimir secretos del proveedor.

## Validación de esta implementación

`node --test test/sales-source-refresh.test.js` usa datos ficticios y dobles locales:
fechas, selección exacta/ETag, parser NC, secuencia, repetición, bloqueo, fallos de
carga/canónico, rollback y propagación del ejecutor al canónico.

Se comprobó además el SQL de los cuatro importadores con Excel sintéticos en un
PostgreSQL local en memoria: limpieza/deduplicación, ciclo RVM consolidado,
historial NC, cambios VIN, repetición, conservación de índices y rollback diario.
En esa comprobación SQL se sustituyó la actualización canónica por un doble local;
no constituye certificación ni validación de datos productivos.

No se ejecutaron cargas reales, conexiones productivas, jobs, Actions ni despliegues.
