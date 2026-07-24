// rbac.bicep — least-privilege role assignments for the three managed identities.
//
// The grant matrix is the runtime trust boundary expressed in Azure RBAC, the
// mirror of the Postgres role split:
//
//   identity | Blob           | kv-platform   | kv-connections
//   ---------|----------------|---------------|----------------
//   edge     | Data Reader    | Secrets User  |  —  (none)
//   portal   | Data Contrib.  | Secrets User  | Secrets Officer
//   egress   |  —             | Secrets User  | Secrets User
//   dev      |  —             | Secrets User  |  —  (none)
//
// (No AcrPull: app images are pulled anonymously from public GHCR, not a private
// ACR, so no registry role assignment is needed.)
//
// The deliberate hole: the edge identity has NO role on kv-connections, so an
// edge compromise cannot read a single app connection secret. The dev-gateway
// identity has the same hole (and no blob) for the same reason — it reaches
// third-party APIs through egress and never resolves a connection secret. Its
// only kv-platform read is its own helix_dev DSN + the shared instruction key.

@description('Storage account name (to scope blob roles).')
param storageAccountName string

@description('Platform vault name (to scope secret roles).')
param platformVaultName string

@description('Connections vault name (to scope secret roles).')
param connectionsVaultName string

@description('Principal id of the edge managed identity.')
param edgePrincipalId string

@description('Principal id of the portal managed identity.')
param portalPrincipalId string

@description('Principal id of the egress managed identity.')
param egressPrincipalId string

@description('Principal id of the dev-gateway managed identity (helix_dev).')
param devPrincipalId string

// Built-in role definition ids (constant across tenants).
var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}
resource platformVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: platformVaultName
}
resource connectionsVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: connectionsVaultName
}

// --- Blob (edge: reader, portal: contributor; egress: none) ---
resource edgeBlobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, edgePrincipalId, blobDataReaderRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReaderRoleId)
    principalId: edgePrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource portalBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, portalPrincipalId, blobDataContributorRoleId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: portalPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// --- kv-platform Secrets User (all three) ---
resource edgePlatformSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformVault.id, edgePrincipalId, kvSecretsUserRoleId)
  scope: platformVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: edgePrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource portalPlatformSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformVault.id, portalPrincipalId, kvSecretsUserRoleId)
  scope: platformVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: portalPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource egressPlatformSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformVault.id, egressPrincipalId, kvSecretsUserRoleId)
  scope: platformVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: egressPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource devPlatformSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformVault.id, devPrincipalId, kvSecretsUserRoleId)
  scope: platformVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: devPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// --- kv-connections (portal writes, egress reads; EDGE GETS NOTHING) ---
resource portalConnectionsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectionsVault.id, portalPrincipalId, kvSecretsOfficerRoleId)
  scope: connectionsVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
    principalId: portalPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource egressConnectionsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectionsVault.id, egressPrincipalId, kvSecretsUserRoleId)
  scope: connectionsVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: egressPrincipalId
    principalType: 'ServicePrincipal'
  }
}
