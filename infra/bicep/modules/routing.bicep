// routing.bicep — the two route tables, created empty.
//
// They must exist before the VNet (subnets associate them at creation), but
// their 0.0.0.0/0 route points at the firewall's private IP, which doesn't
// exist until the firewall is deployed into AzureFirewallSubnet (which lives in
// the VNet). To break that cycle we create the tables empty here and add the
// default route in firewall.bicep once the firewall IP is known.
//
// `disableBgpRoutePropagation: true` stops on-prem/gateway routes from
// overriding our forced-tunnel default route.
//
// Note: the firewall does NOT need an explicit allow rule for snet-apps →
// snet-egress. Intra-VNet traffic uses the system VNet route (more specific
// than 0.0.0.0/0), so edge→egress stays local and never traverses the firewall.
// The default route only catches internet-bound traffic.

@description('Azure region.')
param location string

@description('Resource name prefix, e.g. "helix-prod".')
param namePrefix string

resource appsRouteTable 'Microsoft.Network/routeTables@2024-05-01' = {
  name: '${namePrefix}-rt-apps'
  location: location
  properties: {
    disableBgpRoutePropagation: true
  }
}

resource egressRouteTable 'Microsoft.Network/routeTables@2024-05-01' = {
  name: '${namePrefix}-rt-egress'
  location: location
  properties: {
    disableBgpRoutePropagation: true
  }
}

output appsRouteTableId string = appsRouteTable.id
output appsRouteTableName string = appsRouteTable.name
output egressRouteTableId string = egressRouteTable.id
output egressRouteTableName string = egressRouteTable.name
