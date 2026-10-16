# P1 SALES — Azure

La herramienta MCP `ventas_monthly_actual_v01` usa el motor y el contrato originales del repositorio `cidef-data-loader`.

Input requerido:

```json
{
  "target_month": "YYYY-MM",
  "cutoff_month": "YYYY-MM"
}
```

La salida conserva `engine`, `version`, `status`, `inputs`, `policy`, `actual`, `coverage`, `validation` y `warnings`.

El proceso usa exclusivamente `AZURE_DATABASE_URL`. El chequeo del workflow calcula septiembre de 2026 con corte septiembre y exige `status=ok`, un total positivo y todas las validaciones temporales aprobadas antes del despliegue.
