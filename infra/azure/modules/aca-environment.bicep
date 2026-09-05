// aca-environment.bicep — a VNet-integrated Container Apps managed environment.
//
// Called twice (architecture §3 — outbound posture is per-environment, so the
// two zones need two environments on two subnets):
//   - "apps"   on snet-apps   with internal=false. The environment has a public
//              inbound LB so the *edge* app can take external ingress; the
//              *portal* app overrides its own ingress to internal. Outbound is
//              still forced through the firewall (deny) by the subnet's UDR.
//   - "egress" on snet-egress with internal=true. No public surface at all; only
//              the edge (in-VNet) reaches it. Its UDR lets the firewall allow
//              outbound to the internet.
//
// Each environment gets its own Log Analytics workspace for app logs.

@description('Azure region.')
param location string

@description('Environment name.')
param name string

@description('Infrastructure subnet id (snet-apps or snet-egress).')
param infrastructureSubnetId string

@description('Internal-only environment (no public inbound LB). true for egress, false for apps.')
param internal bool

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      internal: internal
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

output environmentId string = managedEnvironment.id
output environmentName string = managedEnvironment.name

// The resource group Azure creates for this environment's own infrastructure —
// the standard load balancer, and a public IP on an external environment. It is
// a SEPARATE resource group from the one this template deploys into, it holds
// real billable resources (~$20/mo per environment), and nothing scoped to the
// deployment's own resource group can see it. `alerts-cost.bicep` needs the name
// to include it in the budget filter.
//
// Read from the resource rather than rebuilt from the `ME_<env>_<rg>_<region>`
// convention on purpose: the convention is Azure's to change, and a budget that
// silently stops matching is exactly the failure this output exists to prevent.
output infrastructureResourceGroup string = managedEnvironment.properties.infrastructureResourceGroup
output defaultDomain string = managedEnvironment.properties.defaultDomain
output staticIp string = managedEnvironment.properties.staticIp
@description('Log Analytics workspace id — so a workspace-based Application Insights component can attach to the workspace this environment already ships stdout to, rather than provisioning a second one.')
output logAnalyticsWorkspaceId string = logAnalytics.id
