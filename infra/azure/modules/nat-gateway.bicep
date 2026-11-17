// The gateway is created before the VNet; network.bicep owns its subnet association.
@description('Azure region, matching the egress subnet.')
param location string

@description('Resource name prefix. Keep stable to retain the allowlisted public IP.')
param namePrefix string

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${namePrefix}-egress-pip'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

// Container Apps currently supports Standard NAT, not StandardV2.
resource natGateway 'Microsoft.Network/natGateways@2024-05-01' = {
  name: '${namePrefix}-egress-nat'
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [
      { id: publicIp.id }
    ]
  }
}

output natGatewayId string = natGateway.id
output publicIpAddress string = publicIp.properties.ipAddress
