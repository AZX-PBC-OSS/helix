// acadns.bicep — private DNS for an *internal* Container Apps environment.
//
// Azure does NOT create this for you. The auto-created-and-linked private DNS
// zone that internal environments used to get is a **Consumption-only
// environment** behaviour; an environment declaring a `workloadProfiles` array
// (which `aca-environment.bicep` does, and which is the default for current API
// versions) is a workload-profiles environment, and there DNS for the internal
// ingress default domain is the template's job.
//
// Getting this wrong is silent in exactly the way the Key Vault zone note in
// `privatedns.bicep` describes. Every control-plane surface looks healthy — the
// environment provisions Succeeded, the app reports Running with a plausible
// internal FQDN, `EDGE_EGRESS_URL` is built correctly from that FQDN, the
// subnets route fine (a raw TCP connect to the environment's static IP from the
// caller's subnet succeeds) — and the name still does not resolve from inside
// the VNet, because nothing anywhere holds a record for it. Hit for real: the
// edge→egress hop failed with `getaddrinfo ENOTFOUND` on every LLM call, which
// reached the browser as a generic in-band SSE `"LLM request failed"`.
//
// A single wildcard A record covers every app in the environment: DNS wildcards
// synthesise for multi-label names (RFC 4592), so `*` answers for the
// two-label `<app>.internal` prefix that internal ACA ingress uses.

@description('The environment\'s default domain — becomes the zone name (e.g. nicedune-d5224641.westus3.azurecontainerapps.io).')
param environmentDefaultDomain string

@description('The environment\'s static IP — every app in it resolves here.')
param environmentStaticIp string

@description('Resource id of the VNet that must be able to resolve the zone.')
param vnetId string

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: environmentDefaultDomain
  location: 'global'
}

// Both ACA environments share one VNet, so linking here is what lets apps in the
// *apps* environment resolve apps in the *egress* environment.
resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: zone
  name: 'link-to-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnetId }
  }
}

resource wildcard 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '*'
  properties: {
    ttl: 3600
    aRecords: [
      { ipv4Address: environmentStaticIp }
    ]
  }
}

output zoneId string = zone.id
output zoneName string = zone.name
