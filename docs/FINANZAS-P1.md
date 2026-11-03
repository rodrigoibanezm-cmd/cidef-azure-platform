# Finanzas dentro de P1 SALES

- Fuente: tablas existentes `finanzas_ventas` y `finanzas_cierre_archivos` en Azure PostgreSQL.
- Un período con movimientos de cierre importados reemplaza SALES únicamente en ese período.
- Sin cierre, se conserva el reconocimiento SALES existente.
- Cada movimiento mantiene su cantidad: factura +1; nota de crédito -1.
- No se aplica LAST por VIN a Finanzas. Una NC de otro período no elimina una factura histórica.
- P1 conserva VIN_SALES y los contratos de observación; v0.14 explicita la suma de cantidades.
- FETCH añade `quantity`; las filas SALES mantienen cantidad 1.
- Metadatos: coincidencia exacta VIN + factura de origen y resolutores existentes. En NC se usa `factura` como referencia.
- Sin coincidencia, solo se reutiliza la identidad canónica existente por VIN. No se asignan canales por sucursal contable, RUT o similitud.
- DFM y DFLM corresponden a Dongfeng en esta fuente contable; FOTON se conserva. No cambia la identidad RVM.
- P2 conserva algoritmos y umbrales. Solo se admite el contrato de cantidades v0.14 y valores netos negativos; el clasificador existente no considera actividad positiva a un saldo no positivo.
- P3 no cambia. El cierre y su SHA se incorporan al linaje P1.
- Los snapshots históricos del frontend no se modifican.

## Comprobaciones realizadas sin despliegue

`node --test test/finanzas-p1.test.js`

Dos comprobaciones con fixtures: octubre conserva movimientos repetidos, NC, cortes e identidades no resueltas; septiembre produce los mismos hechos y evidencia con o sin un cierre posterior de Finanzas.
Se ejecutaron además las pruebas existentes de desempeño SALES/STORE por la adaptación del contrato P2: correctas.

No se ejecutó el adaptador contra Azure PostgreSQL desde este entorno: no hay `AZURE_DATABASE_URL` local. El MCP desplegado sigue en v0.13 y no carga este código.
La referencia real de octubre sigue siendo 965 facturas - 55 NC = 910 unidades; no se declara como resultado funcional de v0.14.
La consulta MCP de septiembre de esta tarea devolvió 1033; no se reescribió el snapshot histórico conservado de 1034.

No se ejecutaron despliegues, Actions, SQL de escritura, cambios en `ventas_raw`, tablas nuevas ni infraestructura.
