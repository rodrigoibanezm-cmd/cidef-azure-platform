#!/usr/bin/env bash
set -euo pipefail
RG=rg-cidef-prod
APP=cidef-seguimiento-cierre
SOURCE=cidef-intel-comercial-staging
ACR_NAME=cidefprodacr
ACR="$ACR_NAME.azurecr.io"
test -n "${AZURE_DATABASE_URL:-}" || { echo 'Missing AZURE_DATABASE_URL'; exit 1; }
test -f frontend/public/seguimiento-cierre.html
test -f frontend/package-lock.json
az extension add --name containerapp --upgrade --yes --only-show-errors
CONFIG=$(mktemp)
trap 'rm -f "$CONFIG"' EXIT
az containerapp show -g "$RG" -n "$SOURCE" -o json > "$CONFIG"
ENV_ID=$(az containerapp env show -g "$RG" -n cidef-prod-env --query id -o tsv)
IDENTITY=$(az identity show -g "$RG" -n id-cidef-azure-pg-mcp --query id -o tsv)
test -n "$ENV_ID" && test -n "$IDENTITY"
read -r CPU MEMORY MIN MAX < <(python3 - "$CONFIG" "$ENV_ID" "$IDENTITY" <<'PY'
import json, sys
app=json.load(open(sys.argv[1])); p=app['properties']
assert p['managedEnvironmentId'].lower()==sys.argv[2].lower()
assert sys.argv[3].lower() in [k.lower() for k in app['identity']['userAssignedIdentities']]
assert p['configuration']['ingress']['targetPort']==3000
assert p['configuration']['ingress']['external']
c=p['template']['containers']; assert len(c)==1
r=c[0]['resources']; s=p['template']['scale']
print(r['cpu'],r['memory'],s.get('minReplicas',0),s.get('maxReplicas',10))
PY
)
test -n "$CPU" && test -n "$MEMORY"
SOURCE_IMAGE=$(az containerapp show -g "$RG" -n "$SOURCE" --query properties.template.containers[0].image -o tsv)
EXISTING=$(az containerapp list -g "$RG" --query "[?name=='$APP'].name | [0]" -o tsv)
if [[ -n "$EXISTING" ]]; then
  az containerapp show -g "$RG" -n "$APP" -o json > "$CONFIG"
  python3 - "$CONFIG" "$ENV_ID" "$IDENTITY" <<'PY'
import json, sys
a=json.load(open(sys.argv[1])); p=a['properties']
assert p['managedEnvironmentId'].lower()==sys.argv[2].lower()
assert sys.argv[3].lower() in [k.lower() for k in a['identity']['userAssignedIdentities']]
assert p['configuration']['ingress']['targetPort']==3000
assert len(p['template']['containers'])==1
PY
fi
SHA=$(git -C frontend rev-parse HEAD)
IMAGE="$ACR/$APP:$SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
az acr login -n "$ACR_NAME" --only-show-errors
docker build -f frontend/Dockerfile -t "$IMAGE" frontend
docker push "$IMAGE"
if [[ -n "$EXISTING" ]]; then
  az containerapp secret set -g "$RG" -n "$APP" --secrets "database-url=$AZURE_DATABASE_URL" -o none
  az containerapp update -g "$RG" -n "$APP" --image "$IMAGE" \
    --set-env-vars AZURE_DATABASE_URL=secretref:database-url PROJECTIONS_ENVIRONMENT=staging -o none
else
  az containerapp create -g "$RG" -n "$APP" --environment "$ENV_ID" \
    --image "$IMAGE" --registry-server "$ACR" --registry-identity "$IDENTITY" \
    --user-assigned "$IDENTITY" --ingress external --target-port 3000 \
    --cpu "$CPU" --memory "$MEMORY" --min-replicas "$MIN" --max-replicas "$MAX" \
    --revisions-mode single --secrets "database-url=$AZURE_DATABASE_URL" \
    --env-vars AZURE_DATABASE_URL=secretref:database-url PROJECTIONS_ENVIRONMENT=staging -o none
fi
DEPLOYED=$(az containerapp show -g "$RG" -n "$APP" --query properties.template.containers[0].image -o tsv)
test "$DEPLOYED" = "$IMAGE"
FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
test -n "$FQDN"
URL="https://$FQDN"
echo "Application: $URL/seguimiento-cierre.html" >> "$GITHUB_STEP_SUMMARY"
echo "Source: rodrigoibanezm-cmd/cidef-seguimiento-cierre@$SHA" >> "$GITHUB_STEP_SUMMARY"
echo "Image: $IMAGE" >> "$GITHUB_STEP_SUMMARY"
curl --fail --location --retry 10 --retry-delay 5 --max-time 30 \
  "$URL/seguimiento-cierre.html" -o /tmp/seguimiento-cierre.html
cmp frontend/public/seguimiento-cierre.html /tmp/seguimiento-cierre.html
curl --fail --retry 5 --retry-delay 5 --max-time 30 "$URL/api/health/database"
curl --fail --retry 5 --retry-delay 5 --max-time 30 \
  "$URL/api/weekly-projections/sucursales" -o /dev/null
test "$SOURCE_IMAGE" = "$(az containerapp show -g "$RG" -n "$SOURCE" --query properties.template.containers[0].image -o tsv)"
echo 'Verified page, database connectivity and store catalog. No business refresh or SQL writes.' >> "$GITHUB_STEP_SUMMARY"
