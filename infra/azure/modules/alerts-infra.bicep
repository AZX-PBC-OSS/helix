// alerts-infra.bicep — the rules about the plumbing, not about Helix.
//
// `alerts.bicep` reads signals the platform emits about itself and
// `alerts-availability.bicep` probes it from outside. Both of those go quiet in
// the failures that happen BELOW the application: a Postgres server that is
// full, a container that is crash-looping, an Azure incident in the region. Each
// rule here reads a platform metric Azure emits whether or not any Helix code is
// running, which is precisely why they are worth having.
//
// All of them are metric or activity-log rules, so none of them depend on
// `deployTelemetry`: no collector, no App Insights, no OTLP. They work on an
// install that deliberately runs with telemetry off.

@description('Azure region — needed as the `targetResourceRegion` of the multi-resource rules, not as their own location (metric alerts are global).')
param location string

@description('Resource name prefix, matching the rest of the deployment.')
param namePrefix string

@description('Postgres flexible server resource id. Empty skips the two database rules.')
param postgresServerId string = ''

@description('Container app resource ids to watch for restart storms — the three planes, plus the dev-gateway when it is deployed. Empty skips the restart rule.')
param containerAppIds array = []

@description('The edge\'s container app resource id, for the 5xx rule. Empty skips it. Scoped to the edge alone: it is the only plane that terminates untrusted traffic, and the other two would need very different thresholds.')
param edgeAppId string = ''

@description('Storage used (percent) that fires the database-storage rule. 85 leaves room to act — a full Postgres stops accepting writes, and growing the disk is an operation with a maintenance window, not a click.')
param postgresStoragePercentThreshold int = 85

@description('Replica restarts within the window that count as a crash loop. Azure\'s own baseline guidance for this metric is 3. READ THE CAVEAT on the rule below before lowering it: the metric is cumulative per replica.')
param restartCountThreshold int = 3

@description('Edge 5xx responses within the window that fire the server-error rule. Deliberately not sensitive: the edge fronts UNTRUSTED APP CODE, so a single broken app returning 500s is not a platform incident. This rule is for the shape where the edge itself is failing — a missing registry projection 503ing every app host, or a dependency outage.')
param edgeServerErrorThreshold int = 100

@description('Fire an alert on Azure Service Health events (incidents and planned maintenance) affecting the subscription. Free, and the only rule here that can explain an outage none of the others caused. Requires an action group — Azure rejects an activity-log alert with no action.')
param includeServiceHealth bool = true

@description('Resource id of the shared action group, or empty. Empty deploys the metric rules with NO notification target (they still evaluate and still show in the portal) and SKIPS the Service Health rule, which Azure will not accept without an action.')
param actionGroupId string = ''

var actionGroupIds = empty(actionGroupId) ? [] : [actionGroupId]
var metricActions = [for id in actionGroupIds: { actionGroupId: id }]

// ---------------------------------------------------------------------------
// Postgres — is the server answering, and is it about to run out of disk
// ---------------------------------------------------------------------------
// Both planes hold their state here and the edge cannot even load its registry
// projection without it, so this is the one dependency whose loss takes the
// whole platform with it.
//
// `is_db_alive` is Azure's own 1/0 availability signal, emitted every minute.
// Aggregated with Maximum over 5 minutes: one healthy minute inside the window
// keeps the rule green, which is the conservative direction for a rule this
// loud. NOTE WHAT IT CANNOT SEE — a server that is stopped or deleted stops
// emitting the metric entirely, and a metric rule cannot fire on absence. That
// failure is caught from the other side, by the availability test and by
// `-alert-registry-never-loaded`.
resource pgAliveRule 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(postgresServerId)) {
  name: '${namePrefix}-alert-db-unavailable'
  location: 'global'
  properties: {
    description: 'Postgres reports itself unavailable. Every plane depends on it: the portal cannot write the registry, the edge cannot reconcile its projection, and app-data reads fail. Check the server\'s Resource Health blade first, then the maintenance/failover history.'
    // The only severity 0 in this deployment. Nothing else here takes the whole
    // platform down on its own.
    severity: 0
    enabled: true
    scopes: [postgresServerId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'DbAlive'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'is_db_alive'
          timeAggregation: 'Maximum'
          operator: 'LessThan'
          threshold: 1
        }
      ]
    }
    autoMitigate: true
    actions: metricActions
  }
}

// Storage is the classic silent killer: it fills gradually, nothing degrades,
// and then writes stop. Average over 15 minutes because the number moves slowly
// and a spike is not the interesting case.
resource pgStorageRule 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(postgresServerId)) {
  name: '${namePrefix}-alert-db-storage'
  location: 'global'
  properties: {
    description: 'Postgres storage is past ${postgresStoragePercentThreshold}%. A full server stops accepting writes — deploys, metering inserts and app-data writes all fail. Grow the disk (`postgresStorageSizeGB`) or reclaim space; storage grows, it does not shrink.'
    severity: 2
    enabled: true
    scopes: [postgresServerId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'StoragePercent'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'storage_percent'
          timeAggregation: 'Average'
          operator: 'GreaterThan'
          threshold: postgresStoragePercentThreshold
        }
      ]
    }
    autoMitigate: true
    actions: metricActions
  }
}

// ---------------------------------------------------------------------------
// Container apps — replica restart storms
// ---------------------------------------------------------------------------
// One rule across all the container apps, which a multi-resource metric alert
// allows because they are the same resource type in the same region and
// subscription. `targetResourceType` and `targetResourceRegion` are REQUIRED
// once `scopes` holds more than one resource.
//
// A crash loop is the failure an availability test sees worst: replicas keep
// being replaced, so some probes succeed and the endpoint looks flaky rather
// than broken. This reads the restarts directly.
//
// THE CAVEAT, because it will bite someone: `RestartCount` is documented as "the
// cumulative number of times the replica has restarted SINCE IT WAS CREATED".
// Aggregated with Maximum, a replica that restarted 4 times and then settled
// holds this rule open until that replica is replaced (a new revision, or a
// scale event) — it does not self-clear the way a rate would. That is why the
// threshold is a storm number from Azure's own baseline guidance rather than 1,
// and why this is severity 2 and not a page.
resource restartRule 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(containerAppIds)) {
  name: '${namePrefix}-alert-replica-restarts'
  location: 'global'
  properties: {
    description: 'A container app replica has restarted more than ${restartCountThreshold} times. Usually OOM (raise memory, or find the leak) or a boot-time config failure — check the replica\'s console logs for the exit, and remember the count is cumulative for the life of the replica.'
    severity: 2
    enabled: true
    scopes: containerAppIds
    targetResourceType: 'Microsoft.App/containerApps'
    targetResourceRegion: location
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Restarts'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'RestartCount'
          timeAggregation: 'Maximum'
          operator: 'GreaterThan'
          threshold: restartCountThreshold
        }
      ]
    }
    autoMitigate: true
    actions: metricActions
  }
}

// ---------------------------------------------------------------------------
// Edge — 5xx rate
// ---------------------------------------------------------------------------
// Read from ACA's ingress metric, not from the platform's own instruments,
// deliberately: this has to keep working when the edge is too broken to emit
// anything, which is the only state that matters here.
//
// The dimension filter lists BOTH casings of the category value. A dimension
// filter is an OR over its values and Azure does not validate them against the
// metric, so a single wrong-cased guess would produce a rule that silently never
// fires — the same failure mode as a mis-typed KQL column, and just as invisible.
resource edge5xxRule 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(edgeAppId)) {
  name: '${namePrefix}-alert-edge-5xx'
  location: 'global'
  properties: {
    description: 'The edge returned more than ${edgeServerErrorThreshold} 5xx responses in 15 minutes. A broken hosted app can do this on its own — check whether the errors are one app host or all of them before treating it as a platform incident. All of them usually means the registry projection or a gateway dependency.'
    severity: 2
    enabled: true
    scopes: [edgeAppId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.MultipleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'ServerErrors'
          criterionType: 'StaticThresholdCriterion'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          timeAggregation: 'Total'
          operator: 'GreaterThan'
          threshold: edgeServerErrorThreshold
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: [
                '5xx'
                '5XX'
              ]
            }
          ]
        }
      ]
    }
    autoMitigate: true
    actions: metricActions
  }
}

// ---------------------------------------------------------------------------
// Azure Service Health
// ---------------------------------------------------------------------------
// The rule that answers "is it us?". Activity-log alerts are free, and this is
// the only signal here that arrives BEFORE the symptom for planned maintenance.
//
// Scoped to the whole subscription, because that is the only scope Service
// Health events carry — they are not attached to individual resources. On a
// subscription that hosts more than this deployment, expect events about
// services Helix does not use; narrow it in the portal by impacted service if
// that becomes noise.
resource serviceHealthRule 'Microsoft.Insights/activityLogAlerts@2020-10-01' = if (includeServiceHealth && !empty(actionGroupId)) {
  name: '${namePrefix}-alert-service-health'
  location: 'global'
  properties: {
    description: 'Azure-reported incidents and planned maintenance affecting this subscription. The one rule here that can explain an outage none of the others caused.'
    enabled: true
    scopes: [subscription().id]
    condition: {
      allOf: [
        {
          field: 'category'
          equals: 'ServiceHealth'
        }
        {
          anyOf: [
            {
              field: 'properties.incidentType'
              equals: 'Incident'
            }
            {
              field: 'properties.incidentType'
              equals: 'Maintenance'
            }
          ]
        }
      ]
    }
    actions: {
      actionGroups: [
        for id in actionGroupIds: {
          actionGroupId: id
        }
      ]
    }
  }
}
