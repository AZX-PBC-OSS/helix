// alerts-jobs.bicep — the background-jobs plane's health bodies, read from
// inside the apps environment (ADR-0009, ADR-0045).
//
// The jobs service answers `/health` with HTTP 200 in every state; storage
// failure, a stopped worker, retained-storage saturation, overdue cleanup and
// lifecycle lag are all in the BODY, as the `jobs_*` checks named in
// packages/shared/src/jobsHealth.ts. The portal reports lifecycle delivery the
// same way (`jobs_lifecycle_delivery`). The jobs app has internal ingress, and
// so does the portal unless `portalExternal` is set, so the availability tests
// in alerts-availability.bicep, which run from public Azure regions, cannot
// read either body.
//
// The relay closes that gap. It is a scheduled Container Apps Job in the apps
// environment that runs the helix-jobs image's `scripts/health-relay.ts`: it
// reads each target's `/health`, validates the body against the shared health
// contract, and writes one bounded JSON line per jobs check plus one
// `jobs.health.observed` line per target to stdout. Stdout lands in the
// environment's Log Analytics workspace, and the rules below read those lines.
// No rule here reads an HTTP status code, and none reads a submission refusal:
// `jobs_worker` grades the runner's supervision, so an ordinary throttle or
// capacity refusal never shows up as a dead worker.
//
// Each rule takes the latest reading per (target, check) inside the window, so
// a check that recovers stops matching on the next evaluation and
// autoMitigate resolves the alert. Missing evidence has its own rule: a target
// that did not answer, answered off-protocol, omitted an expected check, or
// produced no relay line at all in the window.

@description('Azure region.')
param location string

@description('Resource name prefix, matching the rest of the deployment.')
param namePrefix string

@description('Log Analytics workspace the rules query: the apps environment\'s, where the relay\'s stdout lands.')
param workspaceId string

@description('The apps environment the relay runs in. It must be the environment the jobs app and the portal live in, because their ingress is internal to it.')
param acaEnvId string

@description('helix-jobs image, e.g. ghcr.io/azx-pbc-oss/helix-jobs:sha-xxxx. Keep it in step with the jobs app so the relay validates bodies against the same contract the service emits.')
param image string

@description('What the relay reads: an array of `{ kind, target, url }`. `kind` is `jobs` (one entry per configured jobs server, `target` = the server id) or `portal` (`target` = `portal`). `url` is the target\'s `/health` inside the environment.')
param targets array

@description('Resource id of the shared action group, or empty. Empty deploys the rules with no notification target.')
param actionGroupId string = ''

@description('Relay schedule (cron, UTC). Every 5 minutes matches the rules\' evaluation frequency, so a 15-minute window holds three readings per target. Each run pulls and starts one small container, so tightening this raises cost and image pulls.')
param relayCron string = '*/5 * * * *'

@description('How often the rules evaluate (ISO 8601 duration).')
param evaluationFrequency string = 'PT5M'

@description('How far back each evaluation looks (ISO 8601 duration). Must cover at least two relay runs, or one missed run reads as missing evidence.')
param windowSize string = 'PT15M'

@description('Severity of the execution rule (storage, worker, intake): accepted work cannot run. 1 = error.')
@allowed([0, 1, 2, 3, 4])
param executionSeverity int = 1

@description('Severity of the saturation, cleanup and lifecycle-lag rules: work still runs, but a bound the platform promises is slipping. 2 = warning.')
@allowed([0, 1, 2, 3, 4])
param degradedSeverity int = 2

@description('Severity of the missing-evidence rule. 1 = error: when the relay cannot read a body, none of the other rules can fire for that target.')
@allowed([0, 1, 2, 3, 4])
param unobservedSeverity int = 1

var actionGroupIds = empty(actionGroupId) ? [] : [actionGroupId]

// The relay's stdout contract (apps/jobs/scripts/health-relay.ts exports the
// same names; the wiring test pins them).
var relayTargetsEnv = 'JOBS_HEALTH_RELAY_TARGETS'
var checkEvent = 'jobs.health.check'
var observedEvent = 'jobs.health.observed'
// The queries read only this container's lines. Every platform container
// writes JSON with an `event` field to the same table, and a line forged
// elsewhere with an `ok` status would otherwise become the latest reading and
// hide a failure.
var relayContainerName = 'jobs-health-relay'
var relayLines = 'ContainerAppConsoleLogs_CL | where ContainerName_s == "${relayContainerName}" | extend p = parse_json(Log_s)'

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------
// No identity, no secrets and no registry credential: it reads two
// unauthenticated `/health` endpoints and pulls the public image anonymously,
// exactly like the jobs app. The targets are a plain env value because they
// hold only internal URLs and bounded names.
resource relay 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-jobs-health-relay'
  location: location
  properties: {
    environmentId: acaEnvId
    configuration: {
      triggerType: 'Schedule'
      // The relay bounds each read at 10 s; 60 s covers the image start.
      replicaTimeout: 60
      // A failed run is not retried: the next scheduled run is the retry, and
      // a run that wrote nothing is what the missing-evidence rule detects.
      replicaRetryLimit: 0
      scheduleTriggerConfig: {
        cronExpression: relayCron
        parallelism: 1
        replicaCompletionCount: 1
      }
    }
    template: {
      containers: [
        {
          name: relayContainerName
          image: image
          // Overrides the image's server CMD. WORKDIR is the jobs package, as
          // for the migrate job's `scripts/migrate-azure.ts`.
          command: [
            'node'
            '--import'
            'tsx'
            'scripts/health-relay.ts'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: relayTargetsEnv, value: string(targets) }
          ]
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// The check rules
// ---------------------------------------------------------------------------
// One rule per failure family, each over a fixed set of check names. Every
// jobs-owned and portal-owned check belongs to exactly one family. The
// `jobs_reachability` check is the edge's and is not relayed: it never grades
// worse than degraded, so a jobs outage pages through these rules, not
// through the edge availability test.
var checkRules = [
  {
    name: 'jobs-execution'
    displayName: 'jobs storage, worker or intake failing'
    description: 'A jobs server cannot run accepted work: its store is unreachable or at the wrong schema (jobs_database), no worker is registered on its runner (jobs_worker), or its configured intake has not been applied or is refused (jobs_intake). The alert names the target and check; the check\'s detail in the jobs.health.check line says which. Ordinary submission throttling and capacity refusals never reach these checks.'
    severity: executionSeverity
    checks: [
      'jobs_database'
      'jobs_worker'
      'jobs_intake'
    ]
  }
  {
    name: 'jobs-capacity'
    displayName: 'jobs retained storage saturated'
    description: 'A jobs server\'s retained storage is at its server-wide bound, or the cleanup measurement that grades it is stale or missing (jobs_capacity). New work is refused with 429 until cleanup frees capacity; reads, recovery and cancellation still work. The retainedServer and unfinishedServer metrics are in the jobs.health.check line. Unfinished-capacity refusal alone never fires this rule.'
    severity: degradedSeverity
    checks: [
      'jobs_capacity'
    ]
  }
  {
    name: 'jobs-cleanup'
    displayName: 'jobs cleanup overdue'
    description: 'Expired job content on a jobs server has stood past its removal deadline, or the cleanup loop has stopped passing (jobs_cleanup). The jobs.cleanup.overdue and jobs.cleanup.pass_failed log events carry the per-pass story.'
    severity: degradedSeverity
    checks: [
      'jobs_cleanup'
    ]
  }
  {
    name: 'jobs-lifecycle'
    displayName: 'jobs lifecycle delivery or recovery lagging'
    description: 'App lifecycle changes are not converging: the portal has delivery intents pending more than 60 seconds or its sender has stopped (jobs_lifecycle_delivery, target portal; the detail names each lagging server), or a jobs server has archive cancellation pending more than 60 seconds or its recovery sweeper has stopped (jobs_lifecycle_recovery, jobs_sweeper).'
    severity: degradedSeverity
    checks: [
      'jobs_lifecycle_delivery'
      'jobs_lifecycle_recovery'
      'jobs_sweeper'
    ]
  }
]

// KQL on one line: Bicep's ''' strings do not interpolate, and the event names
// and check sets come from variables.
var latestChecks = '${relayLines} | where tostring(p.event) == "${checkEvent}" | extend kind = tostring(p.kind), target = tostring(p.target), check = tostring(p.check), status = tostring(p.status), detail = tostring(p.detail), metrics = tostring(p.metrics) | summarize arg_max(TimeGenerated, status, detail, metrics) by kind, target, check'

resource checkAlerts 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = [
  for rule in checkRules: {
    name: '${namePrefix}-alert-${rule.name}'
    location: location
    kind: 'LogAlert'
    properties: {
      displayName: '${namePrefix} ${rule.displayName}'
      description: rule.description
      severity: rule.severity
      enabled: true
      scopes: [workspaceId]
      evaluationFrequency: evaluationFrequency
      windowSize: windowSize
      criteria: {
        allOf: [
          {
            query: '${latestChecks} | where check in (${join(map(rule.checks, c => '"${c}"'), ', ')}) | where status != "ok" | project TimeGenerated, kind, target, check, status, detail, metrics'
            timeAggregation: 'Count'
            // One alert per server and check, so two servers (or two checks)
            // failing at once are two alerts rather than one merged one.
            dimensions: [
              { name: 'target', operator: 'Include', values: ['*'] }
              { name: 'check', operator: 'Include', values: ['*'] }
            ]
            operator: 'GreaterThan'
            threshold: 0
            failingPeriods: {
              numberOfEvaluationPeriods: 1
              minFailingPeriodsToAlert: 1
            }
          }
        ]
      }
      autoMitigate: true
      actions: {
        actionGroups: actionGroupIds
      }
    }
  }
]

// ---------------------------------------------------------------------------
// The missing-evidence rule
// ---------------------------------------------------------------------------
// The expected targets come from the deployment, so a target with no relay
// line at all in the window (the relay is not running, its image is missing,
// or it never reached that target) is a row here, not silence.
var expectedTargets = join(map(targets, t => '"${t.kind}", "${t.target}"'), ', ')
var unobservedQuery = 'let observed = ${relayLines} | where tostring(p.event) == "${observedEvent}" | extend kind = tostring(p.kind), target = tostring(p.target), outcome = tostring(p.outcome), missing = tostring(p.missing) | summarize arg_max(TimeGenerated, outcome, missing) by kind, target; datatable(kind: string, target: string) [${expectedTargets}] | join kind=leftouter observed on kind, target | extend outcome = iff(isempty(outcome), "no_observation", outcome) | where outcome != "observed" or missing != "[]" | project kind, target, outcome, missing'

resource unobservedAlert 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = {
  name: '${namePrefix}-alert-jobs-unobserved'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: '${namePrefix} jobs health unobserved'
    description: 'The jobs health relay has no current reading for a target: no relay line in the window (no_observation: the relay job is not running), the target did not answer (no_answer), answered as something other than the expected service (off_protocol), or answered without one of its expected checks (missing). Missing evidence is never read as healthy, and while this fires the other jobs rules cannot fire for that target.'
    severity: unobservedSeverity
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: evaluationFrequency
    windowSize: windowSize
    criteria: {
      allOf: [
        {
          query: unobservedQuery
          timeAggregation: 'Count'
          dimensions: [
            { name: 'target', operator: 'Include', values: ['*'] }
          ]
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

@description('The relay job\'s name, for `az containerapp job execution list`.')
output relayJobName string = relay.name

@description('Whether these rules will reach a human. False means they deploy, evaluate and fire silently.')
output notifies bool = !empty(actionGroupId)
