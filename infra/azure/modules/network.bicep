// network.bicep — the VNet and its subnets.
//
// Edge + portal live in `snet-apps`, egress lives alone in `snet-egress`.
// With the firewall enabled, their route tables enforce the egress-zone
// boundary (architecture §3). Without it, both have default internet access;
// optional NAT gives only snet-egress a fixed public source IP, not filtering.
// ACA binds one infrastructure subnet per managed environment, so these
// network zones need separate environments.
//
// Route tables are attached here (passed in by id) so the subnet definition and
// its UDR stay in one place — Azure rejects late association if a subnet already
// holds ACA infrastructure.

@description('Azure region for all network resources.')
param location string

@description('Resource name prefix, e.g. "helix-prod".')
param namePrefix string

@description('Resource id of the route table for snet-apps (deny-egress).')
param appsRouteTableId string

@description('Resource id of the route table for snet-egress (allow-egress).')
param egressRouteTableId string

@description('Optional NAT Gateway resource id for snet-egress. Empty detaches NAT. Mutually exclusive with firewall routing in the caller.')
param egressNatGatewayId string = ''

@description('Address space for the VNet.')
param vnetAddressPrefix string = '10.0.0.0/16'

// Subnet prefixes. AzureFirewallSubnet must be /26 or larger and must carry
// exactly that name. Workload-profile ACA environments require /27 or larger;
// each gets a /23 to leave room for scaling and revision overlap.
var firewallSubnetPrefix = '10.0.0.0/26'
var appsSubnetPrefix = '10.0.2.0/23'
var egressSubnetPrefix = '10.0.4.0/23'
var postgresSubnetPrefix = '10.0.6.0/24'
var privateEndpointSubnetPrefix = '10.0.7.0/24'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        // Azure Firewall requires this exact subnet name.
        name: 'AzureFirewallSubnet'
        properties: {
          addressPrefix: firewallSubnetPrefix
        }
      }
      {
        // Firewall routes, when deployed, restrict the apps environment's outbound access.
        name: 'snet-apps'
        properties: {
          addressPrefix: appsSubnetPrefix
          routeTable: {
            id: appsRouteTableId
          }
          delegations: [
            {
              name: 'aca-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        // NAT applies to every replica in this environment. A firewall UDR
        // would take precedence, so the caller rejects enabling both features.
        name: 'snet-egress'
        properties: {
          addressPrefix: egressSubnetPrefix
          natGateway: empty(egressNatGatewayId) ? null : { id: egressNatGatewayId }
          routeTable: {
            id: egressRouteTableId
          }
          delegations: [
            {
              name: 'aca-egress'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        // Postgres Flexible Server private access (VNet injection) needs a
        // dedicated delegated subnet.
        name: 'snet-postgres'
        properties: {
          addressPrefix: postgresSubnetPrefix
          delegations: [
            {
              name: 'pg-flexible'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
      {
        // Private endpoints for blob, both key vaults, and ACR.
        name: 'snet-pe'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

// Subnets are declared inline above (so Azure creates them atomically with the
// VNet); these `existing` references just expose stable resource ids as outputs.
resource firewallSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'AzureFirewallSubnet'
}
resource appsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'snet-apps'
}
resource egressSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'snet-egress'
}
resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'snet-postgres'
}
resource peSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'snet-pe'
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output firewallSubnetId string = firewallSubnet.id
output appsSubnetId string = appsSubnet.id
output egressSubnetId string = egressSubnet.id
output postgresSubnetId string = postgresSubnet.id
output privateEndpointSubnetId string = peSubnet.id
output appsSubnetPrefix string = appsSubnetPrefix
output egressSubnetPrefix string = egressSubnetPrefix
