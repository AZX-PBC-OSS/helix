// privatedns.bicep — private DNS zones + VNet links for the managed dependencies.
//
// Two flavours of zone here:
//   - Postgres Flexible Server *private access* (VNet injection) needs a zone
//     ending in `.postgres.database.azure.com` (NOT a privatelink zone) wired
//     into the server's network config.
//   - Blob / Key Vault use *private endpoints*, which resolve through the
//     standard `privatelink.*` zones.
//
// The zone for an internal ACA environment's ingress default domain is NOT here
// — see `acadns.bicep`, which is called with the environment's outputs (this
// module runs before the environments exist). Note that it is ours to create:
// the auto-created zone is Consumption-only-environment behaviour and does not
// happen for a workload-profiles environment.

@description('Resource name prefix.')
param namePrefix string

@description('Resource id of the VNet to link the zones to.')
param vnetId string

var postgresZoneName = '${namePrefix}.private.postgres.database.azure.com'
var blobZoneName = 'privatelink.blob.${environment().suffixes.storage}'

// NOT derived from `environment().suffixes.keyvaultDns`. That returns the PUBLIC DNS
// suffix (`.vault.azure.net`), which yields `privatelink.vault.azure.net` — a zone
// nothing ever queries. A vault's public name CNAMEs to
// `<name>.privatelink.VAULTCORE.azure.net`, so that is the zone a private endpoint
// resolves through. Getting this wrong is silent: the private endpoint provisions
// fine, its DNS zone group reports Succeeded, A records are even registered — but
// in-VNet lookups fall through to the public IPs and every data-plane call fails
// with "Public network access is disabled and request is not from a trusted service
// nor via an approved private link". Hit for real on both installs; see the README's
// "Known deploy gotchas".
//
// Hardcoded because no `environment()` suffix exposes the privatelink zone. That costs
// sovereign-cloud portability (Azure Government wants
// `privatelink.vaultcore.usgovcloudapi.net`) — make it a param if a non-public cloud
// is ever a target. The blob zone above is fine as-is: `suffixes.storage` genuinely
// does produce the right `privatelink.blob.core.windows.net`.
var keyVaultZoneName = 'privatelink.vaultcore.azure.net'

resource postgresZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresZoneName
  location: 'global'
}
resource blobZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: blobZoneName
  location: 'global'
}
resource keyVaultZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: keyVaultZoneName
  location: 'global'
}

resource postgresLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresZone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}
resource blobLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: blobZone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}
resource keyVaultLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: keyVaultZone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}
output postgresZoneId string = postgresZone.id
output blobZoneId string = blobZone.id
output keyVaultZoneId string = keyVaultZone.id
