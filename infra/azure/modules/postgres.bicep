// postgres.bicep — Azure Database for PostgreSQL Flexible Server, private access.
//
// VNet-injected into snet-postgres with no public endpoint (setting
// delegatedSubnetResourceId implies publicNetworkAccess: Disabled). The server
// FQDN resolves to its private IP through the postgres private DNS zone.
//
// This module provisions the SERVER and its two databases — the platform
// `helix` store and the jobs plane's private `helix_jobs` store. The
// least-privilege runtime roles (helix_portal / helix_edge / helix_egress /
// helix_dev / helix_jobs, each NOBYPASSRLS) and their GRANTs are NOT
// infrastructure — they come from the role SQL (`infra/azure/sql/01-roles.sql`)
// + migrations, run post-deploy as the admin (see README step 4). The
// per-role connection strings are assembled in main.bicep into kv-platform
// secrets.

@description('Azure region.')
param location string

@description('Flexible server name (globally unique, 3-63 lowercase chars).')
param serverName string

@description('Administrator login name.')
param administratorLogin string

@description('Administrator password.')
@secure()
param administratorPassword string

@description('Resource id of the delegated subnet (snet-postgres).')
param delegatedSubnetId string

@description('Resource id of the *.private.postgres.database.azure.com DNS zone.')
param privateDnsZoneId string

@description('Application database name.')
param databaseName string = 'helix'

@description('Jobs plane database name. Deliberately declared, never gated: an apply must never be able to delete the jobs store, and a re-enabled jobs plane reuses its retained records (background-jobs design §8 retirement rules). The name must stay the one infra/azure/sql/01-roles.sql provisions — provisioning-parity.test.ts holds the two together.')
param jobsDatabaseName string = 'helix_jobs'

@description('Compute SKU name.')
param skuName string = 'Standard_D2ds_v5'

@description('Compute tier.')
param skuTier string = 'GeneralPurpose'

@description('PostgreSQL major version.')
param postgresVersion string = '18'

@description('Storage size in GB.')
param storageSizeGB int = 32

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
    }
    highAvailability: {
      mode: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// The jobs plane's private store (background-jobs design §8). The role SQL's
// create-if-missing is idempotent against this — whichever lands first, the
// other is a no-op. Roles/ACLs are the SQL's job (see the header), so this
// resource only guarantees the database exists.
resource jobsDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: jobsDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverId string = server.id
output serverName string = server.name
output serverFqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = databaseName
output jobsDatabaseName string = jobsDatabaseName
