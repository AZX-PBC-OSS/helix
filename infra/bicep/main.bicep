// main.bicep — Helix on Azure (M5). Resource-group-scoped orchestrator.
//
// Stands up the three-plane platform (architecture §3) on Azure Container Apps:
//   - networking with the egress-zone isolation enforced by firewall + UDRs
//   - private Postgres / Blob / Key Vault (×2) / ACR, all behind private endpoints
//   - three user-assigned identities with a least-privilege RBAC matrix
//   - two ACA environments + the edge / portal / egress container apps
//   - the public DNS zone for the apps domain
//
// Two-phase deploy (see README): apply once with deployApps=false to build the
// infra and the empty ACR, push the three images, then apply with
// deployApps=true to roll out the apps. This avoids the apps failing to pull
// from an empty registry on the very first apply.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Resource name prefix, e.g. "helix-prod".')
param namePrefix string = 'helix-prod'

@description('Globally-unique ACR name (5-50 alphanumerics).')
param registryName string

@description('Globally-unique storage account name (3-24 lowercase alphanumerics).')
param storageAccountName string

@description('Globally-unique platform Key Vault name (3-24 chars).')
param platformVaultName string

@description('Globally-unique connections Key Vault name (3-24 chars).')
param connectionsVaultName string

@description('Postgres flexible server name (globally unique, lowercase).')
param postgresServerName string

@description('Public apps domain, e.g. azx-labs.com.')
param appsDomain string = 'azx-labs.com'

@description('Blob container for app bundles.')
param blobContainerName string = 'app-bundles'

// Postgres credentials. The admin owns the schema + runs migrations (== the dev
// `helix` owner). edge/egress connect as the least-privilege runtime roles,
// which the post-deploy role SQL creates with these same passwords.
@description('Postgres administrator login.')
param postgresAdminLogin string = 'helixadmin'
@secure()
@description('Postgres administrator password.')
param postgresAdminPassword string
@secure()
@description('Password for the helix_edge runtime role.')
param edgeDbPassword string
@secure()
@description('Password for the helix_egress runtime role.')
param egressDbPassword string

// Symmetric platform secrets (base64, >= 32 bytes). Generate with
// `openssl rand -base64 48`.
@secure()
@description('EDGE_AUTH_SECRET — session/handoff HKDF root.')
param edgeAuthSecret string
@secure()
@description('PORTAL_SECRET — shared-password AES-GCM key.')
param portalSecret string
@secure()
@description('HELIX_INSTRUCTION_SECRET — shared edge<->egress attestation key.')
param instructionSecret string
@secure()
@description('EDGE_OIDC_CLIENT_SECRET — Entra app client secret for the edge.')
param edgeOidcClientSecret string

// Entra / OIDC configuration (the real app registration is an operator step).
@description('Entra tenant id (for the OIDC issuer URL).')
param entraTenantId string = tenant().tenantId
@description('Edge OIDC client id (Entra app registration).')
param edgeOidcClientId string
@description('Portal OIDC audience (Entra API app id URI / client id).')
param portalOidcAudience string
@description('Portal admin Entra group object id (approvals gate).')
param portalAdminGroupId string
@description('Public CLI client id for OIDC discovery.')
param azxCliClientId string = 'azx-cli'
@description('Public web SPA client id for OIDC discovery.')
param azxWebClientId string = 'azx-portal-web'

@description('LLM upstream endpoint for the edge gateway.')
param llmEndpoint string = 'https://api.anthropic.com'

// Image references (phase 2). Repo names are fixed; tag is parameterized.
@description('Container image tag to deploy for all three apps.')
param imageTag string = 'latest'

@description('Phase gate: false = infra only; true = also deploy the container apps.')
param deployApps bool = false

@description('ACA custom-domain verification id (asuid TXT). Empty = skip.')
param domainVerificationId string = ''

var oidcIssuer = '${az.environment().authentication.loginEndpoint}${entraTenantId}/v2.0'

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

module routing 'modules/routing.bicep' = {
  name: 'routing'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    location: location
    namePrefix: namePrefix
    appsRouteTableId: routing.outputs.appsRouteTableId
    egressRouteTableId: routing.outputs.egressRouteTableId
  }
}

module firewall 'modules/firewall.bicep' = {
  name: 'firewall'
  params: {
    location: location
    namePrefix: namePrefix
    firewallSubnetId: network.outputs.firewallSubnetId
    appsSubnetPrefix: network.outputs.appsSubnetPrefix
    egressSubnetPrefix: network.outputs.egressSubnetPrefix
    appsRouteTableName: routing.outputs.appsRouteTableName
    egressRouteTableName: routing.outputs.egressRouteTableName
  }
}

module privateDns 'modules/privatedns.bicep' = {
  name: 'privatedns'
  params: {
    namePrefix: namePrefix
    vnetId: network.outputs.vnetId
  }
}

// ---------------------------------------------------------------------------
// Managed dependencies (all private)
// ---------------------------------------------------------------------------

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    registryName: registryName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    acrPrivateDnsZoneId: privateDns.outputs.acrZoneId
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    storageAccountName: storageAccountName
    containerName: blobContainerName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    blobPrivateDnsZoneId: privateDns.outputs.blobZoneId
  }
}

module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    platformVaultName: platformVaultName
    connectionsVaultName: connectionsVaultName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    keyVaultPrivateDnsZoneId: privateDns.outputs.keyVaultZoneId
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    serverName: postgresServerName
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdminPassword
    delegatedSubnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: privateDns.outputs.postgresZoneId
    databaseName: 'helix'
  }
}

// ---------------------------------------------------------------------------
// Identities + RBAC
// ---------------------------------------------------------------------------

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module rbac 'modules/rbac.bicep' = {
  name: 'rbac'
  params: {
    registryName: registry.outputs.registryName
    storageAccountName: storage.outputs.storageAccountName
    platformVaultName: keyvault.outputs.platformVaultName
    connectionsVaultName: keyvault.outputs.connectionsVaultName
    edgePrincipalId: identity.outputs.edgeIdentityPrincipalId
    portalPrincipalId: identity.outputs.portalIdentityPrincipalId
    egressPrincipalId: identity.outputs.egressIdentityPrincipalId
  }
}

// ---------------------------------------------------------------------------
// Platform secrets (kv-platform). ARM-plane writes bypass the vault firewall.
// ---------------------------------------------------------------------------

var pgFqdn = postgres.outputs.serverFqdn
var edgeDbConn = 'postgresql://helix_edge:${edgeDbPassword}@${pgFqdn}:5432/helix?sslmode=require'
var egressDbConn = 'postgresql://helix_egress:${egressDbPassword}@${pgFqdn}:5432/helix?sslmode=require'
var portalDbConn = 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${pgFqdn}:5432/helix?sslmode=require'

module platformSecrets 'modules/kv-secrets.bicep' = {
  name: 'platform-secrets'
  params: {
    vaultName: platformVaultName
    edgeDatabaseUrl: edgeDbConn
    egressDatabaseUrl: egressDbConn
    portalDatabaseUrl: portalDbConn
    storageConnectionString: storage.outputs.connectionString
    edgeAuthSecret: edgeAuthSecret
    portalSecret: portalSecret
    instructionSecret: instructionSecret
    edgeOidcClientSecret: edgeOidcClientSecret
  }
  dependsOn: [
    keyvault
  ]
}

var platformVaultUri = keyvault.outputs.platformVaultUri
var connectionsVaultUri = keyvault.outputs.connectionsVaultUri

// ---------------------------------------------------------------------------
// ACA environments (two zones)
// ---------------------------------------------------------------------------

module appsEnv 'modules/aca-environment.bicep' = {
  name: 'aca-apps-env'
  params: {
    location: location
    name: '${namePrefix}-apps-env'
    infrastructureSubnetId: network.outputs.appsSubnetId
    internal: false // public inbound LB so the edge can take external ingress
  }
  dependsOn: [
    firewall // routes must exist before the env wires up egress
  ]
}

module egressEnv 'modules/aca-environment.bicep' = {
  name: 'aca-egress-env'
  params: {
    location: location
    name: '${namePrefix}-egress-env'
    infrastructureSubnetId: network.outputs.egressSubnetId
    internal: true // never publicly routable; only the edge (in-VNet) reaches it
  }
  dependsOn: [
    firewall
  ]
}

// ---------------------------------------------------------------------------
// Container apps (phase 2)
// ---------------------------------------------------------------------------

var acrLoginServer = registry.outputs.loginServer

module egressApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'app-egress'
  params: {
    location: location
    name: '${namePrefix}-egress'
    environmentId: egressEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.egressIdentityId
    acrLoginServer: acrLoginServer
    image: '${acrLoginServer}/helix-egress:${imageTag}'
    targetPort: 8081
    external: false
    secrets: [
      { name: 'egress-database-url', keyVaultUrl: '${platformVaultUri}secrets/egress-database-url' }
      { name: 'helix-instruction-secret', keyVaultUrl: '${platformVaultUri}secrets/helix-instruction-secret' }
    ]
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'EGRESS_PORT', value: '8081' }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'AZURE_KEY_VAULT_URL', value: connectionsVaultUri }
      { name: 'EGRESS_DATABASE_URL', secretRef: 'egress-database-url' }
      { name: 'HELIX_INSTRUCTION_SECRET', secretRef: 'helix-instruction-secret' }
    ]
  }
  dependsOn: [
    rbac
    platformSecrets
  ]
}

module edgeApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'app-edge'
  params: {
    location: location
    name: '${namePrefix}-edge'
    environmentId: appsEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.edgeIdentityId
    acrLoginServer: acrLoginServer
    image: '${acrLoginServer}/helix-edge:${imageTag}'
    targetPort: 8080
    external: true
    secrets: [
      { name: 'edge-database-url', keyVaultUrl: '${platformVaultUri}secrets/edge-database-url' }
      { name: 'storage-connection-string', keyVaultUrl: '${platformVaultUri}secrets/storage-connection-string' }
      { name: 'edge-oidc-client-secret', keyVaultUrl: '${platformVaultUri}secrets/edge-oidc-client-secret' }
      { name: 'edge-auth-secret', keyVaultUrl: '${platformVaultUri}secrets/edge-auth-secret' }
      { name: 'helix-instruction-secret', keyVaultUrl: '${platformVaultUri}secrets/helix-instruction-secret' }
    ]
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: '8080' }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'EDGE_BASE_DOMAIN', value: appsDomain }
      { name: 'BLOB_CONTAINER', value: blobContainerName }
      { name: 'EDGE_OIDC_ISSUER', value: oidcIssuer }
      { name: 'EDGE_OIDC_CLIENT_ID', value: edgeOidcClientId }
      { name: 'EDGE_OIDC_GROUPS_CLAIM', value: 'groups' }
      { name: 'EDGE_LLM_ENDPOINT', value: llmEndpoint }
      { name: 'EDGE_EGRESS_URL', value: 'https://${egressApp.?outputs.fqdn ?? ''}' }
      { name: 'EDGE_DATABASE_URL', secretRef: 'edge-database-url' }
      { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'storage-connection-string' }
      { name: 'EDGE_OIDC_CLIENT_SECRET', secretRef: 'edge-oidc-client-secret' }
      { name: 'EDGE_AUTH_SECRET', secretRef: 'edge-auth-secret' }
      { name: 'HELIX_INSTRUCTION_SECRET', secretRef: 'helix-instruction-secret' }
    ]
  }
  dependsOn: [
    rbac
    platformSecrets
  ]
}

module portalApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'app-portal'
  params: {
    location: location
    name: '${namePrefix}-portal'
    environmentId: appsEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.portalIdentityId
    acrLoginServer: acrLoginServer
    image: '${acrLoginServer}/helix-portal:${imageTag}'
    targetPort: 3001
    external: false // control plane: internal ingress only, not app-routable
    secrets: [
      { name: 'portal-database-url', keyVaultUrl: '${platformVaultUri}secrets/portal-database-url' }
      { name: 'storage-connection-string', keyVaultUrl: '${platformVaultUri}secrets/storage-connection-string' }
      { name: 'portal-secret', keyVaultUrl: '${platformVaultUri}secrets/portal-secret' }
    ]
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORTAL_PORT', value: '3001' }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'BLOB_CONTAINER', value: blobContainerName }
      { name: 'PORTAL_OIDC_ISSUER', value: oidcIssuer }
      { name: 'PORTAL_OIDC_AUDIENCE', value: portalOidcAudience }
      { name: 'PORTAL_ADMIN_GROUP_ID', value: portalAdminGroupId }
      { name: 'AZX_CLI_CLIENT_ID', value: azxCliClientId }
      { name: 'AZX_WEB_CLIENT_ID', value: azxWebClientId }
      { name: 'APP_PUBLIC_BASE', value: 'https://${appsDomain}' }
      { name: 'AZURE_KEY_VAULT_URL', value: connectionsVaultUri }
      { name: 'DATABASE_URL', secretRef: 'portal-database-url' }
      { name: 'AZURE_STORAGE_CONNECTION_STRING', secretRef: 'storage-connection-string' }
      { name: 'PORTAL_SECRET', secretRef: 'portal-secret' }
    ]
  }
  dependsOn: [
    rbac
    platformSecrets
  ]
}

// ---------------------------------------------------------------------------
// Public DNS
// ---------------------------------------------------------------------------

module dns 'modules/dns.bicep' = {
  name: 'dns'
  params: {
    appsDomain: appsDomain
    edgeStaticIp: appsEnv.outputs.staticIp
    domainVerificationId: domainVerificationId
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output acrLoginServer string = acrLoginServer
output appsEnvStaticIp string = appsEnv.outputs.staticIp
output postgresServerFqdn string = postgres.outputs.serverFqdn
output connectionsVaultUri string = connectionsVaultUri
output dnsNameServers array = dns.outputs.nameServers
output edgeFqdn string = edgeApp.?outputs.fqdn ?? ''
output egressFqdn string = egressApp.?outputs.fqdn ?? ''
output portalFqdn string = portalApp.?outputs.fqdn ?? ''
