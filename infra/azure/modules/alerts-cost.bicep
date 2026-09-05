// alerts-cost.bicep — a monthly cost budget covering this deployment's resource
// groups, ALL of them.
//
// SCOPE, and why it is not the obvious one. This budget is deployed at
// SUBSCRIPTION scope with a `ResourceGroupName` filter, not at the deployment's
// own resource group. That looks like the more complicated choice and it is the
// only correct one: each ACA managed environment gets its OWN resource group
// (`ME_<env>_<rg>_<region>`) holding the environment's standard load balancer
// and, for an external environment, a public IP. Those are real billable
// resources in a resource group this template does not deploy into, so a
// resource-group-scoped budget cannot see them at any amount.
//
// Measured on both installs 2026-09-04, before this was fixed: the two
// environment infrastructure groups came to ~$39/mo per install — about 16% of
// the bill — entirely outside a budget that claimed to cover the deployment.
// A budget that under-reports is worse than a missing one, because the number it
// shows is believed.
//
// The one rule in this deployment that is not about health. It is here because
// this platform's cost failures are step changes, not drifts: the egress
// firewall alone is ~$900/mo (`deployFirewall`), the LLM gateway bills per token
// against per-app budgets that only cap PER APP, and a workload-profile
// environment scales on demand. None of that is visible until the invoice.
//
// NOTHING HERE ENFORCES ANYTHING. A consumption budget is a notification, not a
// spend cap — Azure will not stop a resource when it is crossed. The real limits
// are the per-app daily token budgets.
//
// WHY THE AMOUNT IS NOT THE EXPECTED BILL, which is the thing to understand
// before changing it. Azure evaluates an `Actual` notification by comparing
// MONTH-TO-DATE spend against the budget amount, and month-to-date spend on a
// healthy install is a straight line from zero to the monthly total. So a budget
// set to expected spend turns every percentage threshold into a date: 80% of it
// is reached about four fifths of the way through the month — the 24th, every
// month, forever, with nothing wrong. An alert that fires on a healthy platform
// on a schedule is worse than no alert, because it teaches the recipient to
// delete the mail unread, and this is the mail that has to be read on the one
// month something is actually wrong.
//
// The caller therefore sizes the amount at a MULTIPLE of expected spend
// (`budgetHeadroomPercent`, 160% by default), which is what puts the thresholds
// back on the cost axis instead of the calendar:
//
//   80% actual     -> 128% of expected   "we are meaningfully over"
//   100% actual    -> 160% of expected   "we are well over, this month"
//   100% forecast  -> the run rate projects past 160% of expected, early enough
//                     in the month to act on it
//
// The caller also derives expected spend from the DEPLOYMENT SHAPE rather than a
// constant, because `deployFirewall` alone moves this platform's bill by ~8x.
//
// One caveat on the forecast notification: Azure needs cost history to project a
// run rate, so on a brand-new subscription it can stay quiet for the first month
// or two. The two actual thresholds do not depend on history.
//
// This is also the ONE rule that does not route through the shared action group:
// budget notifications take addresses directly, and keeping it on the raw list
// means the cost mail still arrives on an install that deployed no health rules
// at all.

targetScope = 'subscription'

@description('Resource name prefix, matching the rest of the deployment.')
param namePrefix string

@description('Every resource group this deployment bills into: the one the template deploys to, plus each ACA managed environment\'s own infrastructure group (read from the environment resource, not rebuilt from the ME_<env>_<rg>_<region> convention). The budget filters on exactly these, so the subscription can host anything else without polluting the number.')
param resourceGroupNames array

@description('Monthly budget in USD (whole dollars). This is expected spend PLUS HEADROOM, not expected spend — see the header for why that distinction is the difference between an alert and a monthly calendar reminder. The caller derives it.')
param monthlyBudgetUsd int

@description('Expected monthly spend in USD the amount was derived from. Not used by the budget resource — it is here so the deployment can echo the pair, because a budget amount alone does not say whether it was sized for the firewall being on or off.')
param expectedMonthlyUsd int

@description('Addresses the budget notifications go to. At least one is required — the caller skips this module entirely when the list is empty.')
param contactEmails array

@description('Budget start date. Must be the FIRST OF A MONTH and, for a monthly budget, no earlier than the current month — so the caller derives it from `utcNow()` rather than hardcoding a date that ages out. Moving forward on a later deploy is fine; the budget resets monthly regardless.')
param startDate string

// Three notifications, which is the useful set: a heads-up, the line itself, and
// the one that arrives before the damage is done.
//
// The notification KEYS are arbitrary strings, but Azure's own tooling writes
// them in the `<Type>_<Operator>_<Threshold>_Percent` shape and the portal reads
// better when they match, so they follow it here.
resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: '${namePrefix}-budget-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUsd
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    // What turns a subscription-wide budget back into a per-deployment one. The
    // AZX Internal subscription hosts a dozen unrelated resource groups; without
    // this the budget would measure the whole tenant's infrastructure spend and
    // fire on things Helix has nothing to do with.
    filter: {
      dimensions: {
        name: 'ResourceGroupName'
        operator: 'In'
        values: resourceGroupNames
      }
    }
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
      // Forecast, so a mid-month change of shape (a firewall turned on, an app
      // with a runaway token budget) is heard about while the month can still be
      // changed rather than after it closes.
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

@description('The budget amount Azure is watching, in USD — echoed so a deploy shows whether it picked up the number you meant.')
output budgetUsd int = monthlyBudgetUsd

@description('Headroom the amount carries over expected spend, as a percentage. Under ~125 the actual-threshold notifications start reporting the calendar rather than the cost.')
output headroomPercent int = expectedMonthlyUsd > 0 ? (monthlyBudgetUsd * 100) / expectedMonthlyUsd : 0
