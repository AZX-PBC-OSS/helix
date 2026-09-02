// main.bicep — Helix on Azure (M5). Resource-group-scoped orchestrator.
//
// Stands up the three-plane platform (architecture §3) on Azure Container Apps:
//   - networking with the egress-zone isolation enforced by firewall + UDRs
//   - private Postgres / Blob / Key Vault (×2), all behind private endpoints
//     (app images are pulled from public GHCR, so there is no private registry)
//   - four user-assigned identities with a least-privilege RBAC matrix (the
//     fourth, dev-gateway, is idle unless deployDevGateway is set)
//   - two ACA environments + the edge / portal / egress container apps, plus the
//     opt-in dev-gateway (edge image, helix_dev role) when deployDevGateway=true
//   - the public DNS zone for the apps domain
//
// Two-phase deploy (see README): apply once with deployApps=false to build the
// infra, ensure the three app images are published to GHCR (CI does this), then
// apply with deployApps=true to roll out the apps.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Resource name prefix, e.g. "helix-prod".')
param namePrefix string = 'helix-prod'


@description('Globally-unique storage account name (3-24 lowercase alphanumerics).')
param storageAccountName string

@description('Globally-unique platform Key Vault name (3-24 chars).')
param platformVaultName string

@description('Globally-unique connections Key Vault name (3-24 chars).')
param connectionsVaultName string

@description('Postgres flexible server name (globally unique, lowercase).')
param postgresServerName string

@description('Postgres compute SKU (e.g. Standard_B1ms/B2s burstable, Standard_D2ds_v5 general purpose).')
param postgresSkuName string = 'Standard_D2ds_v5'

@description('Postgres compute tier. Must match the SKU family: Burstable | GeneralPurpose | MemoryOptimized.')
param postgresSkuTier string = 'GeneralPurpose'

@description('Postgres storage size in GB.')
param postgresStorageSizeGB int = 32

@description('Public apps domain, e.g. azx.helix.azxlabs.io.')
param appsDomain string = 'azx.helix.azxlabs.io'

@description('Display-only month-to-date platform spend watch line in USD, surfaced on the admin Activity page via GET /api/v1/config. Defaults to 1000 so an install gets a budget signal without being configured for one; set 0 to show no ceiling. Nothing enforces this — per-app daily token budgets are the real limit.')
param platformMonthlyUsdCap int = 1000

@description('Max uncompressed size in MB of any single file in a deployed bundle.')
param deployMaxFileMb int = 50

@description('Max total size in MB of a deployed bundle — uncompressed across all files, and also the cap on the compressed upload. The portal spools that upload to its replica temp disk, so raising this past a few hundred MB wants a matching cpu/memory bump on the portal container app (ephemeral storage scales with them).')
param deployMaxBundleMb int = 250

@description('Blob container for app bundles.')
param blobContainerName string = 'app-bundles'

// Postgres credentials. The admin owns the schema + runs migrations (== the dev
// `helix` owner); it is NOT handed to any runtime container. The portal/edge/egress
// containers connect as the least-privilege runtime roles, which the post-deploy
// role SQL creates with these same passwords.
//
// The admin password is used to provision the server AND stored in kv-platform, so
// the migration job can fetch it with its own managed identity instead of CI holding
// it (see modules/migrate-job.bicep). Both are fed this same parameter in one apply,
// so the server and the stored copy cannot drift.
@description('Postgres administrator login.')
param postgresAdminLogin string = 'helixadmin'
@secure()
@description('Postgres administrator password.')
param postgresAdminPassword string
@secure()
@description('Password for the helix_portal runtime role.')
param portalDbPassword string
@secure()
@description('Password for the helix_edge runtime role.')
param edgeDbPassword string
@secure()
@description('Password for the helix_egress runtime role.')
param egressDbPassword string
@secure()
@description('Password for the helix_dev runtime role (dev-gateway). Only needed when deployDevGateway=true.')
param devDbPassword string = ''

// Symmetric platform secrets (base64, >= 32 bytes). Generate with
// `openssl rand -base64 48`.
@secure()
@description('EDGE_AUTH_SECRET — session/handoff HKDF root.')
param edgeAuthSecret string
@secure()
@description('PORTAL_SECRET — shared-password AES-GCM key.')
param portalSecret string
@secure()
@description('HELIX_INSTRUCTION_SECRET — shared edge<->egress attestation key.')
param instructionSecret string
// The tenant blocks symmetric client secrets, so the edge authenticates to Entra
// with a certificate (private_key_jwt). Both halves travel as PEM (or base64
// PEM); the public cert is also uploaded to the edge app registration.
@secure()
@description('EDGE_OIDC_CLIENT_PRIVATE_KEY — edge cert private key (PEM or base64 PEM).')
param edgeOidcPrivateKey string
@secure()
@description('EDGE_OIDC_CLIENT_CERTIFICATE — edge cert (PEM or base64 PEM).')
param edgeOidcCertificate string

// Entra / OIDC configuration (the real app registration is an operator step —
// or the infra/entra Bicep). See docs/runbooks/entra-app-registration.md.
@description('Entra tenant id (for the OIDC issuer URL).')
param entraTenantId string = tenant().tenantId
@description('Edge OIDC client id (Entra app registration).')
param edgeOidcClientId string
@description('Portal OIDC audience — the bare helix-portal client-id GUID. v2 access tokens carry the client id as aud, not the api:// URI.')
param portalOidcAudience string
@description('Portal admin gate — the App Role value (e.g. "platform-admin") assigned in Entra. A group object id also works if gating on groups.')
param portalAdminGroupId string
@description('Public CLI client id (Entra azx-cli registration) advertised for OIDC discovery.')
param azxCliClientId string
@description('Public web SPA client id (Entra helix-portal registration) advertised for OIDC discovery.')
param azxWebClientId string

@description('LLM upstream endpoint for the edge gateway.')
param llmEndpoint string = 'https://api.anthropic.com'

// Image references (phase 2). Repo names are fixed; registry + tag are parameterized.
// The three app images are built and published by this repo's CI to GHCR
// (docker/metadata-action lowercases the owner). Override imageRegistry for a fork.
@description('Registry + owner holding the GHCR-built images, e.g. ghcr.io/azx-pbc-oss.')
param imageRegistry string = 'ghcr.io/azx-pbc-oss'

@description('Container image tag to deploy for all three apps.')
param imageTag string = 'latest'

@description('Phase gate: false = infra only; true = also deploy the container apps.')
param deployApps bool = false

@description('Opt-in dev-gateway (dev-mode design §3): the cross-origin dev surface on dev-api.<appsDomain>, run as helix_dev. Off by default — enabling it needs the helix_dev role + password (README step 4) and the pre-deploy riders in docs/features/dev-mode.md. Only takes effect together with deployApps=true.')
param deployDevGateway bool = false

@description('Deploy the OpenTelemetry collector + Application Insights (ADR-0037). Off leaves every service exporting nowhere — `startTelemetry` returns its inert handle — which is the platform\'s documented default state and exactly how it ran before this existed.')
param deployTelemetry bool = true

@description('Deploy the alert rules that consume the platform\'s own observability — the registry projection stale + never-loaded rules (ADR-0025 residual, ADR-0037). Default true: they are the near-term payoff of the telemetry work and cost cents. The stale rule reads a metric so it needs deployTelemetry; the never-loaded rule is log-based and deploys either way. NOTE with alertEmails empty the rules still deploy and still fire — into nothing. Set alertEmails, or set this false; a rule nobody is told about is worse than no rule, because it looks like coverage.')
param deployAlerts bool = true

@description('Addresses notified when an alert fires. SEVERAL ARE SUPPORTED — each becomes its own email receiver on one shared action group, e.g. \'["a@x.io","b@x.io"]\' (or `--parameters alertEmails="[\'a@x.io\']"` from the CLI). Empty means the rules notify nobody.')
param alertEmails array = []

@description('Registry staleness that fires the alert, in ms. Default 1200000 (20 min) is the ADR-0025 `error` line — 20x the 60s default reconcile interval, the point the edge itself stops calling the projection merely degraded. 300000 fires at the `degraded` line instead, at the cost of noise from transient DB blips.')
param registryStalenessThresholdMs int = 1200000

@description('Deploy the Azure Firewall that enforces the egress-only network zone (ADR-0001) — the PRIMARY SSRF/egress control per ADR-0005. Default true (secure by default). Setting false SKIPS the firewall + its forced-tunnel routes to save ~$900/mo: the apps subnet then gets default internet egress, so a compromised edge can reach the internet and the only remaining outbound control is the egress app-level denylist (defense-in-depth). Data services stay private (private endpoints) either way. Only disable for dev / smoketest / trusted single-tenant installs — NOT production or untrusted-app hosting. See README "Optional: the egress firewall".')
param deployFirewall bool = true

@description('Log verbosity for all four services (pino levels: fatal|error|warn|info|debug|trace|silent). Sets LOG_LEVEL, which every service reads unless its own <PREFIX>_LOG_LEVEL overrides it — so this one line raises the whole platform, and a per-service override raises just the noisy one. Applied per revision: changing it rolls a new ACA revision rather than taking effect on the running one. NOTE debug/trace on the edge is a data-exposure decision as much as a volume one — this stdout is retained in Log Analytics for 30 days.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
param logLevel string = 'info'

@description('Deploy the certbot wildcard-TLS automation job (apps/certbot, ADR-0029): a scheduled Container Apps Job that issues/renews the *.<appsDomain> Let\'s Encrypt cert via DNS-01 and binds the edge wildcard custom domain. Requires acmeEmail. Only takes effect with deployApps=true.')
param deployCertbot bool = true

@description('ACME registration / expiry-notice email for the wildcard cert. REQUIRED for wildcard TLS — certbot is skipped when this is empty.')
param acmeEmail string = ''

@description('ACME directory URL. Default = Let\'s Encrypt STAGING (untrusted cert, high rate limits); set the prod directory (https://acme-v02.api.letsencrypt.org/directory) once the flow is validated.')
param acmeServer string = 'https://acme-staging-v02.api.letsencrypt.org/directory'

@description('Expose the portal on the public LB at portal.<appsDomain>, gated by Entra OIDC (portal audience + platform-admin App Role). Default false (internal ingress — secure by default). The portal is the control plane + the azx-cli target, so a customer-run install (ADR-0028) generally needs it reachable; per-app authz is enforced by ownsApp (ADR-0007, issue #9 closed), and identity/device posture is the perimeter (Conditional Access), not network location. When true the certbot job also binds portal.<appsDomain>. See README "Portal access".')
param portalExternal bool = false

@description('Permit `public` (anonymous) apps on this install. Sets the matched pair EDGE_ALLOW_PUBLIC_APPS + PORTAL_ALLOW_PUBLIC_APPS — one param because the two planes MUST agree: the portal gates setting the visibility and the edge gates serving it, so a split leaves apps the portal accepts but the edge 403s. Default false (deny — the app-level default too). Review ADR-0010 (anonymous shared writes) before enabling.')
param allowPublicApps bool = false

@description('Permit `password` (shared-passphrase) apps on this install. Sets the matched pair EDGE_ALLOW_PASSWORD_APPS + PORTAL_ALLOW_PASSWORD_APPS — same paired-planes reasoning as allowPublicApps; when false the edge 403s the assets and the /_auth/login challenge 404s. Default false (deny).')
param allowPasswordApps bool = false

@description('Fastify trustProxy for the edge (EDGE_TRUST_PROXY) — the ADDRESS of the trusted ingress, as a CIDR/IP list or a proxy-addr preset ("uniquelocal"). Behind ACA Envoy ingress req.ip is the ingress hop unless this names it, collapsing per-IP rate limits + the login throttle into one bucket (issue #13). Three cases: "auto" (the default) resolves to the ACA infrastructure subnet the edge runs in, which is the trusted peer; EMPTY or "false" trusts nothing (the socket peer is the client), matching the code default; anything else passes through verbatim. A hop COUNT is no longer valid: fastify 5.12.1 removed it (GHSA-3m5p-2c4r-xxw2) because trusting by position ignores the peer address, the edge refuses to boot on one, and this template rejects one before it deploys. Re-verify if anything else fronts the edge (CDN, WAF, second proxy): too narrow collapses every client into one bucket, too broad makes X-Forwarded-For spoofable.')
param edgeTrustProxy string = 'auto'

@description('ACA custom-domain verification id (asuid TXT). Empty = skip.')
param domainVerificationId string = ''

var oidcIssuer = '${az.environment().authentication.loginEndpoint}${entraTenantId}/v2.0'

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

module routing 'modules/routing.bicep' = {
  name: 'routing'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    location: location
    namePrefix: namePrefix
    appsRouteTableId: routing.outputs.appsRouteTableId
    egressRouteTableId: routing.outputs.egressRouteTableId
  }
}

// The trusted-proxy address handed to the edge and the dev-gateway. Fastify
// derives req.ip by walking [socket peer, ...x-forwarded-for reversed] and
// stopping at the first address this does NOT match, so it must name the ACA
// ingress — which reaches the container from inside its own infrastructure
// subnet. 'auto' resolves to that subnet rather than hardcoding a CIDR, which
// keeps it correct if the address space is ever re-planned in network.bicep.
// Override edgeTrustProxy when something else fronts the edge (CDN, WAF, second
// proxy). EMPTY is not 'auto': it means trust nothing, the same as the code
// default, so an operator who deliberately blanks this still gets it off.
var trustProxyRaw = trim(edgeTrustProxy)

// Reject a stale hop count (a HELIX_EDGE_TRUST_PROXY=1 still exported by a
// deploy pipeline) in front of the operator: it would otherwise reach
// parseTrustProxy and throw at container boot, which under activeRevisionsMode
// 'Single' is a rollout that silently never takes. fail() sits in the untaken
// branch of a ternary, which ARM evaluates lazily -- and only on an apply that
// deploys the apps, since both EDGE_TRUST_PROXY sites are deployApps-conditional
// (README step 1 gives the operator an `echo` for the infra-only phase).
//
// Deliberately coarse: a usable value carries '.' (IPv4/CIDR) or ':' (IPv6), or
// is a preset or a boolean. Catching a typo that passes that ('10.0.2', which
// proxy-addr reads as the single host 10.0.0.2) is parseTrustProxy's zod check --
// the copy a customer-run install (ADR-0028) gets anyway, and the only one that
// can hold a precise grammar without drifting from proxy-addr's. Presets match
// per comma-separated part, since fastify splits the list before proxy-addr sees
// it; the booleans stay whole values, because parseTrustProxy maps them to a real
// boolean and proxy-addr would choke on 'true' as an address. Case-SENSITIVE,
// like both of those.
var trustProxyPresets = ['loopback', 'linklocal', 'uniquelocal']
var trustProxyParts = map(split(trustProxyRaw, ','), part => trim(part))
var trustProxyIsAddress = contains(trustProxyRaw, '.') || contains(trustProxyRaw, ':') || contains(
  ['true', 'false'],
  trustProxyRaw
) || empty(filter(trustProxyParts, part => !contains(trustProxyPresets, part)))
var effectiveEdgeTrustProxy = trustProxyRaw == 'auto'
  ? network.outputs.appsSubnetPrefix
  : (empty(trustProxyRaw) || trustProxyIsAddress)
      ? trustProxyRaw
      : fail(
          'edgeTrustProxy names the ADDRESS of the trusted ingress, not a hop count (got "${trustProxyRaw}"). Fastify 5.12.1 removed the hop-count form (GHSA-3m5p-2c4r-xxw2) and the edge no longer honours one (it refuses to boot on a count of 1 or more; "0" it reads as its old meaning, trust nothing). Leave it "auto" (or unset HELIX_EDGE_TRUST_PROXY) to trust the ACA infrastructure subnet, pass a CIDR/IP list or a proxy-addr preset such as "uniquelocal" to name a different ingress, or "" / "false" to trust nothing.'
        )

// The egress-zone enforcement point (ADR-0001 / ADR-0005). Optional: when
// deployFirewall=false the firewall and its forced-tunnel default routes are
// skipped, leaving the app subnets with default internet egress (see the param
// doc + README for the security trade-off). The route tables themselves stay
// (created empty in routing.bicep) — an empty UDR is a no-op, so both subnets
// fall back to system routing.
module firewall 'modules/firewall.bicep' = if (deployFirewall) {
  name: 'firewall'
  params: {
    location: location
    namePrefix: namePrefix
    firewallSubnetId: network.outputs.firewallSubnetId
    appsSubnetPrefix: network.outputs.appsSubnetPrefix
    egressSubnetPrefix: network.outputs.egressSubnetPrefix
    appsRouteTableName: routing.outputs.appsRouteTableName
    egressRouteTableName: routing.outputs.egressRouteTableName
  }
}

module privateDns 'modules/privatedns.bicep' = {
  name: 'privatedns'
  params: {
    namePrefix: namePrefix
    vnetId: network.outputs.vnetId
  }
}

// ---------------------------------------------------------------------------
// Managed dependencies (all private)
// ---------------------------------------------------------------------------

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    storageAccountName: storageAccountName
    containerName: blobContainerName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    blobPrivateDnsZoneId: privateDns.outputs.blobZoneId
  }
}

module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    platformVaultName: platformVaultName
    connectionsVaultName: connectionsVaultName
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    keyVaultPrivateDnsZoneId: privateDns.outputs.keyVaultZoneId
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    serverName: postgresServerName
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdminPassword
    delegatedSubnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: privateDns.outputs.postgresZoneId
    databaseName: 'helix'
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageSizeGB: postgresStorageSizeGB
  }
}

// ---------------------------------------------------------------------------
// Identities + RBAC
// ---------------------------------------------------------------------------

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module rbac 'modules/rbac.bicep' = {
  name: 'rbac'
  params: {
    storageAccountName: storage.outputs.storageAccountName
    platformVaultName: keyvault.outputs.platformVaultName
    connectionsVaultName: keyvault.outputs.connectionsVaultName
    edgePrincipalId: identity.outputs.edgeIdentityPrincipalId
    portalPrincipalId: identity.outputs.portalIdentityPrincipalId
    egressPrincipalId: identity.outputs.egressIdentityPrincipalId
    devPrincipalId: identity.outputs.devIdentityPrincipalId
  }
}

// ---------------------------------------------------------------------------
// Platform secrets (kv-platform). ARM-plane writes bypass the vault firewall.
// ---------------------------------------------------------------------------

var pgFqdn = postgres.outputs.serverFqdn
var edgeDbConn = 'postgresql://helix_edge:${edgeDbPassword}@${pgFqdn}:5432/helix?sslmode=require'
var egressDbConn = 'postgresql://helix_egress:${egressDbPassword}@${pgFqdn}:5432/helix?sslmode=require'
// The portal runtime connects as the least-privilege helix_portal role, NOT the
// schema owner (ADR-0002): full DML but no owner/superuser RLS bypass and no
// DDL. Migrations run as the admin out-of-band (README step 4), so the admin DSN
// never reaches a container or kv-platform.
var portalDbConn = 'postgresql://helix_portal:${portalDbPassword}@${pgFqdn}:5432/helix?sslmode=require'
// helix_dev DSN — written to kv-platform only when the opt-in dev-gateway is
// deployed (kv-secrets skips an empty value).
var devDbConn = deployDevGateway
  ? 'postgresql://helix_dev:${devDbPassword}@${pgFqdn}:5432/helix?sslmode=require'
  : ''

module platformSecrets 'modules/kv-secrets.bicep' = {
  name: 'platform-secrets'
  params: {
    vaultName: platformVaultName
    edgeDatabaseUrl: edgeDbConn
    egressDatabaseUrl: egressDbConn
    portalDatabaseUrl: portalDbConn
    edgeAuthSecret: edgeAuthSecret
    portalSecret: portalSecret
    instructionSecret: instructionSecret
    edgeOidcPrivateKey: edgeOidcPrivateKey
    edgeOidcCertificate: edgeOidcCertificate
    edgeDevDatabaseUrl: devDbConn
    postgresAdminPassword: postgresAdminPassword
  }
  dependsOn: [
    keyvault
  ]
}

var connectionsVaultUri = keyvault.outputs.connectionsVaultUri

// ---------------------------------------------------------------------------
// ACA environments (two zones)
// ---------------------------------------------------------------------------

module appsEnv 'modules/aca-environment.bicep' = {
  name: 'aca-apps-env'
  params: {
    location: location
    name: '${namePrefix}-apps-env'
    infrastructureSubnetId: network.outputs.appsSubnetId
    internal: false // public inbound LB so the edge can take external ingress
  }
  dependsOn: [
    firewall // routes must exist before the env wires up egress
  ]
}

module egressEnv 'modules/aca-environment.bicep' = {
  name: 'aca-egress-env'
  params: {
    location: location
    name: '${namePrefix}-egress-env'
    infrastructureSubnetId: network.outputs.egressSubnetId
    internal: true // never publicly routable; only the edge (in-VNet) reaches it
  }
  dependsOn: [
    firewall
  ]
}

// ---------------------------------------------------------------------------
// Telemetry destination (ADR-0037)
// ---------------------------------------------------------------------------
// Services speak OTLP and only OTLP; the Azure knowledge lives here. The ACA
// managed OpenTelemetry agent was the ADR's first choice and was verified and
// rejected (Amendment 7): its App Insights destination cannot store metrics,
// and it only speaks gRPC while the services export OTLP/HTTP. So: a
// self-hosted collector per environment, both exporting to one App Insights.
//
// TRACES AND METRICS, both to that one component. Amendment 7's "App Insights
// cannot accept OTel metrics" was true of the managed agent's destination and
// over-generalised: the contrib `azuremonitor` exporter stores metrics in
// `customMetrics` (Amendment 8), so the instruments the services already emit
// have a home, and `alerts.bicep` below is the consumer ADR-0025 was waiting
// for. An Azure Monitor workspace is still the better long-term store — it is
// what metric alert rules and Grafana key on — and is tracked in TODO.md as a
// strictly additive change.

// Workspace-based, attached to the workspace the apps environment already ships
// stdout to: one place to correlate a trace with the log lines around it, and
// no second retention setting to keep in sync.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = if (deployTelemetry && deployApps) {
  name: '${namePrefix}-appi'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: appsEnv.outputs.logAnalyticsWorkspaceId
    // The collector authenticates with the connection string, which requires
    // local auth. Entra-only auth would need the collector to hold a credential
    // and is a separate change (see the Microsoft Entra authentication note in
    // the ACA OpenTelemetry docs).
    DisableLocalAuth: false
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

module appsCollector 'modules/otel-collector.bicep' = if (deployTelemetry && deployApps) {
  name: 'otel-collector-apps'
  params: {
    location: location
    name: '${namePrefix}-otel-apps'
    environmentId: appsEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.edgeIdentityId
    appInsightsConnectionString: appInsights!.properties.ConnectionString
  }
}

module egressCollector 'modules/otel-collector.bicep' = if (deployTelemetry && deployApps) {
  name: 'otel-collector-egress'
  params: {
    location: location
    name: '${namePrefix}-otel-egress'
    environmentId: egressEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.egressIdentityId
    appInsightsConnectionString: appInsights!.properties.ConnectionString
  }
}

// The consumer for all of the above. Scoped to the apps environment's Log
// Analytics workspace, which holds both the container stdout and — because the
// component above is workspace-based onto it — the metrics. See
// modules/alerts.bicep for why one rule reads a metric and the other a log.
module alerts 'modules/alerts.bicep' = if (deployAlerts && deployApps) {
  name: 'platform-alerts'
  params: {
    location: location
    namePrefix: namePrefix
    workspaceId: appsEnv.outputs.logAnalyticsWorkspaceId
    alertEmails: alertEmails
    includeMetricRule: deployTelemetry
    registryStalenessThresholdMs: registryStalenessThresholdMs
  }
}

// The egress environment is internal, and a workload-profiles environment does
// not get an auto-created private DNS zone — without this, its apps' internal
// FQDNs resolve nowhere in the VNet and the edge→egress hop dies at DNS. See
// modules/acadns.bicep. Unconditional (not gated on `deployApps`): the zone
// belongs to the environment, and the record is the environment's static IP, so
// it is correct before any app exists and stays correct across app redeploys.
//
// The apps environment needs no equivalent — it is external, so its default
// domain resolves through public DNS.
module egressDns 'modules/acadns.bicep' = {
  name: 'aca-egress-dns'
  params: {
    environmentDefaultDomain: egressEnv.outputs.defaultDomain
    environmentStaticIp: egressEnv.outputs.staticIp
    vnetId: network.outputs.vnetId
  }
}

// ---------------------------------------------------------------------------
// Container apps (phase 2)
// ---------------------------------------------------------------------------

module egressApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'app-egress'
  params: {
    location: location
    name: '${namePrefix}-egress'
    environmentId: egressEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.egressIdentityId
    image: '${imageRegistry}/helix-egress:${imageTag}'
    targetPort: 8081
    // VNet-scope, NOT internet-scope. `external` is relative to the environment:
    // in an `internal: true` environment (which this is) it means "published on
    // the environment's internal load balancer, reachable from the VNet". The
    // environment has no public LB at all, so this cannot become publicly
    // routable — that guarantee lives on the environment, not here.
    //
    // `external: false` is the *narrower* environment-scope ingress: reachable
    // only from inside the egress environment. That reads like the safer value
    // and was the original setting, but the edge lives in a different
    // environment, so it left the egress app unreachable by its only caller —
    // envoy 404s at the ILB while the app answers 200 from inside its own
    // environment. It also renames the FQDN to `<app>.internal.<domain>`.
    external: true
    secretValues: {
      'egress-database-url': egressDbConn
      'helix-instruction-secret': instructionSecret
    }
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'LOG_LEVEL', value: logLevel }
      // OTLP destination (ADR-0037). Empty when telemetry is not deployed, which
      // leaves `startTelemetry` inert — the platform's documented default state,
      // not a broken one.
      {
        name: 'OTEL_EXPORTER_OTLP_ENDPOINT'
        value: deployTelemetry ? egressCollector!.outputs.otlpEndpoint : ''
      }
      { name: 'EGRESS_PORT', value: '8081' }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'AZURE_KEY_VAULT_URL', value: connectionsVaultUri }
      // Egress reads connection secrets from kv-connections under its own managed
      // identity. It does NOT use @azure/identity (the mechanism plane stays
      // dependency-minimal — ADR-0031); it calls the ACA identity endpoint
      // directly, and a user-assigned identity is ambiguous without the client id.
      { name: 'AZURE_CLIENT_ID', value: identity.outputs.egressIdentityClientId }
      { name: 'EGRESS_DATABASE_URL', secretRef: 'egress-database-url' }
      { name: 'HELIX_INSTRUCTION_SECRET', secretRef: 'helix-instruction-secret' }
    ]
  }
  dependsOn: [
    rbac
    platformSecrets
  ]
}

module edgeApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'app-edge'
  params: {
    location: location
    name: '${namePrefix}-edge'
    environmentId: appsEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.edgeIdentityId
    image: '${imageRegistry}/helix-edge:${imageTag}'
    targetPort: 8080
    external: true
    secretValues: {
      'edge-database-url': edgeDbConn
      'edge-oidc-private-key': edgeOidcPrivateKey
      'edge-oidc-certificate': edgeOidcCertificate
      'edge-auth-secret': edgeAuthSecret
      'helix-instruction-secret': instructionSecret
    }
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'LOG_LEVEL', value: logLevel }
      // OTLP destination (ADR-0037). Empty when telemetry is not deployed, which
      // leaves `startTelemetry` inert — the platform's documented default state,
      // not a broken one.
      {
        name: 'OTEL_EXPORTER_OTLP_ENDPOINT'
        value: deployTelemetry ? appsCollector!.outputs.otlpEndpoint : ''
      }
      { name: 'PORT', value: '8080' }
      { name: 'HOST', value: '0.0.0.0' }
      // The port the edge LISTENS on (PORT, above) is not the port the world
      // reaches it on: ACA's ingress terminates TLS at 443 and forwards to 8080.
      // publicOrigin() builds every externally visible URL from publicPort and
      // omits it only when it is 443 — and publicPort falls back to PORT — so
      // without this the edge advertises `https://auth.<domain>:8080/callback`,
      // which fails Entra's redirect-URI match (AADSTS50011) and, more quietly,
      // breaks the per-app Origin check in auth/validate.ts for every app.
      { name: 'EDGE_PUBLIC_PORT', value: '443' }
      { name: 'EDGE_BASE_DOMAIN', value: appsDomain }
      { name: 'BLOB_CONTAINER', value: blobContainerName }
      // Blob reads via managed identity (issue #15) — no account key. AZURE_CLIENT_ID
      // selects the user-assigned identity for the AAD token fetch; IDENTITY_ENDPOINT/
      // IDENTITY_HEADER are injected by Container Apps.
      { name: 'AZURE_CLIENT_ID', value: identity.outputs.edgeIdentityClientId }
      { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.outputs.blobEndpoint }
      { name: 'EDGE_OIDC_ISSUER', value: oidcIssuer }
      { name: 'EDGE_OIDC_CLIENT_ID', value: edgeOidcClientId }
      // Security groups (the `groups` claim), NOT App Roles — ADR-0040 decision 1.
      // Pairs with `groupMembershipClaims: 'SecurityGroup'` on the edge registration
      // (../entra/main.bicep): change both or neither. While this said `roles` and
      // that registration declared no app roles, the claim was empty for every user,
      // so `visibility: group` denied 100% of them — the app's owner included.
      // Redundant with the code default (apps/edge/src/config.ts) and kept explicit
      // anyway: an empty group claim fails silently, and this is the line you grep
      // for when it does.
      { name: 'EDGE_OIDC_GROUPS_CLAIM', value: 'groups' }
      { name: 'EDGE_OIDC_SCOPES', value: 'openid profile email' }
      // Operator visibility policy — the serving half of the pair (the portal
      // holds the authoring half). The app parses these STRICTLY (`=== "true"`),
      // and ARM's string(bool) yields 'True' — which would silently read as
      // false — so emit the lowercase literal explicitly. Same reason
      // EDGE_ALLOW_DEV_MODE below is a literal.
      { name: 'EDGE_ALLOW_PUBLIC_APPS', value: allowPublicApps ? 'true' : 'false' }
      { name: 'EDGE_ALLOW_PASSWORD_APPS', value: allowPasswordApps ? 'true' : 'false' }
      { name: 'EDGE_LLM_ENDPOINT', value: llmEndpoint }
      // Behind ACA's Envoy ingress the socket peer is the ingress, so the
      // per-IP anon rate limiter and the password-login throttle need the
      // ingress address named to recover the real client IP (issue #13). See
      // edgeTrustProxy / effectiveEdgeTrustProxy.
      { name: 'EDGE_TRUST_PROXY', value: effectiveEdgeTrustProxy }
      { name: 'EDGE_EGRESS_URL', value: 'https://${egressApp.?outputs.fqdn ?? ''}' }
      { name: 'EDGE_DATABASE_URL', secretRef: 'edge-database-url' }
      // Certificate (private_key_jwt) client auth — the tenant blocks secrets.
      { name: 'EDGE_OIDC_CLIENT_PRIVATE_KEY', secretRef: 'edge-oidc-private-key' }
      { name: 'EDGE_OIDC_CLIENT_CERTIFICATE', secretRef: 'edge-oidc-certificate' }
      { name: 'EDGE_AUTH_SECRET', secretRef: 'edge-auth-secret' }
      { name: 'HELIX_INSTRUCTION_SECRET', secretRef: 'helix-instruction-secret' }
    ]
  }
  dependsOn: [
    rbac
    platformSecrets
  ]
}

module portalApp 'modules/containerapp.bicep' = if (deployApps) {
  name: 'app-portal'
  params: {
    location: location
    name: '${namePrefix}-portal'
    environmentId: appsEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.portalIdentityId
    image: '${imageRegistry}/helix-portal:${imageTag}'
    targetPort: 3001
    external: portalExternal // internal by default; portalExternal exposes it on the public LB (Entra-gated)
    secretValues: {
      'portal-database-url': portalDbConn
      'portal-secret': portalSecret
    }
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'LOG_LEVEL', value: logLevel }
      // OTLP destination (ADR-0037). Empty when telemetry is not deployed, which
      // leaves `startTelemetry` inert — the platform's documented default state,
      // not a broken one.
      {
        name: 'OTEL_EXPORTER_OTLP_ENDPOINT'
        value: deployTelemetry ? appsCollector!.outputs.otlpEndpoint : ''
      }
      { name: 'PORTAL_PORT', value: '3001' }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'BLOB_CONTAINER', value: blobContainerName }
      // Blob writes via managed identity (issue #15) — no account key. AZURE_CLIENT_ID
      // selects the user-assigned identity for DefaultAzureCredential.
      { name: 'AZURE_CLIENT_ID', value: identity.outputs.portalIdentityClientId }
      { name: 'AZURE_STORAGE_BLOB_ENDPOINT', value: storage.outputs.blobEndpoint }
      { name: 'PORTAL_OIDC_ISSUER', value: oidcIssuer }
      { name: 'PORTAL_OIDC_AUDIENCE', value: portalOidcAudience }
      { name: 'PORTAL_ADMIN_GROUP_ID', value: portalAdminGroupId }
      { name: 'AZX_CLI_CLIENT_ID', value: azxCliClientId }
      { name: 'AZX_WEB_CLIENT_ID', value: azxWebClientId }
      // Operator visibility policy — the authoring half of the pair (the edge
      // holds the serving half). visibilityPolicy.ts parses strictly `=== "true"`,
      // so emit the lowercase literal, NOT string(bool) — ARM renders that as
      // 'True', which reads as false.
      { name: 'PORTAL_ALLOW_PUBLIC_APPS', value: allowPublicApps ? 'true' : 'false' }
      { name: 'PORTAL_ALLOW_PASSWORD_APPS', value: allowPasswordApps ? 'true' : 'false' }
      // Deployment topology, served to the prebuilt portal SPA at runtime by
      // GET /api/v1/config — the bundle is baked into this image, so anything it
      // burned in at build time would be wrong in every environment but one.
      { name: 'APP_PUBLIC_BASE', value: 'https://${appsDomain}' }
      // Empty when the opt-in dev gateway isn't deployed; the portal reads that
      // as "not enabled" and the SPA hides the dev-mode API base accordingly.
      {
        name: 'DEV_API_PUBLIC_BASE'
        value: deployDevGateway ? 'https://dev-api.${appsDomain}' : ''
      }
      { name: 'PLATFORM_MONTHLY_USD_CAP', value: string(platformMonthlyUsdCap) }
      { name: 'DEPLOY_MAX_FILE_MB', value: string(deployMaxFileMb) }
      { name: 'DEPLOY_MAX_BUNDLE_MB', value: string(deployMaxBundleMb) }
      { name: 'AZURE_KEY_VAULT_URL', value: connectionsVaultUri }
      // helix_portal DSN. The portal runtime reads PORTAL_DATABASE_URL and (in
      // production) refuses the DATABASE_URL owner fallback (ADR-0002,
      // resolvePortalRuntimeUrl). Migrations run as the admin out-of-band.
      { name: 'PORTAL_DATABASE_URL', secretRef: 'portal-database-url' }
      { name: 'PORTAL_SECRET', secretRef: 'portal-secret' }
    ]
  }
  dependsOn: [
    rbac
    platformSecrets
  ]
}

// The opt-in dev-gateway (dev-mode design §3): the edge image run as the
// least-privilege helix_dev role, serving the cross-origin dev surface on
// dev-api.<appsDomain> and routing to env=dev. External ingress in the apps env
// (a CORS surface for Lovable / cloud IDEs), reachable only when BOTH deployApps
// and deployDevGateway are set. See docs/features/dev-mode.md for the riders
// (a short-window throttle on the dev-gateway; a distinct dev LLM budget) before
// enabling. EDGE_TRUST_PROXY is no longer a rider — the trusted ingress address
// is passed to this container below, so a throttle here keys on the real client IP.
//
// It never holds the helix_edge pool or a blob credential: loadDevGatewayConfig
// reads ONLY the dev-gateway's own env (the helix_dev DSN + shared gateway
// config), and DevGatewayConfig structurally lacks databaseUrl/blob — so the
// container is given neither EDGE_DATABASE_URL nor any AZURE_STORAGE_* env, and
// the dev identity has no blob role. The isolation is a type property, not a
// wiring convention (dev-mode design §5.3).
module devGatewayApp 'modules/containerapp.bicep' = if (deployApps && deployDevGateway) {
  name: 'app-dev-gateway'
  params: {
    location: location
    name: '${namePrefix}-dev-gateway'
    environmentId: appsEnv.outputs.environmentId
    userAssignedIdentityId: identity.outputs.devIdentityId
    image: '${imageRegistry}/helix-edge:${imageTag}'
    targetPort: 8082
    external: true
    command: ['pnpm', '--filter', '@azx-pbc/edge', 'start:devgw']
    secretValues: {
      'edge-dev-database-url': devDbConn
      'helix-instruction-secret': instructionSecret
    }
    envVars: [
      { name: 'NODE_ENV', value: 'production' }
      { name: 'LOG_LEVEL', value: logLevel }
      // OTLP destination (ADR-0037). Empty when telemetry is not deployed, which
      // leaves `startTelemetry` inert — the platform's documented default state,
      // not a broken one.
      {
        name: 'OTEL_EXPORTER_OTLP_ENDPOINT'
        value: deployTelemetry ? appsCollector!.outputs.otlpEndpoint : ''
      }
      { name: 'HOST', value: '0.0.0.0' }
      { name: 'EDGE_DEV_GATEWAY_PORT', value: '8082' }
      // The per-plane opt-in; the dev-gateway entrypoint exits unless this is true.
      { name: 'EDGE_ALLOW_DEV_MODE', value: 'true' }
      { name: 'EDGE_BASE_DOMAIN', value: appsDomain }
      { name: 'EDGE_LLM_ENDPOINT', value: llmEndpoint }
      { name: 'EDGE_EGRESS_URL', value: 'https://${egressApp.?outputs.fqdn ?? ''}' }
      // Inherits the same trust-proxy residual as the edge (dev-mode §5.4): the
      // dev throttle keys on the real client IP behind ingress too.
      { name: 'EDGE_TRUST_PROXY', value: effectiveEdgeTrustProxy }
      // The one DSN it holds — the least-privilege helix_dev role.
      { name: 'EDGE_DEV_DATABASE_URL', secretRef: 'edge-dev-database-url' }
      { name: 'HELIX_INSTRUCTION_SECRET', secretRef: 'helix-instruction-secret' }
    ]
  }
  dependsOn: [
    rbac
    platformSecrets
  ]
}

// ---------------------------------------------------------------------------
// Public DNS
// ---------------------------------------------------------------------------

module dns 'modules/dns.bicep' = {
  name: 'dns'
  params: {
    appsDomain: appsDomain
    edgeStaticIp: appsEnv.outputs.staticIp
    domainVerificationId: domainVerificationId
    deployDevGateway: deployDevGateway
  }
}

// ---------------------------------------------------------------------------
// Wildcard TLS automation (apps/certbot, ADR-0029). Scheduled job that issues +
// renews *.<appsDomain> via ACME DNS-01 and binds the edge wildcard custom
// domain. Bootstrap: trigger once after deploy (the cert must exist before the
// bind). Skipped without an acmeEmail.
// ---------------------------------------------------------------------------

module certbot 'modules/certbot.bicep' = if (deployApps && deployCertbot && !empty(acmeEmail)) {
  name: 'certbot'
  params: {
    location: location
    namePrefix: namePrefix
    appsDomain: appsDomain
    acaEnvName: '${namePrefix}-apps-env'
    acaEnvId: appsEnv.outputs.environmentId
    edgeAppName: '${namePrefix}-edge'
    // When the portal is external, certbot also binds portal.<appsDomain> to it.
    portalAppName: portalExternal ? '${namePrefix}-portal' : ''
    // Likewise the dev-gateway on dev-api.<appsDomain> — its own external
    // ingress needs its own binding or it serves the ACA default cert.
    devGatewayAppName: deployDevGateway ? '${namePrefix}-dev-gateway' : ''
    image: '${imageRegistry}/helix-certbot:${imageTag}'
    acmeEmail: acmeEmail
    acmeServer: acmeServer
  }
  dependsOn: [
    edgeApp
    portalApp
    devGatewayApp
    dns
  ]
}

// ---------------------------------------------------------------------------
// Prisma migrations (modules/migrate-job.bicep). A Manual job — declared here so
// it exists to be triggered, never run by the template. It reads the schema-owner
// password from kv-platform with its own identity, so neither this template's
// caller nor CI has to hold it. Gated on deployApps because it runs the portal
// image at `imageTag`.
// ---------------------------------------------------------------------------

module migrateJob 'modules/migrate-job.bicep' = if (deployApps) {
  name: 'migrate-job'
  params: {
    location: location
    namePrefix: namePrefix
    acaEnvId: appsEnv.outputs.environmentId
    platformVaultName: keyvault.outputs.platformVaultName
    platformVaultUri: keyvault.outputs.platformVaultUri
    image: '${imageRegistry}/helix-portal:${imageTag}'
    postgresHost: pgFqdn
    postgresAdminLogin: postgresAdminLogin
    postgresDatabase: postgres.outputs.databaseName
  }
  dependsOn: [
    // The password must be in the vault before the job could successfully run.
    platformSecrets
  ]
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output appsEnvStaticIp string = appsEnv.outputs.staticIp
output postgresServerFqdn string = postgres.outputs.serverFqdn
output migrateJobName string = migrateJob.?outputs.jobName ?? ''
output connectionsVaultUri string = connectionsVaultUri
output dnsNameServers array = dns.outputs.nameServers
output edgeFqdn string = edgeApp.?outputs.fqdn ?? ''
output egressFqdn string = egressApp.?outputs.fqdn ?? ''
output portalFqdn string = portalApp.?outputs.fqdn ?? ''
output devGatewayFqdn string = devGatewayApp.?outputs.fqdn ?? ''

@description('False when the alert rules deployed but reach nobody (alertEmails was empty) — the state that looks like coverage and is not. Read it after every deploy that touches alerting.')
output alertsNotify bool = alerts.?outputs.notifies ?? false
// Feeds `portalIdentityPrincipalId` on the SIBLING ../entra stack, whose second pass
// grants this identity GroupMember.Read.All on Microsoft Graph (ADR-0040 decision 4).
// The two stacks deploy in the order entra -> azure -> entra: this output is the only
// thing flowing back the other way.
output portalIdentityPrincipalId string = identity.outputs.portalIdentityPrincipalId
