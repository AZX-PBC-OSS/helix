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
# certbot and the az CLI have CONFLICTING cryptography/pyOpenSSL pins (a shared
# env breaks certbot's acme: "OpenSSL.crypto has no attribute X509Extension"),
# so each goes in its own venv. Build context is the repo root (matches CI).
FROM python:3.12

# certbot + the Azure DNS plugin, isolated. Two pins the plugin (2.6.x) needs:
#  - pyOpenSSL<24: it pulls josepy 1.x, which uses crypto.X509Req/X509Extension
#    that pyOpenSSL 24+ removed (certbot crashes on import otherwise);
#  - azure-mgmt-dns<9: the plugin calls DnsManagementClient(cred, sub, None,
#    base_url, ...) — positional api_version+base_url that 9.0 dropped.
RUN python -m venv /opt/certbot \
 && /opt/certbot/bin/pip install --no-cache-dir \
      "certbot>=3,<4" "certbot-dns-azure>=2,<3" "pyOpenSSL<24" "azure-mgmt-dns>=8,<9"

# the az CLI, isolated, + the (preview) containerapp extension for cert/hostname.
RUN python -m venv /opt/azcli \
 && /opt/azcli/bin/pip install --no-cache-dir "azure-cli>=2.60" \
 && /opt/azcli/bin/az extension add --name containerapp --yes

# certbot + az on PATH (each resolves to its own venv; openssl is the system one).
ENV PATH="/opt/certbot/bin:/opt/azcli/bin:${PATH}"

COPY apps/certbot/issue-and-bind.sh /usr/local/bin/issue-and-bind.sh
RUN chmod +x /usr/local/bin/issue-and-bind.sh

ENTRYPOINT ["/usr/local/bin/issue-and-bind.sh"]
