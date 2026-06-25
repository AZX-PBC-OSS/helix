// identity.bicep — one user-assigned managed identity per container app.
//
// User-assigned (not system-assigned) so role assignments can be made in
// rbac.bicep *before* the apps exist, breaking the otherwise-circular dependency
// between an app, its identity, and the ACR/KV roles the app needs at first pull.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

resource edgeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-edge-id'
  location: location
}

resource portalIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-portal-id'
  location: location
}

resource egressIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-egress-id'
  location: location
}

output edgeIdentityId string = edgeIdentity.id
output edgeIdentityPrincipalId string = edgeIdentity.properties.principalId
output edgeIdentityClientId string = edgeIdentity.properties.clientId

output portalIdentityId string = portalIdentity.id
output portalIdentityPrincipalId string = portalIdentity.properties.principalId
output portalIdentityClientId string = portalIdentity.properties.clientId

output egressIdentityId string = egressIdentity.id
output egressIdentityPrincipalId string = egressIdentity.properties.principalId
output egressIdentityClientId string = egressIdentity.properties.clientId
