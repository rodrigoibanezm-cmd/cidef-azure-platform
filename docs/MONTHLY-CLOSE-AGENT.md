# P4 — Orquestador de investigación comercial

El nombre histórico del paquete monthly_close_agent se conserva únicamente por compatibilidad con el servicio y Dockerfile existentes. P4 no es un agente de cierre mensual. Investiga cualquier pregunta compleja dentro de los contratos disponibles de P1/P2/P3; las consultas descriptivas y transformaciones directas no pasan por SDK.

## Ejecución

Con Python 3.11, instalar monthly_close_agent/requirements.txt y configurar OPENAI_API_KEY, OPENAI_MODEL y MCP_URL. Ejecutar python -m monthly_close_agent seguido de la pregunta compleja entre comillas. El CLI es una entrada manual deliberada. MCP/HTTP requieren route=P4_RESEARCH y research_goal; DIRECT_MOTOR no ejecuta el modelo. No existe un clasificador adicional.

P4 descubre dinámicamente fuentes y capacidades usando data_query, p2_discover, p2_describe, p2_execute y run_trace. Un run_id por pregunta; sin reutilización entre runs. P1 certifica hechos, P2 transformaciones y P3 traza. Evidencia parcial no equivale a certificación global. Los informes son borradores; su exactitud semántica requiere revisión.

## Validación

CI P4: compilación, pruebas acotadas, pip check y Docker build sin despliegue. Action manual validate-p4-research.yml: mcp_only=true no requiere pregunta, período ni API de OpenAI. Para investigación real desmarcar mcp_only e introducir question y research_goal libres; modelo vacío reutiliza Azure. El Action lee configuración existente de cidef-p4 y ejecuta el código del checkout sin modificar Azure; solo imprime metadatos de ejecución. No sube informes ni trazas. Las llamadas de investigación consumen API y generan P3 normal. La prueba integral está pendiente de resolver McpError y verificar ejecución real.
