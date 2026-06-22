// private-endpoint.bicep — reusable: one private endpoint + its DNS zone group.
//
// Shared by registry.bicep, storage.bicep, and keyvault.bicep so the PE wiring
// (which is identical apart from the target resource, the groupId, and the DNS
// zone) lives in one place.

@description('Azure region.')
param location string

@description('Private endpoint name.')
param name string

@description('Subnet id to place the private endpoint NIC in (snet-pe).')
param subnetId string

@description('Resource id of the service the PE connects to.')
param targetResourceId string

@description('groupId / sub-resource of the target (e.g. "blob", "vault", "registry").')
param groupId string

@description('Resource id of the private DNS zone for this service.')
param privateDnsZoneId string

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: name
  location: location
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: targetResourceId
          groupIds: [groupId]
        }
      }
    ]
  }
}

resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: replace(groupId, '.', '-')
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

output privateEndpointId string = privateEndpoint.id
