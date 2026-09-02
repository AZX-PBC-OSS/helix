using './main.bicep'

// Non-secret configuration. Edit the resource names to globally-unique values
// before first deploy (storage / Key Vault / Postgres names are global).
param namePrefix = 'helix-prod'
param location = 'eastus2'
param storageAccountName = 'helixprodbundles'
param platformVaultName = 'helix-prod-kvp'
param connectionsVaultName = 'helix-prod-kvc'
param postgresServerName = 'helix-prod-pg'
// Postgres compute. Burstable (Standard_B1ms / Standard_B2s) is plenty for light
// or smoketest installs; GeneralPurpose Standard_D2ds_v5 is the default here.
// skuTier must match the SKU family: Burstable | GeneralPurpose | MemoryOptimized.
param postgresSkuName = 'Standard_D2ds_v5'
param postgresSkuTier = 'GeneralPurpose'
param postgresStorageSizeGB = 32
param appsDomain = 'azx.helix.azxlabs.io'

// Entra / OIDC. Fill in once the app registrations exist (operator step, or the
// infra/entra Bicep). portalOidcAudience is the bare helix-portal client-id GUID
// (v2 tokens); portalAdminGroupId is the App Role value (e.g. "platform-admin").
param edgeOidcClientId = readEnvironmentVariable('HELIX_EDGE_OIDC_CLIENT_ID', '')
param portalOidcAudience = readEnvironmentVariable('HELIX_PORTAL_OIDC_AUDIENCE', '')
param portalAdminGroupId = readEnvironmentVariable('HELIX_PORTAL_ADMIN_GROUP_ID', '')
param azxCliClientId = readEnvironmentVariable('HELIX_AZX_CLI_CLIENT_ID', '')
param azxWebClientId = readEnvironmentVariable('HELIX_AZX_WEB_CLIENT_ID', '')

// Phase gate. Leave false for the first apply (infra only), flip to true once the
// three images are published to GHCR by CI (see README step 3).
param deployApps = false
// GHCR registry + owner for the CI-built images. Override for a fork.
param imageRegistry = readEnvironmentVariable('HELIX_IMAGE_REGISTRY', 'ghcr.io/azx-pbc-oss')
param imageTag = readEnvironmentVariable('HELIX_IMAGE_TAG', 'latest')

// Opt-in dev-gateway (docs/features/dev-mode.md). Off by default; flip to true
// (with deployApps) to stand up dev-api.<appsDomain>. Needs devDbPassword + the
// helix_dev role (README step 4) and the pre-deploy riders in the feature doc.
param deployDevGateway = false

// Egress firewall (ADR-0001/0005). true = deploy the Azure Firewall that enforces
// the egress-only network zone (the PRIMARY SSRF/egress control). Secure default.
// false skips it to save ~$900/mo but drops that control (a compromised edge can
// then reach the internet; only the egress app-level denylist remains). Data
// services stay private either way. Disable ONLY for dev/smoketest/trusted
// installs — see README "Optional: the egress firewall".
param deployFirewall = true

// Wildcard TLS automation (apps/certbot, ADR-0029). true = deploy the certbot
// scheduled job that issues/renews *.appsDomain via ACME DNS-01 and binds the
// edge wildcard custom domain. Needs acmeEmail (skipped when empty). acmeServer
// defaults to LE staging — flip to the prod directory once validated. Bootstrap:
// trigger the job once after deploy (see README "Wildcard TLS").
param deployCertbot = true
param acmeEmail = readEnvironmentVariable('HELIX_ACME_EMAIL', '')
param acmeServer = readEnvironmentVariable('HELIX_ACME_SERVER', 'https://acme-staging-v02.api.letsencrypt.org/directory')

// Portal access. false = internal ingress (secure default). true = expose the
// control plane at portal.<appsDomain> on the public LB, gated by Entra OIDC
// (per-app authz via ownsApp, ADR-0007). A customer-run install (ADR-0028)
// generally needs this — the portal is the control plane + azx-cli target. See
// README "Portal access".
param portalExternal = false

// App visibility policy. Each sets a MATCHED PAIR of app env vars (edge serves,
// portal authors) — deliberately one knob per mode so the two planes cannot
// disagree. Both default false, matching the app-level default: an install
// serves only Entra-authenticated apps until an operator opts in. Review
// ADR-0010 (anonymous shared writes) before enabling public apps.
param allowPublicApps = false
param allowPasswordApps = false

// Fastify trustProxy for the edge — the ACA Envoy ingress ADDRESS, not a hop
// count (fastify 5.12.1 removed the count form; GHSA-3m5p-2c4r-xxw2). 'auto'
// resolves to the ACA infrastructure subnet the edge runs in, which is the peer
// ingress connects from (issue #13); '' means trust nothing. Set this only if
// something else fronts the edge (CDN, WAF), and verify req.ip against the live
// deployment when you do. A stale HELIX_EDGE_TRUST_PROXY=1 left over from the
// hop-count era is REJECTED by main.bicep — unset it rather than deploying it.
param edgeTrustProxy = readEnvironmentVariable('HELIX_EDGE_TRUST_PROXY', 'auto')

// Secrets — sourced from environment variables, never committed. Generate the
// symmetric ones with `openssl rand -base64 48`.
param postgresAdminPassword = readEnvironmentVariable('HELIX_PG_ADMIN_PASSWORD', '')
param portalDbPassword = readEnvironmentVariable('HELIX_PORTAL_DB_PASSWORD', '')
param edgeDbPassword = readEnvironmentVariable('HELIX_EDGE_DB_PASSWORD', '')
param egressDbPassword = readEnvironmentVariable('HELIX_EGRESS_DB_PASSWORD', '')
// helix_dev runtime role — only consumed when deployDevGateway=true.
param devDbPassword = readEnvironmentVariable('HELIX_DEV_DB_PASSWORD', '')
param edgeAuthSecret = readEnvironmentVariable('HELIX_EDGE_AUTH_SECRET', '')
param portalSecret = readEnvironmentVariable('HELIX_PORTAL_SECRET', '')
param instructionSecret = readEnvironmentVariable('HELIX_INSTRUCTION_SECRET', '')
// Edge cert (private_key_jwt) — the tenant blocks client secrets. PEM or base64 PEM.
param edgeOidcPrivateKey = readEnvironmentVariable('HELIX_EDGE_OIDC_PRIVATE_KEY', '')
param edgeOidcCertificate = readEnvironmentVariable('HELIX_EDGE_OIDC_CERTIFICATE', '')
