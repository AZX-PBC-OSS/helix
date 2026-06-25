// privatedns.bicep — private DNS zones + VNet links for the managed dependencies.
//
// Two flavours of zone here:
//   - Postgres Flexible Server *private access* (VNet injection) needs a zone
//     ending in `.postgres.database.azure.com` (NOT a privatelink zone) wired
//     into the server's network config.
//   - Blob / Key Vault / ACR use *private endpoints*, which resolve through the
//     standard `privatelink.*` zones.
//
// ACA managed environments create and link their OWN private DNS zone for the
// internal ingress default domain, so those are not managed here.

@description('Resource name prefix.')
param namePrefix string

@description('Resource id of the VNet to link the zones to.')
param vnetId string

var postgresZoneName = '${namePrefix}.private.postgres.database.azure.com'
var blobZoneName = 'privatelink.blob.${environment().suffixes.storage}'
var keyVaultZoneName = 'privatelink${environment().suffixes.keyvaultDns}'
var acrZoneName = 'privatelink.azurecr.io'

resource postgresZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresZoneName
  location: 'global'
}
resource blobZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: blobZoneName
  location: 'global'
}
resource keyVaultZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: keyVaultZoneName
  location: 'global'
}
resource acrZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: acrZoneName
  location: 'global'
}

resource postgresLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresZone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}
resource blobLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: blobZone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}
resource keyVaultLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: keyVaultZone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}
resource acrLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: acrZone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}

output postgresZoneId string = postgresZone.id
output blobZoneId string = blobZone.id
output keyVaultZoneId string = keyVaultZone.id
output acrZoneId string = acrZone.id
