# Agente manual de Cierre Mensual

`cidef-monthly-close` usa OpenAI Agents SDK para Python, aislado en
`monthly_close_agent/`. No cambia P1, P2, P3 ni instala servicios.
El modelo decide las consultas y recibe sus resultados mediante el SDK.

## Ejecución

Desde la raíz del repositorio, con Python 3.10 o superior:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r monthly_close_agent/requirements.txt
export OPENAI_API_KEY='CLAVE_DE_TU_PROYECTO_OPENAI'
export OPENAI_MODEL='ID_DEL_MODELO_HABILITADO_EN_TU_CUENTA'
export MCP_URL='https://cidef-motor-test-azure.calmforest-1c67ab46.chilecentral.azurecontainerapps.io/api/mcp'
python -m monthly_close_agent 2026-10
```

En PowerShell: activar con `.venv\Scripts\Activate.ps1` y asignar variables
con `$env:NOMBRE='valor'`. No guardar claves en el repositorio.
La sesión de ChatGPT no proporciona automáticamente una clave de API al proceso.
El modelo debe admitir Responses API y llamadas a herramientas; cada ejecución
consume la API de OpenAI según el modelo y las consultas utilizadas.

Se reutiliza `MCP_URL`, la convención de los validadores existentes, y el mismo
endpoint documentado en `lib/forum-snapshot/mcp.js`. Este MCP contiene P1/P2/P3
y actualmente opera sin bearer/OAuth, como indica `MOTOR-TEST-AZURE-STATE.md`.
No se usa el servicio PostgreSQL `mcp/server.js`, ni conexión directa a la base.

Opciones: `--model ID`, `--max-turns 40`, `--output-dir RUTA`.
El límite de turnos acota el bucle, no garantiza un cierre completo ni un costo fijo.
No hay interfaz web, persistencia conversacional, cron ni despliegue.

## Resultados y controles

Cada ejecución crea una carpeta distinta en `monthly-close-reports/`:

- `report.md`: borrador ejecutivo con período, modelo, run_id y evidencia.
- `trace.json`: respuesta original de P3 con herramientas, entradas y resultados.

La carpeta se ignora en Git: la traza puede contener información comercial.
El cliente permite solo herramientas certificadas seleccionadas y fuerza el mismo
run_id en cada llamada. No expone SQL, RAW ni herramientas de escritura. Las
consultas sí generan los registros P3 habituales de los motores existentes.
No se exporta el tracing del SDK: la trazabilidad comercial permanece en P3.

El informe debe citar evidence_id, cortes y unidades P2, y declarar faltantes.
No hay un validador semántico automático de cada frase: requiere revisión humana.
Si no existe evidencia P1 certificada en la traza, se conserva `trace.json` y no
se publica `report.md`. Fallos de conexión/API o límite de turnos terminan con
código distinto de cero; no se fabrica un informe alternativo.

Finanzas se utiliza solo si el P1 desplegado ya la incorpora; este agente no
despliega el adaptador ni sustituye la autoridad de SALES. P3 permite consultar
un run conocido, no descubrir libremente todo el historial de cierres.

## Validación

```bash
python -m unittest discover -s test -p 'test_monthly_close_agent*.py'
```

Las pruebas usan el SDK instalado y respuestas simuladas, sin API ni base.
La ejecución real necesita las variables anteriores y acceso de red al MCP/OpenAI.

Validación del 2 de noviembre de 2026: siete pruebas aprobadas, incluida una
ejecución del bucle real del SDK con modelo y transporte simulados. El intento
manual de octubre se detuvo por falta de `OPENAI_API_KEY`, `OPENAI_MODEL` y
`MCP_URL` en este entorno. Una prueba separada contra el endpoint existente
agotó 25 segundos; no confirma disponibilidad ni falla del servicio en Azure.
No se generó un informe comercial real ni se realizó ningún despliegue.

Referencias oficiales:
- https://developers.openai.com/api/docs/guides/agents/quickstart?lang=python
- https://developers.openai.com/api/docs/guides/agents/integrations-observability
