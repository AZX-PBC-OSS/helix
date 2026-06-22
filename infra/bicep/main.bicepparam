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
param appsDomain = 'azx-labs.com'

// Entra / OIDC. Fill in once the app registration exists (operator step).
param edgeOidcClientId = readEnvironmentVariable('HELIX_EDGE_OIDC_CLIENT_ID', '')
param portalOidcAudience = readEnvironmentVariable('HELIX_PORTAL_OIDC_AUDIENCE', '')
param portalAdminGroupId = readEnvironmentVariable('HELIX_PORTAL_ADMIN_GROUP_ID', '')

// Phase gate. Leave false for the first apply (infra + empty ACR), flip to true
// after the three images are pushed.
param deployApps = false
param imageTag = readEnvironmentVariable('HELIX_IMAGE_TAG', 'latest')

// Secrets — sourced from environment variables, never committed. Generate the
// symmetric ones with `openssl rand -base64 48`.
param postgresAdminPassword = readEnvironmentVariable('HELIX_PG_ADMIN_PASSWORD', '')
param edgeDbPassword = readEnvironmentVariable('HELIX_EDGE_DB_PASSWORD', '')
param egressDbPassword = readEnvironmentVariable('HELIX_EGRESS_DB_PASSWORD', '')
param edgeAuthSecret = readEnvironmentVariable('HELIX_EDGE_AUTH_SECRET', '')
param portalSecret = readEnvironmentVariable('HELIX_PORTAL_SECRET', '')
param instructionSecret = readEnvironmentVariable('HELIX_INSTRUCTION_SECRET', '')
param edgeOidcClientSecret = readEnvironmentVariable('HELIX_EDGE_OIDC_CLIENT_SECRET', '')
