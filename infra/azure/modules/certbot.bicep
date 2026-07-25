// certbot.bicep — wildcard TLS automation as a scheduled Container Apps Job.
//
// Provisions the certbot job + its own managed identity + the least-privilege
// RBAC it needs: DNS Zone Contributor on the public zone (to write the ACME
// DNS-01 `_acme-challenge` TXT) and Contributor on the ACA environment + edge
// app (to upload the issued cert to the environment cert store and bind the
// wildcard custom domain). See `apps/certbot` for the image/entrypoint, and
// ADR-0029 for why the cert lands on the ACA env, not Key Vault.
//
// Issuance + binding happen in the job at RUNTIME — a cert must exist before a
// custom domain can bind to it, an ordering the declarative template can't
// express — so this module does NOT declare the custom-domain binding. Trigger
// the job once after deploy to bootstrap; it then renews on its schedule. The
// `asuid.<appsDomain>` TXT (`domainVerificationId`) must be present for the bind
// to validate ownership — see `dns.bicep`.
//
// Contributor on the app/env is broader than strictly needed (the job only
// uploads a cert + binds a hostname); a custom role scoped to
// `Microsoft.App/.../certificates/write` + `containerApps/write` is a hardening
// follow-up.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('Apps domain == public DNS zone name, e.g. franklin.helix.azxlabs.io.')
param appsDomain string

@description('ACA managed environment name (the edge lives here).')
param acaEnvName string

@description('ACA managed environment resource id.')
param acaEnvId string

@description('Edge container app name (the wildcard custom domain binds here).')
param edgeAppName string

@description('Portal app name to also bind portal.<appsDomain> to (when the portal is external). Empty = skip the portal binding.')
param portalAppName string = ''

@description('certbot image, e.g. ghcr.io/azx-pbc-oss/helix-certbot:sha-xxxx.')
param image string

@description('ACME registration / expiry-notice email.')
param acmeEmail string

@description('ACME directory URL. Default = LE staging (untrusted cert, high rate limits); set the prod directory once the flow is validated.')
param acmeServer string = 'https://acme-staging-v02.api.letsencrypt.org/directory'

@description('Cron for the renewal check. Default daily 03:00 UTC.')
param cronExpression string = '0 3 * * *'

var dnsZoneContributorRoleId = 'befefa01-2a29-4197-83a8-272ff33ce314'
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

resource certbotIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-certbot-id'
  location: location
}

resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: appsDomain
}
resource acaEnv 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: acaEnvName
}
resource edgeApp 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: edgeAppName
}
resource portalApp 'Microsoft.App/containerApps@2024-03-01' existing = if (!empty(portalAppName)) {
  name: portalAppName
}

resource dnsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dnsZone.id, certbotIdentity.id, dnsZoneContributorRoleId)
  scope: dnsZone
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', dnsZoneContributorRoleId)
    principalId: certbotIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource envRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acaEnv.id, certbotIdentity.id, contributorRoleId)
  scope: acaEnv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: certbotIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource edgeRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(edgeApp.id, certbotIdentity.id, contributorRoleId)
  scope: edgeApp
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: certbotIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource portalRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(portalAppName)) {
  name: guid(resourceGroup().id, portalAppName, certbotIdentity.id, contributorRoleId)
  scope: portalApp
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: certbotIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-certbot'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${certbotIdentity.id}': {}
    }
  }
  properties: {
    environmentId: acaEnvId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 900
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: 'certbot'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'APPS_DOMAIN', value: appsDomain }
            { name: 'ACME_EMAIL', value: acmeEmail }
            { name: 'HELIX_ACME_SERVER', value: acmeServer }
            { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'DNS_ZONE_RG', value: resourceGroup().name }
            { name: 'MI_CLIENT_ID', value: certbotIdentity.properties.clientId }
            { name: 'RG', value: resourceGroup().name }
            { name: 'ACA_ENV', value: acaEnvName }
            { name: 'EDGE_APP', value: edgeAppName }
            { name: 'PORTAL_APP', value: portalAppName }
            { name: 'PORTAL_HOSTNAME', value: empty(portalAppName) ? '' : 'portal.${appsDomain}' }
          ]
        }
      ]
    }
  }
}

output certbotIdentityId string = certbotIdentity.id
output jobName string = job.name
