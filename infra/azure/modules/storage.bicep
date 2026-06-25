// storage.bicep — the Blob account holding versioned app bundles.
//
// Public network access is disabled; the edge (read) and portal (write) reach
// it over a private endpoint through privatelink.blob.*. The `app-bundles`
// container matches the BLOB_CONTAINER default the apps expect.
//
// Both apps authenticate to Blob with a connection string today (surfaced via
// kv-platform → AZURE_STORAGE_CONNECTION_STRING). The account key is returned
// as an output for main.bicep to assemble that secret; the managed-identity
// RBAC roles (Storage Blob Data Reader/Contributor) are also granted in
// rbac.bicep so a future switch to AAD-auth blob access needs no infra change.

@description('Azure region.')
param location string

@description('Globally-unique storage account name (3-24 lowercase alphanumerics).')
param storageAccountName string

@description('Blob container name for app bundles.')
param containerName string = 'app-bundles'

@description('Subnet id for the private endpoint (snet-pe).')
param privateEndpointSubnetId string

@description('Resource id of the privatelink.blob.* private DNS zone.')
param blobPrivateDnsZoneId string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource bundlesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

module privateEndpoint 'private-endpoint.bicep' = {
  name: 'pe-${storageAccountName}'
  params: {
    location: location
    name: '${storageAccountName}-pe'
    subnetId: privateEndpointSubnetId
    targetResourceId: storageAccount.id
    groupId: 'blob'
    privateDnsZoneId: blobPrivateDnsZoneId
  }
}

output storageAccountId string = storageAccount.id
output storageAccountName string = storageAccount.name
// Connection string for the apps. Built from the listed key; consumed by
// main.bicep to populate the kv-platform secret.
#disable-next-line outputs-should-not-contain-secrets
output connectionString string = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
