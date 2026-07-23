using './main.bicep'

// Non-secret configuration. Edit the resource names to globally-unique values
// before first deploy (ACR / storage / Key Vault / Postgres names are global).
param namePrefix = 'helix-prod'
param location = 'eastus2'
param registryName = 'helixprodacr'
param storageAccountName = 'helixprodbundles'
param platformVaultName = 'helix-prod-kvp'
param connectionsVaultName = 'helix-prod-kvc'
param postgresServerName = 'helix-prod-pg'
param appsDomain = 'azx.helix.azxlabs.io'

// Entra / OIDC. Fill in once the app registrations exist (operator step, or the
// infra/entra Bicep). portalOidcAudience is the bare helix-portal client-id GUID
// (v2 tokens); portalAdminGroupId is the App Role value (e.g. "platform-admin").
param edgeOidcClientId = readEnvironmentVariable('HELIX_EDGE_OIDC_CLIENT_ID', '')
param portalOidcAudience = readEnvironmentVariable('HELIX_PORTAL_OIDC_AUDIENCE', '')
param portalAdminGroupId = readEnvironmentVariable('HELIX_PORTAL_ADMIN_GROUP_ID', '')
param azxCliClientId = readEnvironmentVariable('HELIX_AZX_CLI_CLIENT_ID', '')
param azxWebClientId = readEnvironmentVariable('HELIX_AZX_WEB_CLIENT_ID', '')

// Phase gate. Leave false for the first apply (infra + empty ACR), flip to true
// after the three images are pushed.
param deployApps = false
param imageTag = readEnvironmentVariable('HELIX_IMAGE_TAG', 'latest')

// Opt-in dev-gateway (docs/features/dev-mode.md). Off by default; flip to true
// (with deployApps) to stand up dev-api.<appsDomain>. Needs devDbPassword + the
// helix_dev role (README step 4) and the pre-deploy riders in the feature doc.
param deployDevGateway = false

// Fastify trustProxy for the edge — the ACA Envoy ingress hop count. "1" is the
// usual single-hop value; VERIFY against the live ingress (issue #13).
param edgeTrustProxy = readEnvironmentVariable('HELIX_EDGE_TRUST_PROXY', '1')

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
