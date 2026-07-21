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
// `helix` owner) — used only to provision the server and, out-of-band, for the
// operator's `db:deploy` step; it is NOT handed to any runtime container. The
// portal/edge/egress containers connect as the least-privilege runtime roles,
// which the post-deploy role SQL creates with these same passwords.
@description('Postgres administrator login.')
param postgresAdminLogin string = 'helixadmin'
@secure()
@description('Postgres administrator password.')
param postgresAdminPassword string
@secure()
@description('Password for the helix_portal runtime role.')
param portalDbPassword string
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
// The tenant blocks symmetric client secrets, so the edge authenticates to Entra
// with a certificate (private_key_jwt). Both halves travel as PEM (or base64
// PEM); the public cert is also uploaded to the edge app registration.
@secure()
@description('EDGE_OIDC_CLIENT_PRIVATE_KEY — edge cert private key (PEM or base64 PEM).')
param edgeOidcPrivateKey string
@secure()
@description('EDGE_OIDC_CLIENT_CERTIFICATE — edge cert (PEM or base64 PEM).')
param edgeOidcCertificate string

// Entra / OIDC configuration (the real app registration is an operator step —
// or the infra/entra Bicep). See docs/runbooks/entra-app-registration.md.
@description('Entra tenant id (for the OIDC issuer URL).')
param entraTenantId string = tenant().tenantId
@description('Edge OIDC client id (Entra app registration).')
param edgeOidcClientId string
@description('Portal OIDC audience — the bare helix-portal client-id GUID. v2 access tokens carry the client id as aud, not the api:// URI.')
param portalOidcAudience string
@description('Portal admin gate — the App Role value (e.g. "platform-admin") assigned in Entra. A group object id also works if gating on groups.')
param portalAdminGroupId string
@description('Public CLI client id (Entra azx-cli registration) advertised for OIDC discovery.')
param azxCliClientId string
@description('Public web SPA client id (Entra helix-portal registration) advertised for OIDC discovery.')
param azxWebClientId string

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
// The portal runtime connects as the least-privilege helix_portal role, NOT the
// schema owner (ADR-0002): full DML but no owner/superuser RLS bypass and no
// DDL. Migrations run as the admin out-of-band (README step 4), so the admin DSN
// never reaches a container or kv-platform.
var portalDbConn = 'postgresql://helix_portal:${portalDbPassword}@${pgFqdn}:5432/helix?sslmode=require'

module platformSecrets 'modules/kv-secrets.bicep' = {
  name: 'platform-secrets'
  params: {
    vaultName: platformVaultName
    edgeDatabaseUrl: edgeDbConn
    egressDatabaseUrl: egressDbConn
    portalDatabaseUrl: portalDbConn
    edgeAuthSecret: edgeAuthSecret
    portalSecret: portalSecret
    instructionSecret: instructionSecret
    edgeOidcPrivateKey: edgeOidcPrivateKey
    edgeOidcCertificate: edgeOidcCertificate
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
      { name: 'edge-oidc-private-key', keyVaultUrl: '${platformVaultUri}secrets/edge-oidc-private-key' }
      { name: 'edge-oidc-certificate', keyVaultUrl: '${platformVaultUri}secrets/edge-oidc-certificate' }
      { name: 'edge-auth-secret', keyVaultUrl: '${platformVaultUri}secrets/edge-auth-secret' }
      { name: 'helix-instruction-secret', keyVaultUrl: '${platformVaultUri}secrets/helix-instruction-secret' }
    ]
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORT', value: '8080' }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'EDGE_BASE_DOMAIN', value: appsDomain }
      { name: 'BLOB_CONTAINER', value: blobContainerName }
      // Blob reads via managed identity (issue #15) — no account key. AZURE_CLIENT_ID
      // selects the user-assigned identity for the AAD token fetch; IDENTITY_ENDPOINT/
      // IDENTITY_HEADER are injected by Container Apps.
      { name: 'AZURE_CLIENT_ID', value: identity.outputs.edgeIdentityClientId }
      { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.outputs.blobEndpoint }
      { name: 'EDGE_OIDC_ISSUER', value: oidcIssuer }
      { name: 'EDGE_OIDC_CLIENT_ID', value: edgeOidcClientId }
      // App Roles (the `roles` claim), not security groups — see the runbook.
      { name: 'EDGE_OIDC_GROUPS_CLAIM', value: 'roles' }
      { name: 'EDGE_OIDC_SCOPES', value: 'openid profile email' }
      { name: 'EDGE_LLM_ENDPOINT', value: llmEndpoint }
      { name: 'EDGE_EGRESS_URL', value: 'https://${egressApp.?outputs.fqdn ?? ''}' }
      { name: 'EDGE_DATABASE_URL', secretRef: 'edge-database-url' }
      // Certificate (private_key_jwt) client auth — the tenant blocks secrets.
      { name: 'EDGE_OIDC_CLIENT_PRIVATE_KEY', secretRef: 'edge-oidc-private-key' }
      { name: 'EDGE_OIDC_CLIENT_CERTIFICATE', secretRef: 'edge-oidc-certificate' }
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
      { name: 'portal-secret', keyVaultUrl: '${platformVaultUri}secrets/portal-secret' }
    ]
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'PORTAL_PORT', value: '3001' }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'BLOB_CONTAINER', value: blobContainerName }
      // Blob writes via managed identity (issue #15) — no account key. AZURE_CLIENT_ID
      // selects the user-assigned identity for DefaultAzureCredential.
      { name: 'AZURE_CLIENT_ID', value: identity.outputs.portalIdentityClientId }
      { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.outputs.blobEndpoint }
      { name: 'PORTAL_OIDC_ISSUER', value: oidcIssuer }
      { name: 'PORTAL_OIDC_AUDIENCE', value: portalOidcAudience }
      { name: 'PORTAL_ADMIN_GROUP_ID', value: portalAdminGroupId }
      { name: 'AZX_CLI_CLIENT_ID', value: azxCliClientId }
      { name: 'AZX_WEB_CLIENT_ID', value: azxWebClientId }
      { name: 'APP_PUBLIC_BASE', value: 'https://${appsDomain}' }
      { name: 'AZURE_KEY_VAULT_URL', value: connectionsVaultUri }
      // helix_portal DSN. The portal runtime reads PORTAL_DATABASE_URL and (in
      // production) refuses the DATABASE_URL owner fallback (ADR-0002,
      // resolvePortalRuntimeUrl). Migrations run as the admin out-of-band.
      { name: 'PORTAL_DATABASE_URL', secretRef: 'portal-database-url' }
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
