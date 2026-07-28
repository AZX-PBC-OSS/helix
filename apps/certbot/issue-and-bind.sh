#!/usr/bin/env bash
# issue-and-bind.sh — obtain/renew the wildcard cert via ACME DNS-01 and bind it
# to the custom domains of every externally-reachable plane on Azure Container Apps.
#
# Idempotent, and NOT by relying on certbot's own renewal window: this container
# is ephemeral (nothing mounts /etc/letsencrypt), so certbot always believes it
# has no cert and would re-issue on every scheduled run. The renewal clock is
# therefore the expiry of the cert already in the ACA environment store — the
# durable state we do have (ADR-0029 put the cert there rather than Key Vault).
# See "the renewal decision" below. Binding runs every time regardless: it is
# cheap, idempotent, and self-heals bindings stripped by a template re-apply.
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
# Re-issue only inside this many days of expiry. LE certs are ~90 days, so 30
# leaves three weeks of daily retries before anything is at risk. Remaining life
# is floored to whole days and the skip needs STRICTLY more than this, so with 30
# the first renewal attempt lands in the 31st-day-remaining window — i.e. it errs
# a day early, never a day late.
RENEW_BEFORE_DAYS="${RENEW_BEFORE_DAYS:-30}"

# --- authenticate as the managed identity -----------------------------------
# First, not last: the renewal decision below reads the ACA environment cert
# store, and the bind steps need it too. certbot's DNS-01 plugin authenticates
# separately via dns_azure_msi_client_id, so it does not depend on this.
echo "== az login (managed identity ${MI_CLIENT_ID}) =="
az login --identity --client-id "${MI_CLIENT_ID}" >/dev/null
az account set --subscription "${AZURE_SUBSCRIPTION_ID}"

# --- the renewal decision ---------------------------------------------------
# Ask the environment cert store how much life the current cert has left, and
# skip the CA entirely when there is plenty. Without this the job re-issues on
# every run, which outspends Let's Encrypt's duplicate-certificate limit (5 per
# identical identifier set per 7 days, refilling 1 per 34h): a daily schedule
# drains the budget in ~2.5 weeks and then fails a third of its runs — including
# any emergency re-issue you actually need.
#
# FAILS OPEN by design: a missing cert, an unparseable expiry, or a failed query
# all fall through to issuing. Skipping is only ever chosen on positive evidence
# of a healthy cert, so the worst case is a wasted issuance, never a silent expiry.
CERT_JSON="$(az containerapp env certificate list -g "${RG}" --name "${ACA_ENV}" \
  --query "[?name=='${CERT_NAME}'] | [0].{id:id,exp:properties.expirationDate}" \
  -o json 2>/dev/null || true)"

EXISTING_ID=""
DAYS_LEFT=""
if [ -n "${CERT_JSON}" ] && [ "${CERT_JSON}" != "null" ]; then
  EXISTING_ID="$(printf '%s' "${CERT_JSON}" | python3 -c '
import json, sys
try:
    print((json.load(sys.stdin) or {}).get("id") or "")
except Exception:
    print("")' 2>/dev/null || true)"
  DAYS_LEFT="$(printf '%s' "${CERT_JSON}" | python3 -c '
import json, sys, datetime
UTC = datetime.timezone.utc
try:
    raw = ((json.load(sys.stdin) or {}).get("exp") or "").rstrip("Z").split("+")[0]
    parsed = None
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            # ACA reports expiry without a zone; it is UTC.
            parsed = datetime.datetime.strptime(raw, fmt).replace(tzinfo=UTC)
            break
        except ValueError:
            pass
    print(int((parsed - datetime.datetime.now(UTC)).total_seconds() // 86400) if parsed else "")
except Exception:
    print("")' 2>/dev/null || true)"
fi

NEEDS_ISSUE=1
case "${DAYS_LEFT}" in
  '' | *[!0-9-]*) : ;;  # absent or non-numeric -> fail open, issue
  *)
    if [ -n "${EXISTING_ID}" ] && [ "${DAYS_LEFT}" -gt "${RENEW_BEFORE_DAYS}" ]; then
      NEEDS_ISSUE=0
    fi
    ;;
esac

if [ "${NEEDS_ISSUE}" -eq 0 ]; then
  echo "== ${CERT_NAME} has ${DAYS_LEFT}d left (> ${RENEW_BEFORE_DAYS}d): skipping issuance, re-binding only =="
  CERT_ID="${EXISTING_ID}"
else
  echo "== ${CERT_NAME}: ${DAYS_LEFT:-no cert in store} — issuing =="

  # --- DNS-01 via the job's managed identity (certbot-dns-azure) ------------
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

  # --- package as PFX (what ACA env certificate upload wants) ---------------
  PFX_PASS="$(openssl rand -base64 24)"
  openssl pkcs12 -export -out /tmp/cert.pfx \
    -inkey "${LIVE}/privkey.pem" -in "${LIVE}/fullchain.pem" \
    -passout "pass:${PFX_PASS}"

  # --- upload to the ACA environment cert store -----------------------------
  # Deliberately NOT Key Vault: ACA resolves an env/KV cert on the control plane,
  # which cannot reach a private vault (same wall as ADR-0029's secrets). The env
  # cert store keeps the cert on the platform, reachable at bind time.
  echo "== upload cert to ACA env ${ACA_ENV} =="
  CERT_ID="$(az containerapp env certificate upload \
    -g "${RG}" --name "${ACA_ENV}" \
    --certificate-file /tmp/cert.pfx --certificate-name "${CERT_NAME}" \
    --password "${PFX_PASS}" --query id -o tsv)"
fi
echo "cert id: ${CERT_ID}"

# --- bind the wildcard custom domain on the edge ----------------------------
# The asuid.<APPS_DOMAIN> TXT (domainVerificationId) must already exist in the
# zone (written by dns.bicep) for the bind to validate ownership.
echo "== bind *.${APPS_DOMAIN} on ${EDGE_APP} =="
az containerapp hostname add -g "${RG}" -n "${EDGE_APP}" \
  --hostname "*.${APPS_DOMAIN}" 2>/dev/null || true
az containerapp hostname bind -g "${RG}" -n "${EDGE_APP}" \
  --hostname "*.${APPS_DOMAIN}" --environment "${ACA_ENV}" --certificate "${CERT_ID}"

# --- optional: specific hostnames on their own apps ---------------------------
# The wildcard cert covers every <label>.<APPS_DOMAIN>, but a custom-domain
# BINDING is per container app: any plane with its own external ingress needs its
# own bind or it serves the ACA default cert. Envoy routes a specific hostname to
# its app ahead of the edge's wildcard. Each needs its own asuid.<label>
# ownership TXT (the wildcard used asuid at the apex) — the job's DNS Zone
# Contributor role writes it. All reuse ${CERT_ID}; ACA updates the cert in place
# on renewal, so the bindings track it.
bind_host() {
  local app="$1" host="$2" vid
  echo "== bind ${host} on ${app} =="
  vid="$(az containerapp show -g "${RG}" -n "${app}" --query "properties.customDomainVerificationId" -o tsv)"
  az network dns record-set txt add-record -g "${DNS_ZONE_RG}" -z "${APPS_DOMAIN}" \
    -n "asuid.${host%%.*}" --value "${vid}" >/dev/null 2>&1 || true
  az containerapp hostname add -g "${RG}" -n "${app}" --hostname "${host}" 2>/dev/null || true
  az containerapp hostname bind -g "${RG}" -n "${app}" \
    --hostname "${host}" --environment "${ACA_ENV}" --certificate "${CERT_ID}"
}

# The control-plane portal on portal.<APPS_DOMAIN> (portalExternal).
if [ -n "${PORTAL_APP:-}" ] && [ -n "${PORTAL_HOSTNAME:-}" ]; then
  bind_host "${PORTAL_APP}" "${PORTAL_HOSTNAME}"
fi

# The opt-in dev-gateway on dev-api.<APPS_DOMAIN> (deployDevGateway,
# docs/features/dev-mode.md). It exists to serve cross-origin dev calls from
# cloud IDEs, so an untrusted cert here fails the exact browser requests the
# surface is for — this bind is what makes the dev host usable, not a nicety.
if [ -n "${DEV_GATEWAY_APP:-}" ] && [ -n "${DEV_GATEWAY_HOSTNAME:-}" ]; then
  bind_host "${DEV_GATEWAY_APP}" "${DEV_GATEWAY_HOSTNAME}"
fi

echo "== done: *.${APPS_DOMAIN} bound to ${CERT_NAME} =="
