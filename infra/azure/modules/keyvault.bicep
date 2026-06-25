// keyvault.bicep — the two Key Vaults.
//
// The split mirrors the database role split (architecture §3, secrets design):
//   - kv-platform     : infra config secrets surfaced to the container apps as
//                       ACA secretRefs (per-role PG connection strings, the blob
//                       connection string, EDGE_AUTH_SECRET, PORTAL_SECRET,
//                       HELIX_INSTRUCTION_SECRET, the OIDC client secret).
//   - kv-connections  : the prod KeyVaultSecretStore for *app connection
//                       secrets* (third-party API credentials). Portal writes
//                       them, egress reads them, EDGE NEVER TOUCHES THIS VAULT —
//                       no role assignment for the edge MI exists (rbac.bicep),
//                       so an edge RCE can't read a single credential.
//
// Both vaults: RBAC authorization (no access policies), purge protection on,
// public access disabled, reached over private endpoints through
// privatelink.vaultcore.azure.net.

@description('Azure region.')
param location string

@description('Globally-unique name for the platform vault (3-24 chars).')
param platformVaultName string

@description('Globally-unique name for the connections vault (3-24 chars).')
param connectionsVaultName string

@description('Subnet id for the private endpoints (snet-pe).')
param privateEndpointSubnetId string

@description('Resource id of the privatelink.vaultcore.azure.net private DNS zone.')
param keyVaultPrivateDnsZoneId string

var commonProperties = {
  sku: {
    family: 'A'
    name: 'standard'
  }
  tenantId: tenant().tenantId
  enableRbacAuthorization: true
  enableSoftDelete: true
  softDeleteRetentionInDays: 90
  enablePurgeProtection: true
  publicNetworkAccess: 'Disabled'
  networkAcls: {
    defaultAction: 'Deny'
    bypass: 'AzureServices'
  }
}

resource platformVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: platformVaultName
  location: location
  properties: commonProperties
}

resource connectionsVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: connectionsVaultName
  location: location
  properties: commonProperties
}

module platformPe 'private-endpoint.bicep' = {
  name: 'pe-${platformVaultName}'
  params: {
    location: location
    name: '${platformVaultName}-pe'
    subnetId: privateEndpointSubnetId
    targetResourceId: platformVault.id
    groupId: 'vault'
    privateDnsZoneId: keyVaultPrivateDnsZoneId
  }
}

module connectionsPe 'private-endpoint.bicep' = {
  name: 'pe-${connectionsVaultName}'
  params: {
    location: location
    name: '${connectionsVaultName}-pe'
    subnetId: privateEndpointSubnetId
    targetResourceId: connectionsVault.id
    groupId: 'vault'
    privateDnsZoneId: keyVaultPrivateDnsZoneId
  }
}

output platformVaultId string = platformVault.id
output platformVaultName string = platformVault.name
output platformVaultUri string = platformVault.properties.vaultUri
output connectionsVaultId string = connectionsVault.id
output connectionsVaultName string = connectionsVault.name
output connectionsVaultUri string = connectionsVault.properties.vaultUri
