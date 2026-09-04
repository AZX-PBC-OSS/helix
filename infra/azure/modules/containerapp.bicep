// containerapp.bicep — a single Container App, reused for edge / portal / egress.
//
// The caller supplies the per-app shape: which environment, which managed
// identity, ingress exposure (external for edge, internal for portal/egress),
// the image, plain env vars, and secret values. Secrets are injected as direct
// values (the deployment sources them; the app only ever reads env vars via
// secretRef, so it stays cloud-agnostic — no Key Vault SDK). The user-assigned
// identity is used at runtime for data-plane access (blob, kv-connections) and
// for private image pulls — no admin credentials, no app-held keys.
//
// Why not ACA Key Vault references? They resolve on the ACA control plane
// (outside the VNet) at revision-provisioning time, so they cannot read a
// private (VNet-only) vault. Delivering values here keeps kv-platform fully
// private AND keeps the app portable. See README "Platform secret delivery".
//
// An optional `customDomains` list declares TLS bindings in-template (ADR-0044)
// — main.bicep computes it for the wildcard-TLS planes once the install's
// bootstrap has run. Internal-only apps (egress; portal by default) pass
// nothing and get the same ingress shape as before.

@description('Azure region.')
param location string

@description('Container app name.')
param name string

@description('Managed environment id.')
param environmentId string

@description('User-assigned managed identity resource id.')
param userAssignedIdentityId string

@description('Container image reference (registry/repo:tag), e.g. ghcr.io/azx-pbc-oss/helix-edge:latest.')
param image string

@description('Container listen port.')
param targetPort int

@description('External ingress (true=public for edge; false=internal for portal/egress).')
param external bool

@description('CPU cores (string so fractional values like "0.5" survive).')
param cpuCores string = '0.5'

@description('Memory, e.g. "1Gi".')
param memory string = '1Gi'

@description('Minimum replicas.')
param minReplicas int = 1

@description('Maximum replicas.')
param maxReplicas int = 3

@description('Plain + secretRef environment entries for the container.')
param envVars array = []

@description('Secrets injected as direct values: an object mapping secret name -> value. Exposed to the container as env vars via secretRef. @secure so the values never land in ARM deployment history.')
@secure()
param secretValues object = {}

@description('Registry auth entries for the pull. Empty = anonymous pull (public images, e.g. public GHCR packages). For a private registry pass e.g. { server, identity } (managed identity) or { server, username, passwordSecretRef }.')
param registries array = []

@description('Container start command override (replaces the image CMD). Empty = use the image default. Used to run the edge image as the dev-gateway (`start:devgw`).')
param command array = []

// Typed so a wrong bindingType ('SNIEnabled', say) is a `bicep build` failure
// here, not a deploy-time ARM failure on the edge app — for a template whose
// failure mode is "every browser rejects the site", compile time is the right
// place to find that.
type customDomain = {
  name: string
  bindingType: 'SniEnabled' | 'Disabled'
  certificateId: string
}

@description('Custom-domain TLS bindings for this ingress, e.g. [{ name: "*.apps.example.com", bindingType: "SniEnabled", certificateId: <ACA env certificate resource id> }]. Empty = the ingress carries no customDomains property at all. main.bicep computes these for the wildcard-TLS planes (ADR-0044); internal-only apps pass nothing.')
param customDomains customDomain[] = []

var acaSecrets = [
  for item in items(secretValues): {
    name: item.key
    value: item.value
  }
]

// PARITY, NOT PROTECTION (ADR-0044): an absent customDomains and an explicit
// `customDomains: []` BOTH strip live runtime-made bindings on a PUT — ARM
// reconciles the whole resource to whatever the template says, and "no list"
// and "empty list" are the same instruction. So this is not a guard; it keeps
// the ungated path byte-identical to the pre-declarative shape (an install
// with wildcardTlsBound=false sees no new what-if noise). Bicep cannot
// conditionally include an object property inline, hence the union idiom.
var ingressConfig = union(
  {
    external: external
    targetPort: targetPort
    transport: 'auto'
    allowInsecure: false
    traffic: [
      {
        latestRevision: true
        weight: 100
      }
    ]
  },
  empty(customDomains) ? {} : { customDomains: customDomains }
)

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: ingressConfig
      registries: registries
      secrets: acaSecrets
    }
    template: {
      containers: [
        union(
          {
            name: name
            image: image
            resources: {
              cpu: json(cpuCores)
              memory: memory
            }
            env: envVars
          },
          // Only override the image CMD when a command is supplied (dev-gateway).
          empty(command) ? {} : { command: command }
        )
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output appId string = containerApp.id
output appName string = containerApp.name
output fqdn string = containerApp.properties.configuration.ingress.fqdn

// The value dns.bicep's asuid TXT record needs (domainVerificationId). Read it
// off the deployment output rather than a hand-run `az containerapp show` —
// it makes the fresh-install bootstrap flow mechanical (README "Wildcard TLS").
output customDomainVerificationId string = containerApp.properties.customDomainVerificationId
