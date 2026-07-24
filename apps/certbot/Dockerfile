# helix-certbot — wildcard TLS automation (ACME DNS-01 over Azure DNS).
#
# Runs as a *scheduled Azure Container Apps Job* — NOT an app and NOT a sidecar.
# TLS terminates at the ACA ingress, so the cert must live on the Container Apps
# environment, not inside an app container; and keeping cert automation out of
# the app keeps the app cloud-agnostic (see ADR-0029's portability reasoning).
#
# It obtains/renews the `*.<appsDomain>` (+ apex) wildcard certificate from
# Let's Encrypt using the DNS-01 challenge — `certbot-dns-azure` writes the
# `_acme-challenge` TXT via the job's managed identity (needs DNS Zone
# Contributor on the zone) — then uploads the cert to the ACA environment and
# (re)binds the edge's wildcard custom domain (needs Container Apps mgmt rights).
#
# No official certbot image carries the Azure DNS plugin, and we also need the
# az CLI for the upload/bind, so we layer both onto the azure-cli image.
# Build context is the repo root (matches the other images' CI build).
FROM mcr.microsoft.com/azure-cli:2.64.0

# certbot + the third-party Azure DNS plugin (terrycain/certbot-dns-azure).
RUN pip install --no-cache-dir "certbot>=3,<4" "certbot-dns-azure>=2,<3"

COPY apps/certbot/issue-and-bind.sh /usr/local/bin/issue-and-bind.sh
RUN chmod +x /usr/local/bin/issue-and-bind.sh

ENTRYPOINT ["/usr/local/bin/issue-and-bind.sh"]
