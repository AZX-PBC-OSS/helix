// containerapp.bicep — a single Container App, reused for edge / portal / egress.
//
// The caller supplies the per-app shape: which environment, which managed
// identity, ingress exposure (external for edge, internal for portal/egress),
// the image, plain env vars, and Key Vault-backed secrets. Image pulls and KV
// secret resolution both authenticate with the app's user-assigned identity —
// no admin credentials, no app-held keys.

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

@description('Key Vault-backed secrets: array of { name, keyVaultUrl }.')
param secrets array = []

@description('Registry auth entries for the pull. Empty = anonymous pull (public images, e.g. public GHCR packages). For a private registry pass e.g. { server, identity } (managed identity) or { server, username, passwordSecretRef }.')
param registries array = []

@description('Container start command override (replaces the image CMD). Empty = use the image default. Used to run the edge image as the dev-gateway (`start:devgw`).')
param command array = []

// Attach the app identity to every KV-backed secret so resolution uses it.
var acaSecrets = [
  for s in secrets: {
    name: s.name
    keyVaultUrl: s.keyVaultUrl
    identity: userAssignedIdentityId
  }
]

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
      ingress: {
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
      }
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
