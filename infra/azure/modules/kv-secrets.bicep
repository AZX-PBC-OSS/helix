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
@description('EDGE_OIDC_CLIENT_PRIVATE_KEY (edge cert private key, PEM or base64 PEM).')
param edgeOidcPrivateKey string
@secure()
@description('EDGE_OIDC_CLIENT_CERTIFICATE (edge cert, PEM or base64 PEM).')
param edgeOidcCertificate string
@secure()
@description('EDGE_DEV_DATABASE_URL (helix_dev DSN, dev-gateway). Empty = skip — the surface is opt-in and off unless deployDevGateway is set.')
param edgeDevDatabaseUrl string = ''

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

// The dev-gateway DSN is written only when the opt-in surface is deployed, so a
// stock deploy never lands an (empty) helix_dev secret in kv-platform.
resource devDatabaseSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(edgeDevDatabaseUrl)) {
  parent: vault
  name: 'edge-dev-database-url'
  properties: {
    value: edgeDevDatabaseUrl
  }
}
