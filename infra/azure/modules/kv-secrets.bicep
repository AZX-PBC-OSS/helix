// kv-secrets.bicep — writes the platform config secrets into kv-platform.
//
// Separated from main so the vault name is a module *parameter* (known at start
// of deployment), which a parent-of-secret reference requires, and so the apps
// can depend on this whole module rather than eight individual secret resources.
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
@description('portal (admin/owner) connection string.')
param portalDatabaseUrl string
@secure()
@description('Blob storage connection string.')
param storageConnectionString string
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

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

var secrets = {
  'edge-database-url': edgeDatabaseUrl
  'egress-database-url': egressDatabaseUrl
  'portal-database-url': portalDatabaseUrl
  'storage-connection-string': storageConnectionString
  'edge-auth-secret': edgeAuthSecret
  'portal-secret': portalSecret
  'helix-instruction-secret': instructionSecret
  'edge-oidc-private-key': edgeOidcPrivateKey
  'edge-oidc-certificate': edgeOidcCertificate
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
