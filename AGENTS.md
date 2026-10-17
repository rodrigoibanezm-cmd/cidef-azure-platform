# Instrucciones permanentes — CIDEF Azure

Antes de trabajar, leer `docs/PROJECT-CONTEXT.md` y los archivos relevantes del repositorio. Si una instrucción puntual contradice este contexto, explicar la contradicción antes de modificar producción.

## Objetivo definitivo
Migrar la operación de CIDEF desde Vercel + Neon hacia una plataforma **única de producción en Azure**: PostgreSQL Azure, Azure Blob, Azure Container Apps, API/MCP y fronts. GitHub sigue siendo el repositorio y mecanismo de CI/CD. No diseñar integraciones permanentes con Neon ni fallbacks a sus variables de entorno.

## Repositorios y aislamiento
- `rodrigoibanezm-cmd/cidef-data-loader`: sistema **legacy** actualmente operativo en Vercel/Neon; no modificarlo ni desactivarlo desde este proyecto. Sirve para copiar lógica probada y comparar resultados mientras dure la transición.
- `rodrigoibanezm-cmd/cidef-azure-platform`: backend de producción objetivo: cargas, RAW, maestros, P1, P2, APIs, MCP y despliegues Azure.
- `rodrigoibanezm-cmd/cidef-inteligencia-comercial`: front mensual. Su hosting objetivo es Azure, y sus indicadores vivos deben venir de los motores en `cidef-azure-platform`.

## Reglas de trabajo
- Reutilizar / clonar lo que ya funciona en legacy; cambiar solo adaptadores de infraestructura y SQL cuando sea necesario. No reescribir reglas comerciales certificadas.
- En Azure usar `AZURE_DATABASE_URL` para ejecución; no permitir `DATABASE_URL`, `POSTGRES_URL` o fallback a Neon en runtime.
- Fuentes originales -> Azure Blob -> loader -> RAW/maestros/canonicalización en Azure PostgreSQL -> P1/P2 -> API -> front. Los CSV alimentan loaders, **no** P1 directamente.
- Neon puede usarse **solo como referencia temporal de paridad**, nunca como base de producción Azure ni carga regular de datos. No copiar tablas desde Neon como ingesta productiva.
- No truncar ni renumerar maestros ni sobrescribir históricos; conservar IDs y vigencias.
- Trabajar en `main` salvo instrucción contraria; no crear ramas ni infraestructura sin solicitud. Pruebas puntuales, evitar suites innecesarias.
- Informar exactamente qué se hizo, qué se verificó y qué quedó bloqueado. Un workflow verde no reemplaza una comprobación semántica.

## Front «Cómo vamos»
- Vista **viva**: al abrirla, obtener los resultados más recientes certificados de P1/P2 Azure. Nunca cifras, variaciones o comentarios dependientes de datos hardcodeados.
- Las seis cards de Compañía: Ventas, Cotizaciones, Precurse, UFIs, RVM inscripciones, Participación RVM. Cada una: total Compañía y apertura FOTON / DONGFENG, series y corte de fuente.
- P1 certifica hechos; P2 transforma/compara/certifica cálculos derivados. Si no existe contrato para una métrica, no inventar una equivalencia.
- Precurse **no** es necesariamente FORUM APPLICATIONS. UFIS son unidades financiadas, no operaciones CURSES. RVM conserva etiquetas de marca originales; cualquier agrupación comercial requiere identidad certificada.
- La API servidor del front debe autenticarse con Azure sin exponer credenciales al navegador; evitar respuestas obsoletas.
- `Cierre mensual` es una fotografía histórica congelada y separada. No modificarla como parte de «Cómo vamos».
- Dejar la lectura ejecutiva dinámica para una etapa posterior, después de los indicadores.

Más estado técnico y decisiones: `docs/PROJECT-CONTEXT.md`.