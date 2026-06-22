// registry.bicep — Azure Container Registry (Premium) reachable only over a
// private endpoint.
//
// Premium SKU is required for private endpoints. The admin user is disabled —
// the three container apps pull via their user-assigned managed identities
// (AcrPull granted in rbac.bicep). Public network access is off; ACA pulls
// resolve through the privatelink.azurecr.io zone.

@description('Azure region.')
param location string

@description('Globally-unique ACR name (alphanumeric, 5-50 chars).')
param registryName string

@description('Subnet id for the private endpoint (snet-pe).')
param privateEndpointSubnetId string

@description('Resource id of the privatelink.azurecr.io private DNS zone.')
param acrPrivateDnsZoneId string

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
  }
}

module privateEndpoint 'private-endpoint.bicep' = {
  name: 'pe-${registryName}'
  params: {
    location: location
    name: '${registryName}-pe'
    subnetId: privateEndpointSubnetId
    targetResourceId: registry.id
    groupId: 'registry'
    privateDnsZoneId: acrPrivateDnsZoneId
  }
}

output registryId string = registry.id
output registryName string = registry.name
output loginServer string = registry.properties.loginServer
