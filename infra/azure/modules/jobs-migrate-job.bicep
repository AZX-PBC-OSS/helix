// jobs-migrate-job.bicep — the jobs database's own migrations as a
// manually-triggered Container Apps Job.
//
// The jobs plane's storage is a private database on the platform's Postgres
// server (background-jobs design §8), and its migrations are a separately
// executed command (`pnpm --filter @azx-pbc/jobs db:migrate`), never a
// startup flag under the runtime role. Nothing outside the VNet can reach
// Postgres, so — exactly like migrate-job.bicep for the platform schema — the
// migration runs as a job in the apps environment, inside the VNet.
//
// Two things keep the migration authority separated (spec criterion 69):
//
// - Its identity is deploy-scoped and its own — not the jobs runtime's, not
//   the portal migrate job's. Its single permission is reading ONE secret
//   (`jobs-migrate-database-url`, the `helix_jobs_migrate` DSN) from
//   kv-platform at run time; nothing outside the vault ever holds that DSN.
// - The job carries no runtime credential and no runtime env: the migration
//   DSN must never ride a runtime environment, and no runtime container ever
//   receives it.
//
// The job is `Manual` — it never runs on its own. Trigger it when enabling
// jobs and with every jobs image bump, before rolling the jobs app:
//   az containerapp job start -g <rg> -n <namePrefix>-jobs-migrate
//
// Migrations are forward-only (background-jobs design §8): an image rollback
// must be checked against the forward-only schema — the jobs service's
// startup compatibility check reports a mismatch through /health instead of
// migrating, so a rolled-back image degrades loudly rather than silently.
//
// Like the platform migrate job, the job reads its secret at RUN time rather
// than holding a Key Vault reference: ACA Jobs cannot resolve references
// (microsoft/azure-container-apps#1804). Unlike the portal image, the jobs
// image carries no @azure/identity — the script authenticates through the
// Container Apps managed-identity endpoint directly (the secret-store's
// provider), keeping the image's dependency closure minimal.

@description('Azure region.')
param location string

@description('Resource name prefix.')
param namePrefix string

@description('ACA managed environment resource id (the apps env — VNet-integrated, so it can reach the Postgres and Key Vault private endpoints).')
param acaEnvId string

@description('Platform Key Vault name — the job reads jobs-migrate-database-url from it.')
param platformVaultName string

@description('Platform Key Vault data-plane URI.')
param platformVaultUri string

@description('helix-jobs image, e.g. ghcr.io/azx-pbc-oss/helix-jobs:sha-xxxx. Jobs migrations are applied at THIS image version, so keep it in step with the jobs app.')
param image string

@description('How long a migration may run before the replica is killed, in seconds.')
param replicaTimeout int = 1800

var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-jobs-migrate-id'
  location: location
}

resource platformVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: platformVaultName
}

// The only permission the jobs migration path has. Read-only, one vault.
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
  name: '${namePrefix}-jobs-migrate'
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
          name: 'jobs-migrate'
          image: image
          // Overrides the jobs image's server CMD: the migration entry reads
          // the migration DSN from the vault, then runs the package's own
          // `db:migrate` command (apps/jobs/scripts/migrate-azure.ts) — the
          // same command an operator runs locally, so its structured
          // start/outcome/duration events are the job log verbatim.
          command: [
            'node'
            '--import'
            'tsx'
            'scripts/migrate-azure.ts'
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          // No `secrets` block — ACA Jobs cannot resolve Key Vault references
          // (microsoft/azure-container-apps#1804), which is why the DSN is
          // read at run time with the identity below.
          env: [
            { name: 'AZURE_CLIENT_ID', value: migrateIdentity.properties.clientId }
            { name: 'PLATFORM_VAULT_URL', value: platformVaultUri }
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
