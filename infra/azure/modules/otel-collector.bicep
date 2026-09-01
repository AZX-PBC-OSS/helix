// otel-collector.bicep — the OTLP destination for one Container Apps environment.
//
// ADR-0037 keeps every service speaking OTLP and nothing else; this is where the
// Azure knowledge lives. Decision 2 preferred the ACA **managed** OpenTelemetry
// agent and told us to verify it first. We did (ADR Amendment 7) and it is not
// usable here: its Application Insights destination does not accept metrics, and
// it only speaks gRPC while `packages/telemetry` exports OTLP/HTTP. So this is
// the ADR's documented fallback — and the service-side code is byte-identical
// either way, which is what made that reversal free.
//
// One collector per managed environment, mirroring how each environment already
// gets its own Log Analytics workspace. The alternative — one collector reached
// across environments — depends on cross-environment private DNS resolution for
// an internal ingress, which is exactly the class of thing the README's Key
// Vault private-DNS gotcha says is "silent in every place you would look".
// Both collectors export to the same Application Insights component, so a trace
// that crosses edge → egress still lands in one place.

@description('Azure region.')
param location string

@description('Container app name.')
param name string

@description('Managed environment id to deploy into.')
param environmentId string

@description('User-assigned managed identity resource id (image pull; the App Insights export authenticates with the connection string, not this identity).')
param userAssignedIdentityId string

@description('Application Insights connection string. Contains an instrumentation key, which Microsoft documents as not a secret — but it is passed as a secret anyway so it never lands in ARM deployment history.')
@secure()
param appInsightsConnectionString string

@description('Collector image. MCR rather than Docker Hub deliberately: `mcr.microsoft.com` and `*.data.mcr.microsoft.com` are already on the egress firewall allowlist, so this pulls without widening it. NOTE the MCR mirror entrypoint is `otelcontribcol`, NOT upstream\'s `/otelcol-contrib` — verified against the image config; the upstream name produces a container that never starts.')
param image string = 'mcr.microsoft.com/oss/v2/otel/opentelemetry-collector-contrib:v0.148.0-9'

@description('Minimum replicas. Must be >= 1: a scaled-to-zero collector drops the spans that would have woken it, and OTLP export failures are deliberately silent (ADR-0037 decision 5).')
@minValue(1)
param minReplicas int = 1

@description('Maximum replicas.')
param maxReplicas int = 2

/*
  The collector config, inlined and passed through an env var.

  `--config=env:NAME` is a first-class collector source, and it is what makes
  this a pure Bicep change: the alternative is baking a config file into a
  custom image, which would mean a second image to build, tag and publish for a
  file that is nine lines of YAML.

  METRICS ARE ACCEPTED AND DISCARDED, on purpose and temporarily. Application
  Insights cannot store OTel metrics at all (ADR Amendment 7), and choosing the
  real destination — an Azure Monitor workspace, a non-Azure backend, or a
  translation into Log Analytics — is an open decision tracked in TODO.md. The
  `nop` exporter is deliberate rather than an omission: with no metrics pipeline
  the OTLP receiver rejects every metrics POST, and each service would log an
  export warning once per interval forever. Discarding quietly here is honest
  about the state and quiet in the logs; the pipeline is the one line to change
  once the destination exists.
*/
var collectorConfig = '''
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
processors:
  # Bound the collector's own memory before the batcher queues into it: a
  # destination outage must degrade to dropped spans, never to an OOM loop.
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 25
  batch: {}
exporters:
  azuremonitor:
    connection_string: ${env:APPLICATIONINSIGHTS_CONNECTION_STRING}
  nop: {}
service:
  telemetry:
    logs:
      level: warn
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [azuremonitor]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter]
      exporters: [nop]
'''

module collector 'containerapp.bicep' = {
  name: 'aca-${name}'
  params: {
    location: location
    name: name
    environmentId: environmentId
    userAssignedIdentityId: userAssignedIdentityId
    image: image
    targetPort: 4318
    // Internal only. Nothing outside the VNet has any business posting spans,
    // and the OTLP receiver is unauthenticated.
    external: false
    cpuCores: '0.5'
    memory: '1Gi'
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    command: [
      'otelcontribcol'
      '--config=env:OTEL_COLLECTOR_CONFIG'
    ]
    envVars: [
      { name: 'OTEL_COLLECTOR_CONFIG', value: collectorConfig }
      {
        name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
        secretRef: 'appinsights-connection-string'
      }
    ]
    secretValues: {
      'appinsights-connection-string': appInsightsConnectionString
    }
  }
}

@description('The OTLP/HTTP base endpoint services set as OTEL_EXPORTER_OTLP_ENDPOINT. https:// — ACA internal ingress terminates TLS, and this matches the app-to-app convention already used for EDGE_EGRESS_URL. Do not "simplify" it to http://: internal ingress does not serve plaintext, and an export failure here is silent.')
output otlpEndpoint string = 'https://${collector.outputs.fqdn}'
output collectorFqdn string = collector.outputs.fqdn
