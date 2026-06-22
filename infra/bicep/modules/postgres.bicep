// postgres.bicep — Azure Database for PostgreSQL Flexible Server, private access.
//
// VNet-injected into snet-postgres with no public endpoint (setting
// delegatedSubnetResourceId implies publicNetworkAccess: Disabled). The server
// FQDN resolves to its private IP through the postgres private DNS zone.
//
// This module provisions the SERVER and the `helix` database only. The three
// least-privilege runtime roles (helix_portal / helix_edge / helix_egress) and
// their GRANTs are NOT infrastructure — they come from the role SQL + Prisma
// `db:deploy`, run post-deploy as the admin (see README). The per-role
// connection strings are assembled in main.bicep into kv-platform secrets.

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

@description('Compute SKU name.')
param skuName string = 'Standard_D2ds_v5'

@description('Compute tier.')
param skuTier string = 'GeneralPurpose'

@description('PostgreSQL major version.')
param postgresVersion string = '16'

@description('Storage size in GB.')
param storageSizeGB int = 32

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
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

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverId string = server.id
output serverName string = server.name
output serverFqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = databaseName
