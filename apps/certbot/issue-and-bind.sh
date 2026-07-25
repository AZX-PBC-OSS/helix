#!/usr/bin/env bash
# issue-and-bind.sh — obtain/renew the wildcard cert via ACME DNS-01 and bind it
# to the edge's wildcard custom domain on Azure Container Apps.
#
# Idempotent: safe to run on a schedule. certbot only talks to the CA when the
# cert is missing or within its renewal window; the upload/bind steps are
# no-ops when nothing changed (ACA dedupes an identical cert by thumbprint).
#
# All inputs are env vars (injected by the ACA Job). Auth is the job's
# user-assigned managed identity — no secrets in the image or the env.
set -euo pipefail

: "${APPS_DOMAIN:?}"            # e.g. franklin.helix.azxlabs.io
: "${ACME_EMAIL:?}"            # registration/expiry-notice email
: "${AZURE_SUBSCRIPTION_ID:?}"
: "${DNS_ZONE_RG:?}"           # RG holding the public DNS zone (== APPS_DOMAIN)
: "${MI_CLIENT_ID:?}"         # client id of the job's user-assigned identity
: "${RG:?}"                    # RG holding the ACA env + edge app
: "${ACA_ENV:?}"              # managed environment name
: "${EDGE_APP:?}"             # edge container app name
# Default to the LE STAGING endpoint (untrusted cert, generous rate limits).
# Flip HELIX_ACME_SERVER to the prod directory once the flow is validated.
ACME_SERVER="${HELIX_ACME_SERVER:-https://acme-staging-v02.api.letsencrypt.org/directory}"
CERT_NAME="${CERT_NAME:-wildcard-${APPS_DOMAIN//./-}}"

# --- DNS-01 via the job's managed identity (certbot-dns-azure) --------------
cat > /tmp/azure.ini <<EOF
dns_azure_msi_client_id = ${MI_CLIENT_ID}
dns_azure_zone1 = ${APPS_DOMAIN}:/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${DNS_ZONE_RG}/providers/Microsoft.Network/dnszones/${APPS_DOMAIN}
EOF
chmod 600 /tmp/azure.ini

echo "== certbot certonly *.${APPS_DOMAIN} (+ apex) via ${ACME_SERVER} =="
certbot certonly \
  --non-interactive --agree-tos --email "${ACME_EMAIL}" \
  --server "${ACME_SERVER}" \
  --authenticator dns-azure \
  --dns-azure-credentials /tmp/azure.ini \
  --dns-azure-propagation-seconds 30 \
  --cert-name "${CERT_NAME}" \
  -d "*.${APPS_DOMAIN}" -d "${APPS_DOMAIN}"

LIVE="/etc/letsencrypt/live/${CERT_NAME}"

# --- package as PFX (what ACA env certificate upload wants) -----------------
PFX_PASS="$(openssl rand -base64 24)"
openssl pkcs12 -export -out /tmp/cert.pfx \
  -inkey "${LIVE}/privkey.pem" -in "${LIVE}/fullchain.pem" \
  -passout "pass:${PFX_PASS}"

# --- authenticate as the managed identity -----------------------------------
echo "== az login (managed identity ${MI_CLIENT_ID}) =="
az login --identity --client-id "${MI_CLIENT_ID}" >/dev/null
az account set --subscription "${AZURE_SUBSCRIPTION_ID}"

# --- upload to the ACA environment cert store -------------------------------
# Deliberately NOT Key Vault: ACA resolves an env/KV cert on the control plane,
# which cannot reach a private vault (same wall as ADR-0029's secrets). The env
# cert store keeps the cert on the platform, reachable at bind time.
echo "== upload cert to ACA env ${ACA_ENV} =="
CERT_ID="$(az containerapp env certificate upload \
  -g "${RG}" --name "${ACA_ENV}" \
  --certificate-file /tmp/cert.pfx --certificate-name "${CERT_NAME}" \
  --password "${PFX_PASS}" --query id -o tsv)"
echo "cert id: ${CERT_ID}"

# --- bind the wildcard custom domain on the edge ----------------------------
# The asuid.<APPS_DOMAIN> TXT (domainVerificationId) must already exist in the
# zone (written by dns.bicep) for the bind to validate ownership.
echo "== bind *.${APPS_DOMAIN} on ${EDGE_APP} =="
az containerapp hostname add -g "${RG}" -n "${EDGE_APP}" \
  --hostname "*.${APPS_DOMAIN}" 2>/dev/null || true
az containerapp hostname bind -g "${RG}" -n "${EDGE_APP}" \
  --hostname "*.${APPS_DOMAIN}" --environment "${ACA_ENV}" --certificate "${CERT_ID}"

echo "== done: *.${APPS_DOMAIN} bound to ${CERT_NAME} =="
