// action-group.bicep — the one place an alert notification leaves Azure.
//
// Every rule in this deployment (the telemetry rules in `alerts.bicep`, the
// availability tests in `alerts-availability.bicep`, the infrastructure rules in
// `alerts-infra.bicep`) routes through this single action group, so adding a
// recipient is one parameter rather than a sweep across five files. The cost
// budget is the one exception and says why in its own header.
//
// This used to live inside `alerts.bicep`. It moved out unchanged — SAME
// RESOURCE NAME on purpose, so an existing deployment updates the group it
// already has instead of orphaning it and creating a twin.
//
// The caller decides whether this deploys at all: with no addresses there is
// nothing to create, and every consumer accepts an empty action-group id and
// deploys its rules anyway (they evaluate, fire, and notify nobody — which the
// `alertsNotify` output exists to tell you about).

@description('Resource name prefix, matching the rest of the deployment.')
param namePrefix string

@description('Email addresses to notify. Several are supported: each address becomes its own email receiver on this one group.')
param alertEmails array

@description('Action group short name, which Azure puts in the notification subject line. Max 12 characters (an Azure limit, not ours).')
@maxLength(12)
param actionGroupShortName string = 'helix'

// `useCommonAlertSchema` so the payload shape is stable if a webhook is ever
// added alongside the emails.
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-ag-platform'
  // Action groups are a global resource; 'global' is the required location.
  location: 'global'
  properties: {
    groupShortName: actionGroupShortName
    enabled: true
    emailReceivers: [
      for (email, i) in alertEmails: {
        name: 'email${i}'
        emailAddress: email
        useCommonAlertSchema: true
      }
    ]
  }
}

@description('Resource id of the shared action group, to hand to every alert module.')
output actionGroupId string = actionGroup.id
