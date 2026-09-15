// foundry.bicep — optional Azure AI Foundry account + model deployments (ADR-0046).
//
// Why this exists: a customer-cloud install usually wants inference to stay in
// the customer's own subscription rather than call first-party Anthropic/OpenAI
// endpoints. This module deploys one AIServices (Foundry) account and one
// deployment per model in `models`, then main.bicep points both LLM families at
// it and the LLM calls authenticate KEYLESS — the egress managed identity gets
// the documented least-privilege inference roles below, and egress mints Entra
// tokens (scope https://ai.azure.com/.default) at call time. No vendor key is
// sealed, stored, or rotated anywhere (the API-key path remains as a BYO/dev
// fallback; see `disableLocalAuth`).
//
// Conventions that make this zero-touch for the platform:
//  - Deployment name == the platform catalog model id (packages/shared/src/
//    pricing.ts). The edge forwards the app-requested model id upstream
//    verbatim and Foundry routes on deployment name, so apps, per-app
//    allowlists, and metering never know the difference — there is no mapping
//    layer to drift.
//  - Deployments are serverless (GlobalStandard): pay-per-token, nothing
//    reserved, nothing billed when idle. `capacity` is a rate-limit allocation
//    in thousands of TPM; quota pools are per model per subscription, so the
//    entries below do not compete with each other.
//
// Shape follows the Claude-on-Foundry starter kit (Azure-Samples/claude) —
// including the account project and the serial deployment chain, which avoids
// the 409s Foundry returns on concurrent creates under one account.

@description('Foundry account location. Model availability is regional — see the README "Azure AI Foundry" section.')
param location string

@description('Account name. Globally unique: it becomes <name>.services.ai.azure.com (the custom subdomain token auth requires).')
param accountName string

@description('''
  Models to deploy. Each entry: { name: <catalog model id>, format: "Anthropic"|"OpenAI", modelVersion?: string, modelName?: string,
  skuName?: string, capacity?: int (thousand TPM), raiPolicyName?: string }.
  Omit modelVersion to take the RP default version for the model (the safe default for a deploy-the-catalog list — version strings differ per region).
  modelName overrides which catalog model the deployment serves when it differs from the deployment name; raiPolicyName overrides Microsoft.DefaultV2.
  Anthropic-format entries carry the marketplace attestation below.''')
param models array

@description('''
  Anthropic marketplace attestation, sent as modelProviderData on every Anthropic-format deployment — the resource provider uses it to accept the
  Anthropic Marketplace offer on the subscription's behalf, so a greenfield install needs no manual click-through. Shape:
  { organizationName: "<legal entity>", countryCode: "US", industry: "technology" }. Empty = omit the block (works once the offer was accepted before;
  a fresh subscription then fails the Claude deployments with a marketplace-terms error naming exactly this).''')
param providerAttestation object = {}

@description('Per-deployment rate-limit allocation in thousands of TPM when an entry does not set its own capacity. 50 = 50K TPM — a starting point, not a ceiling; raise per model as usage grows (quota tiers scale with consumption).')
param defaultCapacity int = 50

@description('Refuse API-key auth on the account entirely (disableLocalAuth). Default true: with keyless auth there are no keys to leak, and some Claude models are Entra-only anyway. Set false ONLY if a local-dev/smoketest flow must seed the account key as a platform secret.')
param disableLocalAuth bool = true

@description('Principal id of the egress managed identity — the platform\'s inference caller.')
param egressPrincipalId string

// Cognitive Services User covers the Foundry Models data plane
// (accounts/MaaS/* — the Claude + partner models); Cognitive Services OpenAI
// User covers the Azure OpenAI data plane. Both are needed because this one
// account serves both families.
var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2025-10-01-preview' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    allowProjectManagement: true
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: disableLocalAuth
  }
}

// The Foundry resource's default project. Account-level deployments are what
// the inference endpoints route on; the project exists because the Foundry
// control plane (and the starter-kit deployment shape this follows) treats it
// as the account's working container.
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-10-01-preview' = {
  parent: account
  name: '${accountName}-default'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

// Declared before the deployments so the deployment LROs double as RBAC
// propagation time (starter-kit trick): the first inference call after deploy
// then succeeds instead of hitting the ~5-minute role-assignment lag.
resource egressCognitiveServicesUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, egressPrincipalId, cognitiveServicesUserRoleId)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
    principalId: egressPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource egressOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, egressPrincipalId, cognitiveServicesOpenAiUserRoleId)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
    principalId: egressPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Serial: Foundry serializes deployment creates under one account and 409s
// otherwise. DefaultV2 is the current RAI policy; versionUpgradeOption stays
// NoAutoUpgrade (the RP default) because the platform serves pinned catalog
// model ids and an upstream swap under a live app is a behavior change, not a
// convenience.
@batchSize(1)
resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2025-10-01-preview' = [
  for m in models: {
    parent: account
    name: m.name
    sku: {
      name: m.?skuName ?? 'GlobalStandard'
      capacity: m.?capacity ?? defaultCapacity
    }
    // modelProviderData (the Anthropic marketplace attestation) is real but
    // absent from the published type definitions — the Azure-Samples/claude
    // starter kit ships it at this API version — so the type-checker warning on
    // this block is suppressed, not "fixed". Sending the block on an
    // OpenAI-format deployment would be rejected, hence the conditional.
    #disable-next-line BCP037
    properties: {
      model: {
        format: m.format
        name: m.?modelName ?? m.name
        ...(m.?modelVersion != null ? { version: m.modelVersion } : {})
      }
      ...(m.format == 'Anthropic' && !empty(providerAttestation)
        ? { modelProviderData: providerAttestation }
        : {})
      raiPolicyName: m.?raiPolicyName ?? 'Microsoft.DefaultV2'
    }
    dependsOn: [
      project
      egressCognitiveServicesUser
      egressOpenAiUser
    ]
  }
]

@description('Data-plane origin shared by both endpoint families, e.g. https://<name>.services.ai.azure.com. The Anthropic family is served at <origin>/anthropic/v1/messages, the OpenAI family at <origin>/openai/v1/chat/completions.')
output origin string = 'https://${account.name}.services.ai.azure.com'

@description('The host egress pins managed-identity token injection to (EGRESS_MANAGED_IDENTITY_CONNECTIONS host suffix — the exact account host).')
output host string = '${account.name}.services.ai.azure.com'

output accountName string = account.name
output accountId string = account.id
output deploymentNames array = [for m in models: m.name]
