// alerts-cost-foundry.bicep — the LLM-axis budget: a monthly consumption budget
// on the Foundry account's resource group, deployed only when deployFoundry is
// on (with vendor-direct Anthropic/OpenAI keys, LLM spend never enters Azure
// and there is nothing here to watch). The platform-infra counterpart is
// alerts-cost.bicep; the two axes are separated by TOPOLOGY (the account gets
// its own group — see modules/foundry-rg.bicep), not by filter, because budget
// filters are AND-of-`In` only and cannot express an exclusion.
//
// GROUP scope, not subscription, and NO filter: the account's group contains
// nothing but the account, and both of Foundry's billing planes roll up under
// it — first-party account meters for the OpenAI family, marketplace
// `<model>-<guid>` entries for the Anthropic family — so any cost in the group
// is LLM inference by construction. (Contrast alerts-cost.bicep, which pays
// for subscription scope + a ResourceGroupName filter to reach the ACA
// infrastructure groups; this account has no infrastructure group.)
//
// THE AMOUNT IS THE LINE, NOT A DERIVATION. alerts-cost.bicep sizes its amount
// as expected fixed spend x headroom because a healthy platform's month-to-date
// is a straight line from zero to the monthly total, so a budget set to
// expected spend turns every threshold into a calendar date. LLM spend is
// usage-shaped, not calendar-linear, so that derivation transfers nothing here:
// `llmMonthlyBudgetUsd` is simply the monthly number you want mail about. It
// defaults to platformMonthlyUsdCap's 1000 so the Azure notification and the
// portal's display-only Activity-page watch line are the SAME line.
//
// SAME NOTIFY-ONLY CAVEAT, LOUDER. Nothing here stops spend, and the cost data
// it reads lands 8-24 hours late (budgets evaluate roughly daily). A runaway
// app is stopped by the per-app daily token budgets at the edge — synchronous,
// before the call goes upstream — and the worst-case burn rate is bounded by
// the deployments' TPM capacity (foundryDefaultCapacity), which IS a hard,
// real-time, Azure-side limit, just denominated in tokens rather than dollars.
// This budget is the "a human should look at this" line, not a cap.
//
// Raw email addresses rather than the shared action group, same as
// alerts-cost.bicep: budget notifications take addresses directly, and the cost
// mail should still arrive on an install that deployed no health rules at all.

@description('Resource name prefix, matching the rest of the deployment.')
param namePrefix string

@description('Monthly LLM budget in USD (whole dollars) — the line itself, set directly (llmMonthlyBudgetUsd), not a derivation. See the header for why the headroom arithmetic of alerts-cost.bicep does not transfer to a usage-shaped axis.')
param monthlyBudgetUsd int

@description('Addresses the budget notifications go to. The caller skips this module entirely when the list is empty.')
param contactEmails array

@description('Budget start date. Must be the FIRST OF A MONTH and, for a monthly budget, no earlier than the current one — the caller derives it from `utcNow()`; the budget resets monthly regardless.')
param startDate string

// The same three notifications as the platform budget, and for the same
// reason: a heads-up, the line itself, and the one that arrives while the
// month can still be changed. Keys follow Azure's own
// `<Type>_<Operator>_<Threshold>_Percent` convention.
resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: '${namePrefix}-foundry-llm-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    // No filter: scoped to the Foundry account's own resource group, every cost
    // here is LLM inference (see header).
    notifications: {
      Actual_GreaterThan_80_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      Actual_GreaterThan_100_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: contactEmails
      }
      // Forecast needs cost history to project a run rate, so on a brand-new
      // subscription it can stay quiet for the first month or two. The two
      // actual thresholds do not depend on history.
      Forecasted_GreaterThan_100_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: contactEmails
      }
    }
  }
}

@description('The LLM budget amount Azure is watching, in USD — echoed so a deploy shows the number you meant.')
output budgetUsd int = monthlyBudgetUsd
