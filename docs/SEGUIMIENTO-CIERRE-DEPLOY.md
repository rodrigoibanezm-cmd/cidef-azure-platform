# Seguimiento de cierre: despliegue trasladado

El workflow de despliegue está exclusivamente en `rodrigoibanezm-cmd/cidef-seguimiento-cierre`:
`.github/workflows/deploy-azure.yml`, environment `Production`.

Se retiraron de esta plataforma el workflow y script preparados anteriormente.
No se utiliza CIDEF_SOURCE_REPO_TOKEN ni checkout entre repositorios.
La documentación vigente es `cidef-seguimiento-cierre/docs/DEPLOYMENT.md`.
No se modificaron servicios desplegados ni datos al retirar estos archivos.
