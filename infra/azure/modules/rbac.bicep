// rbac.bicep — least-privilege role assignments for the three managed identities.
//
// The grant matrix is the runtime trust boundary expressed in Azure RBAC, the
// mirror of the Postgres role split:
//
//   identity | Blob           | kv-platform   | kv-connections  | kv-delegated
//   ---------|----------------|---------------|-----------------|----------------
//   edge     | Data Reader    | Secrets User  |  —  (none)      |  —  (none)
//   portal   | Data Contrib.  | Secrets User  | Secrets Officer |  —  (none)
//   egress   |  —             | Secrets User  | Secrets User    | Secrets Officer
//   dev      |  —             | Secrets User  |  —  (none)      |  —  (none)
//
// (No AcrPull: app images are pulled anonymously from public GHCR, not a private
// ACR, so no registry role assignment is needed.)
//
// The deliberate hole: the edge identity has NO role on kv-connections, so an
// edge compromise cannot read a single app connection secret. The dev-gateway
// identity has the same hole (and no blob) for the same reason — it reaches
// third-party APIs through egress and never resolves a connection secret. Its
// only kv-platform read is its own helix_dev DSN + the shared instruction key.
//
// kv-delegated (ADR-0006) holds user-delegated OAuth token material and is
// egress-ONLY: egress is the sole principal with any role on it — Officer,
// because the built-in roles have no "set without delete" and egress must
// seal/open/destroy — and the portal (and edge, and dev) get none. RBAC
// absence is what enforces "the control plane never opens a delegated
// token"; it is not a convention the code can forget. The kv-connections
// column is unchanged: provider client credentials stay sealed material on
// the provider row (portal Officer / egress User).

@description('Storage account name (to scope blob roles).')
param storageAccountName string

@description('Platform vault name (to scope secret roles).')
param platformVaultName string

@description('Connections vault name (to scope secret roles).')
param connectionsVaultName string

@description('Delegated-custody vault name (user-delegated token material; egress-only).')
param delegatedVaultName string

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
resource delegatedVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: delegatedVaultName
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

// --- kv-delegated (egress Officer, NO other assignment exists — ADR-0006) ---
resource egressDelegatedOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(delegatedVault.id, egressPrincipalId, kvSecretsOfficerRoleId)
  scope: delegatedVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
    principalId: egressPrincipalId
    principalType: 'ServicePrincipal'
  }
}
