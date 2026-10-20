// kv-secrets.bicep — writes the platform config secrets into kv-platform.
//
// Separated from main so the vault name is a module *parameter* (known at start
// of deployment), which a parent-of-secret reference requires, and so the apps
// can depend on this whole module rather than the individual secret resources.
//
// ARM management-plane secret writes bypass the vault's data-plane firewall, so
// these succeed even though kv-platform has publicNetworkAccess disabled.

@description('Platform Key Vault name.')
param vaultName string

@secure()
@description('helix_edge connection string.')
param edgeDatabaseUrl string
@secure()
@description('helix_egress connection string.')
param egressDatabaseUrl string
@secure()
@description('helix_portal (least-privilege runtime role) connection string.')
param portalDatabaseUrl string
@secure()
@description('EDGE_AUTH_SECRET.')
param edgeAuthSecret string
@secure()
@description('PORTAL_SECRET.')
param portalSecret string
@secure()
@description('HELIX_INSTRUCTION_SECRET.')
param instructionSecret string
@secure()
@description('HELIX_INTERNAL_SECRET — shared edge<->portal internal-JWT key (ADR-0003).')
param internalSecret string
@secure()
@description('HELIX_EXCHANGE_SECRET — shared portal<->egress exchange-JWT key (ADR-0003).')
param exchangeSecret string
@secure()
@description('EDGE_OIDC_CLIENT_PRIVATE_KEY (edge cert private key, PEM or base64 PEM).')
param edgeOidcPrivateKey string
@secure()
@description('EDGE_OIDC_CLIENT_CERTIFICATE (edge cert, PEM or base64 PEM).')
param edgeOidcCertificate string
@secure()
@description('EDGE_DEV_DATABASE_URL (helix_dev DSN, dev-gateway). Empty = skip — the surface is opt-in and off unless deployDevGateway is set.')
param edgeDevDatabaseUrl string = ''
@secure()
@description('JOBS_DATABASE_URL (helix_jobs runtime DSN). Empty = skip — written only on a deployJobs=true install. Its reader is the jobs container app, which receives it as an inline container-app secret (not a Key Vault reference — the jobs app has no identity), so the vault copy is the steady-state source for main.bicepparam.')
param jobsDatabaseUrl string = ''
@secure()
@description('JOBS_MIGRATE_DATABASE_URL (helix_jobs_migrate DSN). Empty = skip — written only on a deployJobs=true install; the jobs migration job is its only reader.')
param jobsMigrateDatabaseUrl string = ''
@secure()
@description('JOBS_EDGE_TO_JOBS_SECRET — the `jobs` server\'s edge→jobs signing root. Empty = skip — written only on a deployJobs=true install; the vault copy is the steady-state source main.bicepparam reads back with az.getSecret; no container references it (the consumers receive it as an inline container-app secret).')
param jobsEdgeToJobsRoot string = ''
@secure()
@description('JOBS_JOBS_TO_EDGE_SECRET — the `jobs` server\'s jobs→edge signing root. Empty = skip — written only on a deployJobs=true install; the vault copy is the steady-state source main.bicepparam reads back with az.getSecret; no container references it (the consumers receive it as an inline container-app secret).')
param jobsJobsToEdgeRoot string = ''
@secure()
@description('JOBS_PORTAL_TO_JOBS_SECRET — the `jobs` server\'s portal→jobs signing root. Empty = skip — written only on a deployJobs=true install; the vault copy is the steady-state source main.bicepparam reads back with az.getSecret; no container references it (the consumers receive it as an inline container-app secret).')
param jobsPortalToJobsRoot string = ''

// The one secret here that is NOT consumed by a running app. It is stored so the
// migration job can fetch it with its managed identity at run time, which is what
// keeps the schema-owner credential out of CI entirely — see migrate-job.bicep.
// Storing it also removes the drift hazard of rotating it out-of-band: this module
// and `postgres.bicep` are fed the same parameter, so one apply sets the server
// password and this copy together.
@secure()
@description('Postgres administrator password (schema owner). Deploy-time + migrations only; never injected into a runtime container.')
param postgresAdminPassword string

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

var secrets = {
  'edge-database-url': edgeDatabaseUrl
  'egress-database-url': egressDatabaseUrl
  'portal-database-url': portalDatabaseUrl
  'edge-auth-secret': edgeAuthSecret
  'portal-secret': portalSecret
  'helix-instruction-secret': instructionSecret
  'helix-internal-secret': internalSecret
  'helix-exchange-secret': exchangeSecret
  'edge-oidc-private-key': edgeOidcPrivateKey
  'edge-oidc-certificate': edgeOidcCertificate
  'postgres-admin-password': postgresAdminPassword
}

resource secretResources 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for item in items(secrets): {
    parent: vault
    name: item.key
    properties: {
      value: item.value
    }
  }
]

// The optional secrets, written only when non-empty: the dev-gateway DSN
// exists only where the opt-in surface deploys, and the two jobs DSNs and the
// jobs server's three signing roots only where deployJobs is set — a stock
// deploy never lands an (empty) secret in kv-platform for a plane it does not
// run.
var optionalSecrets = {
  'edge-dev-database-url': edgeDevDatabaseUrl
  'jobs-database-url': jobsDatabaseUrl
  'jobs-migrate-database-url': jobsMigrateDatabaseUrl
  'jobs-edge-to-jobs-root': jobsEdgeToJobsRoot
  'jobs-jobs-to-edge-root': jobsJobsToEdgeRoot
  'jobs-portal-to-jobs-root': jobsPortalToJobsRoot
}

resource optionalSecretResources 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for item in filter(items(optionalSecrets), e => !empty(e.value)): {
    parent: vault
    name: item.key
    properties: {
      value: item.value
    }
  }
]
