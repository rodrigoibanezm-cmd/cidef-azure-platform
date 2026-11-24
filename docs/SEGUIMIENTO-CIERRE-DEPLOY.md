# Seguimiento de cierre · despliegue independiente

Autorización del usuario: 24-nov-2026, crear y desplegar Container App cidef-seguimiento-cierre.

## Recursos

- Fuente privada: rodrigoibanezm-cmd/cidef-seguimiento-cierre, commit inicial 6bcc09b996af0cd8b24db811c8128778cd671233.
- Workflow manual: .github/workflows/deploy-seguimiento-cierre.yml.
- Destino: cidef-seguimiento-cierre, rg-cidef-prod.
- Reutiliza cidef-prod-env, cidefprodacr y la identidad de pull id-cidef-azure-pg-mcp.
- CPU, memoria y escalado se leen de cidef-intel-comercial-staging, sin modificarla.
- AZURE_DATABASE_URL y OIDC se reutilizan del environment Production de esta plataforma.
- PROJECTIONS_ENVIRONMENT=staging conserva los snapshots que usa la pantalla migrada.
- No hay tablas nuevas ni migraciones SQL ni regeneración comercial durante las verificaciones.

## Requisito de acceso al código

El token automático de Actions de esta plataforma no puede leer la nueva repo privada.
Configurar CIDEF_SOURCE_REPO_TOKEN en los secrets de Actions de esta plataforma.
Usar token fine-grained limitado a cidef-seguimiento-cierre, permiso Contents: Read-only.
No publicar el token en commits, logs ni conversaciones. Checkout no persiste credenciales.

## Ejecución

Ejecutar manualmente Deploy Seguimiento Cierre to Azure desde main.
source_ref acepta un commit o rama; inicialmente fija el commit migrado.
El workflow verifica el acceso privado antes de iniciar Azure; si falta el secret, termina sin crear recursos.
Construye/publica imagen y crea o actualiza exclusivamente la app destino.
El resumen devuelve URL e imagen; la verificación compara HTML exacto y consulta salud DB y catálogo.
Un resultado exitoso no certifica actualización ni cálculos comerciales del motor.

## Estado

Preparado y validado sintácticamente. NO ejecutado: falta confirmar el secret privado y disparar el workflow.
No hay Azure CLI autenticado en este entorno y el navegador está sin sesión GitHub.
La suite original tiene 13 fallas heredadas documentadas en la repo de la aplicación.
