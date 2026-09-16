// foundry-rg.bicep — the Foundry account's OWN resource group, with the account
// (modules/foundry.bicep) deployed into it. Subscription-scoped because
// main.bicep is resource-group-scoped and only a subscription deployment can
// create a group; main invokes this the same way it invokes alerts-cost.bicep.
//
// WHY THE ACCOUNT GETS ITS OWN GROUP — it is the platform/LLM cost-axis split,
// and that split cannot be done by budget filter. Consumption budget filters
// are a conjunction of `In` comparisons (AND only — the 2024-08-01 schema has
// no `not`), so "the platform's groups EXCEPT Foundry" is not expressible. And
// the exclusion would have to cover BOTH of Foundry's billing planes anyway:
// Azure-sold models (the OpenAI family) meter against the account resource
// itself, while Anthropic models bill through Azure Marketplace and their
// meters surface under the account's resource GROUP as `<model>-<guid>`
// entries, not on the account. Both planes roll up under the account's group —
// so with the account in its own group, the platform budget's
// ResourceGroupName list simply never contains it (alerts-cost.bicep stays
// exact with zero filter games) and one group-scoped budget on it
// (alerts-cost-foundry.bicep) sees ALL LLM spend. With vendor-direct keys
// (deployFoundry=false) LLM spend is not in Azure at all, which is why this
// whole module is conditional on deployFoundry.
//
// Lifecycle isolation is the second reason: deleting the account goes to
// soft-delete (holding quota up to 48h, purge is its own verb — see the README
// "Azure AI Foundry" section) and the Anthropic marketplace attestation lives
// on the deployments. None of that should share a blade or a casualty with the
// platform's data services.

targetScope = 'subscription'

@description('Name of the resource group to create for the Foundry account. main.bicep derives "<namePrefix>-foundry-rg" when foundryResourceGroupName is empty.')
param rgName string

@description('Location of the resource GROUP (metadata only — the account has its own location). The platform location.')
param location string

@description('Location of the Foundry ACCOUNT (model availability is regional). main.bicep passes foundryLocation, defaulting to the platform location.')
param accountLocation string

@description('Foundry account name — globally unique (becomes <name>.services.ai.azure.com).')
param accountName string

@description('Models to deploy — see modules/foundry.bicep.')
param models array

@description('Anthropic marketplace attestation — see modules/foundry.bicep.')
param providerAttestation object = {}

@description('Per-deployment rate-limit allocation in thousands of TPM when an entry sets no capacity of its own.')
param defaultCapacity int = 50

@description('Refuse API-key auth on the account (disableLocalAuth).')
param disableLocalAuth bool = true

@description('Principal id of the egress managed identity — the platform\'s inference caller.')
param egressPrincipalId string

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
}

module account 'foundry.bicep' = {
  name: 'foundry-account'
  scope: rg
  params: {
    location: accountLocation
    accountName: accountName
    models: models
    providerAttestation: providerAttestation
    defaultCapacity: defaultCapacity
    disableLocalAuth: disableLocalAuth
    egressPrincipalId: egressPrincipalId
  }
}

@description('Data-plane origin shared by both endpoint families, e.g. https://<name>.services.ai.azure.com.')
output origin string = account.outputs.origin

@description('The host egress pins managed-identity token injection to.')
output host string = account.outputs.host

@description('Model deployments created on the account (deployment name == catalog model id).')
output deploymentNames array = account.outputs.deploymentNames

@description('The resource group the account was deployed into — the scope of the LLM cost budget.')
output rgName string = rg.name
