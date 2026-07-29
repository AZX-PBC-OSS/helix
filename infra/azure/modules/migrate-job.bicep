// migrate-job.bicep — Prisma migrations as a manually-triggered Container Apps Job.
//
// WHY A JOB AND NOT A PIPELINE STEP
// Postgres is private-endpoint-only (`publicNetworkAccess: Disabled`), so nothing
// outside the VNet can reach it — not a laptop, not a hosted CI runner. A Container
// Apps Job in the apps environment is inside the VNet and runs the portal image,
// which already ships the Prisma CLI and the migration history.
//
// WHY THIS IS DECLARED IN THE TEMPLATE RATHER THAN CREATED PER RUN
// Migrations run as the schema owner (`helixadmin`) — the portal refuses that DSN at
// runtime (ADR-0002). Earlier drafts had CI build this job on the fly with the admin
// DSN as a job secret, which meant (a) the deploy principal had to hold the
// schema-owner credential and (b) a readable admin credential sat in the resource
// group until a cleanup step removed it. Declaring the job here instead, with an
// identity that reads the password from kv-platform at run time, means **nothing
// outside the vault ever holds it**: the job definition carries only a vault URL, a
// hostname, and a client id. A deploy is then `job update --image <tag>` +
// `job start`, and there is nothing to tear down afterwards.
//
// The job is `Manual` — it never runs on its own. Trigger it from the release
// workflow (before an image bump, when the tag carries new migrations) or by hand:
//   az containerapp job start -g <rg> -n <namePrefix>-migrate
//
// Migrations are forward-only (ADR-0028): re-running with an older image does NOT
// roll a migration back, unlike an image bump.
//
// Its identity is deploy-scoped and deliberately NOT the portal's. The portal
// identity would work — it already holds `Key Vault Secrets User` on kv-platform —
// but it also holds Secrets Officer on kv-connections and blob write, none of which
// a migration needs. One dedicated identity with one role assignment keeps the blast
// radius of the migration path to exactly "read one secret".

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('ACA managed environment resource id (the apps env — VNet-integrated, so it can reach the Postgres and Key Vault private endpoints).')
param acaEnvId string

@description('Platform Key Vault name — the job reads postgres-admin-password from it.')
param platformVaultName string

@description('Platform Key Vault data-plane URI.')
param platformVaultUri string

@description('portal image, e.g. ghcr.io/azx-pbc-oss/helix-portal:sha-xxxx. Migrations are applied at THIS image version, so keep it in step with the apps.')
param image string

@description('Postgres server FQDN.')
param postgresHost string

@description('Postgres administrator login (the schema owner).')
param postgresAdminLogin string

@description('Database name.')
param postgresDatabase string

@description('How long a migration may run before the replica is killed, in seconds.')
param replicaTimeout int = 1800

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-migrate-id'
  location: location
}

resource platformVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: platformVaultName
}

// The only permission the migration path has. Read-only, one vault, and it is what
// replaces "CI holds the admin password".
resource vaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(platformVault.id, migrateIdentity.id, kvSecretsUserRoleId)
  scope: platformVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: migrateIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${migrateIdentity.id}': {}
    }
  }
  properties: {
    environmentId: acaEnvId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: replicaTimeout
      // No retries: a failed migration should be read and understood, not
      // re-attempted blindly against a schema that may be half-applied.
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          // Overrides the portal image's server CMD. `db:deploy:azure` resolves the
          // admin password from the vault, then execs `prisma migrate deploy`.
          command: ['pnpm']
          args: ['--filter', '@azx-pbc/portal', 'db:deploy:azure']
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          // Note the absence of a `secrets` block on this job: there is nothing
          // secret to declare. AZURE_CLIENT_ID selects the user-assigned identity
          // for DefaultAzureCredential, matching how the portal app is wired.
          env: [
            { name: 'AZURE_CLIENT_ID', value: migrateIdentity.properties.clientId }
            { name: 'PLATFORM_VAULT_URL', value: platformVaultUri }
            { name: 'POSTGRES_HOST', value: postgresHost }
            { name: 'POSTGRES_ADMIN_LOGIN', value: postgresAdminLogin }
            { name: 'POSTGRES_DATABASE', value: postgresDatabase }
          ]
        }
      ]
    }
  }
  dependsOn: [
    vaultRole
  ]
}

output jobName string = job.name
output migrateIdentityId string = migrateIdentity.id
output migrateIdentityPrincipalId string = migrateIdentity.properties.principalId
