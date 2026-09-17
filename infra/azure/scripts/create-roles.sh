#!/usr/bin/env bash
# create-roles.sh — create the four least-privilege Postgres runtime roles on a
# fresh install, from inside the VNet.
#
# WHY THIS EXISTS
# The Bicep deploy provisions the server and the `helix` DB, but the runtime
# roles (helix_{portal,edge,egress,dev}) are data-plane, not infrastructure:
# they are created by sql/01-roles.sql, run once as the admin. Postgres is
# private-endpoint-only, so nothing outside the VNet can reach it — not a
# laptop, not a hosted CI runner. A throwaway Container Apps Job in the apps
# environment is inside the VNet, and the `postgres:16` image ships psql.
#
# Run this ONCE per install, AFTER the infra-only apply (deployApps=false) and
# BEFORE the first migration — the migrations' per-table GRANTs are guarded by
# an IF EXISTS (pg_roles …) check, so the roles must exist first. CREATE ROLE
# is not idempotent: a second run fails with "role already exists". That is
# safety, not breakage — to change a role's password later, ALTER ROLE through
# the same throwaway-job shape, don't re-run this.
#
# THE JOB MUST BE DELETED AFTERWARDS — it carries the admin DSN as a readable
# job secret. This script deletes it in a trap, and tells you how to do it by
# hand if that delete fails. It is the ONE time the admin credential is placed
# on a resource: every migration after this runs through the template-declared
# <prefix>-migrate job, which reads the admin password from Key Vault itself.
#
# WHY `az rest` AND NOT `az containerapp job create`
# That command's --args is space-split, so an argument containing spaces (or a
# leading '-') cannot be expressed — and `sh -c "<SQL>"` needs both. Building
# the job as an ARM body also keeps the DSN out of any shell quoting round-trip.
#
# Usage (same env vars the bicepparam reads — source your secrets file first):
#   RG=<rg> PREFIX=<namePrefix> infra/azure/scripts/create-roles.sh

set -euo pipefail

log() { echo "  $*"; }
die() {
  echo "error: $*" >&2
  exit 1
}

for cmd in az python3; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required but not on PATH"
done

missing=()
for name in RG PREFIX HELIX_PG_ADMIN_PASSWORD HELIX_EDGE_DB_PASSWORD \
  HELIX_PORTAL_DB_PASSWORD HELIX_EGRESS_DB_PASSWORD HELIX_DEV_DB_PASSWORD; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
((${#missing[@]} == 0)) || die "missing required environment: ${missing[*]}"

sql_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../sql/01-roles.sql"
[[ -f "$sql_file" ]] || die "roles SQL not found at ${sql_file}"

# Every DB password is interpolated into a DSN URL by the template, and the
# role passwords additionally sit inside SQL literals below. Reject the
# characters that would corrupt either — generate base64url instead:
#   openssl rand -base64 24 | tr '+/' '-_' | tr -d '='
for name in HELIX_PG_ADMIN_PASSWORD HELIX_EDGE_DB_PASSWORD HELIX_PORTAL_DB_PASSWORD \
  HELIX_EGRESS_DB_PASSWORD HELIX_DEV_DB_PASSWORD; do
  if [[ "${!name}" =~ [+/=@:?#\&] ]]; then
    die "${name} contains a URL-reserved character (+ / = @ : ? # &) — use base64url"
  fi
  [[ "${!name}" != *"'"* ]] || die "${name} must not contain a single quote"
done

job="${PREFIX}-roles-$$"

read -r pg fqdn admin < <(az postgres flexible-server list -g "$RG" \
  --query "[0].[name,fullyQualifiedDomainName,administratorLogin] | join(' ', @)" -o tsv)
[[ -n "${pg:-}" ]] || die "no Postgres flexible server found in ${RG}"
env_id=$(az containerapp env show -g "$RG" -n "${PREFIX}-apps-env" --query id -o tsv)
location=$(az group show -n "$RG" --query location -o tsv)
sub=$(az account show --query id -o tsv)

log "server   ${pg} (${fqdn}), admin ${admin}"
log "job      ${job} (deleted when this finishes)"

admin_url="postgresql://${admin}:${HELIX_PG_ADMIN_PASSWORD}@${fqdn}:5432/helix?sslmode=require"
roles_sql_b64=$(base64 -w0 "$sql_file")

# MUST run even on failure: the job holds the admin DSN.
cleanup() {
  if az containerapp job show -g "$RG" -n "$job" --output none 2>/dev/null; then
    if az containerapp job delete -g "$RG" -n "$job" --yes --output none 2>/dev/null; then
      log "deleted ${job}"
    else
      echo "error: FAILED to delete ${job} — it holds the admin DSN. Delete by hand: az containerapp job delete -g ${RG} -n ${job} --yes" >&2
    fi
  fi
}
trap cleanup EXIT

# Passwords and the admin DSN are declared as SECRETS and referenced via
# secretRef, so none appears in the job's readable env or args. The roles SQL
# is not secret — it travels base64'd in a plain env var.
body=$(
  # shellcheck disable=SC2016 # the $VAR refs inside are read by python/the container
  ADMIN_URL="$admin_url" EDGE_PW="$HELIX_EDGE_DB_PASSWORD" \
    PORTAL_PW="$HELIX_PORTAL_DB_PASSWORD" EGRESS_PW="$HELIX_EGRESS_DB_PASSWORD" \
    DEV_PW="$HELIX_DEV_DB_PASSWORD" ROLES_SQL_B64="$roles_sql_b64" \
    ENV_ID="$env_id" LOCATION="$location" \
    python3 -c '
import json, os
print(json.dumps({
  "location": os.environ["LOCATION"],
  "properties": {
    "environmentId": os.environ["ENV_ID"],
    "configuration": {
      "triggerType": "Manual",
      "replicaTimeout": 600,
      "replicaRetryLimit": 0,
      "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1},
      "secrets": [
        {"name": "admin-url", "value": os.environ["ADMIN_URL"]},
        {"name": "edge-pw", "value": os.environ["EDGE_PW"]},
        {"name": "portal-pw", "value": os.environ["PORTAL_PW"]},
        {"name": "egress-pw", "value": os.environ["EGRESS_PW"]},
        {"name": "dev-pw", "value": os.environ["DEV_PW"]},
      ],
    },
    "template": {
      "containers": [{
        "name": "roles",
        "image": "postgres:16",
        "command": ["/bin/sh", "-c"],
        "args": ["echo \"$ROLES_SQL_B64\" | base64 -d > /tmp/roles.sql && "
                 "psql \"$ADMIN_URL\" "
                 "-v edge_password=\"$EDGE_PW\" -v portal_password=\"$PORTAL_PW\" "
                 "-v egress_password=\"$EGRESS_PW\" -v dev_password=\"$DEV_PW\" "
                 "-v ON_ERROR_STOP=1 -f /tmp/roles.sql"],
        "resources": {"cpu": 0.5, "memory": "1Gi"},
        "env": [
          {"name": "ADMIN_URL", "secretRef": "admin-url"},
          {"name": "EDGE_PW", "secretRef": "edge-pw"},
          {"name": "PORTAL_PW", "secretRef": "portal-pw"},
          {"name": "EGRESS_PW", "secretRef": "egress-pw"},
          {"name": "DEV_PW", "secretRef": "dev-pw"},
          {"name": "ROLES_SQL_B64", "value": os.environ["ROLES_SQL_B64"]},
        ],
      }]
    },
  },
}))
'
)
az rest --method PUT \
  --url "https://management.azure.com/subscriptions/${sub}/resourceGroups/${RG}/providers/Microsoft.App/jobs/${job}?api-version=2024-03-01" \
  --body "$body" --output none
log "job created"

# The PUT returns before the job is usable.
state=""
for _ in $(seq 1 30); do
  state=$(az containerapp job show -g "$RG" -n "$job" --query properties.provisioningState -o tsv 2>/dev/null || echo "")
  [[ "$state" == "Succeeded" ]] && break
  [[ "$state" == "Failed" ]] && die "job provisioning failed"
  sleep 5
done
[[ "$state" == "Succeeded" ]] || die "job did not provision in time (last state: ${state:-unknown})"

execution=$(az containerapp job start -g "$RG" -n "$job" --query name -o tsv)
[[ -n "$execution" ]] || die "could not start ${job}"
log "execution ${execution}"

deadline=$(($(date +%s) + 600))
while :; do
  status=$(az containerapp job execution show -g "$RG" -n "$job" \
    --job-execution-name "$execution" --query properties.status -o tsv 2>/dev/null || echo Running)
  case "$status" in
    Succeeded)
      log "roles created — run the first migration next (the <namePrefix>-migrate job)"
      exit 0
      ;;
    Failed | Stopped | Degraded)
      echo "error: execution ${status}. Logs:" >&2
      az containerapp job logs show -g "$RG" -n "$job" --container roles \
        --execution "$execution" --tail 100 >&2 || true
      exit 1
      ;;
  esac
  (($(date +%s) < deadline)) || die "execution did not finish in 600s (last status ${status})"
  sleep 10
done
