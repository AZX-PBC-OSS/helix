---
title: Azure AI Foundry
---

# Azure AI Foundry as the LLM backend

By default, apps' LLM calls go to the first-party vendors (`api.anthropic.com`,
`api.openai.com`), with the vendor keys held as connection secrets in the
connections vault and read by the egress service at runtime — the edge never
holds them. For an install in your own (or
your customer's) Azure subscription, you can instead run inference on **Azure
AI Foundry**: the models deploy into your subscription, the bill lands there,
and there is **no vendor key anywhere** — the platform authenticates with the
egress service's managed identity.

Apps see no difference: model names, per-app allowlists, and budgets are
unchanged, because each Foundry deployment is named for the platform's catalog
model id (`claude-sonnet-5`, `gpt-5.1`, …) and Foundry routes on deployment
name.

## The one-flag path

In `main.bicepparam`:

```bicep
param deployFoundry = true
// Required when the model list includes Anthropic models and this subscription
// has never accepted the Anthropic Marketplace offer:
param foundryAttestation = {
  organizationName: 'Contoso'
  countryCode: 'US'
  industry: 'technology'
}
// Optional: model availability is regional — Claude is narrower than GPT.
// param foundryLocation = 'eastus2'
```

That is the whole job. The template then:

- creates one Foundry account (`<namePrefix>-foundry`, overridable via
  `foundryAccountName`) **in its own resource group**
  (`<namePrefix>-foundry-rg`, overridable via `foundryResourceGroupName`) —
  the boundary that keeps LLM spend out of the platform cost budget — with
  key-based auth **disabled**;
- deploys every model in `foundryModels` as serverless, pay-per-token
  deployments — nothing is billed while idle. The default is the subset of the
  platform catalog a *fresh* pay-as-you-go subscription can actually deploy
  (audited in `eastus2`, 2026-09-16): it leaves out models whose default
  version the resource provider reports as Deprecating, the zero-quota Claude
  entries, and the unverifiable `gpt-4.1` family — because deployments apply
  serially and the first refusal aborts the whole apply. Every omitted model
  stays in the platform catalog; add it back to `foundryModels` once your
  subscription has the quota;
- grants the egress identity the two least-privilege inference roles
  (*Cognitive Services User* for Claude/partner models, *Cognitive Services
  OpenAI User* for GPT), and points both model families at the account.

Deployments are created serially and can take a while; role assignments need
about five minutes to propagate, so a 401 on the very first call right after an
apply means "wait and retry", not a misconfiguration.

One preview wrinkle: with `llmMonthlyBudgetUsd` set, `what-if` on the real
parameters refuses with `ResourceGroupNotFound` while the Foundry resource
group does not exist yet — the budget module is scoped to a group the same
deployment creates, and what-if resolves scopes up front. That refusal is
expected on the first run, and creating the group by hand clears only the
error, not what-if's deeper blind spot with this flag. Preview in two parts —
the platform with `deployFoundry=false`, the Foundry module as a standalone
`az deployment group validate` — per [Deploying
updates](/deploy/updates#read-the-what-if-knowing-what-it-cannot-tell-you).

## What models exist where — the three lists

1. **The platform catalog** (code): every model Helix will serve at all, with
   per-token prices for metering. The edge refuses anything not listed.
2. **`foundryModels`** (your deploy): which catalog models actually get
   deployed into this Foundry account. Prune it freely — an app that requests a
   catalog model with no matching deployment gets a 502. Adding one later is an
   edit and a re-apply (or a portal/CLI deployment named for the model id); no
   app changes.
3. **Each app's manifest** (`capabilities.llm.models` + daily budget): which of
   the deployed models that app may use. This stays the real access control —
   deploy broadly, grant narrowly.

Azure limits an account to 32 deployments, and the catalog is ~20 models today
— one account fits. Quota is per model per subscription and scales
automatically with usage tiers; fresh pay-as-you-go subscriptions start most
Claude models at 40 requests/minute, but **`claude-sonnet-5` and the Fable line
start at 0** — an apply that includes them fails with no hint that quota is the
reason, which is exactly why they are not in the default list. Request an
increase (or wait for tiering), then add them back.

Availability and quota are different questions and the catalog answers only the
first, so check both before committing to a `foundryModels` list (two read-only
commands):

```bash
# What the region offers: per version, read isDefaultVersion + lifecycleStatus
# (a Deprecating *default* version is refused outright).
az cognitiveservices model list -l <region>
# What YOUR subscription may deploy: the AIServices/OpenAI.GlobalStandard.<model>
# limits (0 = the apply will fail on that model).
az cognitiveservices usage list -l <region>
```

Re-run the first command occasionally *after* the deploy too: versions retire
(`lifecycleStatus`), and a version approaching retirement stops accepting new
deployments — nothing warns on the way past the date.

**The portal advertises what you deploy.** On a `deployFoundry` install the
capability catalogue (`GET /api/v1/capabilities`), the rendered agent skill,
and the portal's model picker take their servable-model list from
`foundryModels` automatically (`llmModelAllowlist` overrides; see
[Configuration](/deploy/configuration)) — so pruning a model here also stops
the portal offering it, and an app author never checks a box for a model the
account doesn't have.

Two data-residency footnotes: some Claude models run *Hosted on Anthropic
infrastructure* (Azure billing, Anthropic compute) — if that matters to your
customer, restrict `foundryModels` to the Azure-hosted entries (`opus-5`,
`opus-4-8`, `sonnet-5`, `haiku-4-5` at time of writing). And deleting a Foundry
account without purging it keeps its quota reserved for up to 48 hours
(`az cognitiveservices account list-deleted -o table`, then `purge`).

## Cost and the LLM budget

Because the account lives in its own resource group, the platform-infra budget
never sees a token, and a separate LLM-only budget on that group
(`llmMonthlyBudgetUsd`, default `1000` — the same number the portal's Activity
page renders as its watch line) emails `alertEmails` at 80% of it, at 100%,
and when the month's forecast crosses. Both billing planes land in that group:
GPT models meter on the account itself, Claude models bill through the Azure
Marketplace under the group.

Azure budgets **notify only** — Azure has no hard spending cap for Foundry,
and budget data runs 8–24 hours behind. The real limits are each app's daily
token budget (enforced synchronously by the edge before a call goes upstream)
and each deployment's TPM `capacity` (`foundryDefaultCapacity`), which bounds
the worst-case burn rate in real time. With vendor-direct keys
(`deployFoundry` off) none of this exists — that spend never enters Azure.

## Bring your own Foundry

If the account already exists (perhaps in another subscription), leave
`deployFoundry` off and point the upstream params at it:

```bicep
param llmEndpoint = 'https://<account>.services.ai.azure.com'
param llmAnthropicPath = '/anthropic/v1/messages'
param llmAnthropicConnection = 'foundry'
param llmOpenAiEndpoint = 'https://<account>.services.ai.azure.com'
param llmOpenAiPath = '/openai/v1/chat/completions'
param llmOpenAiConnection = 'foundry-openai'
```

Then choose the credential:

- **Keyless (recommended):** grant the platform's egress identity the two
  inference roles on your account — the template outputs
  `egressIdentityPrincipalId` for exactly this — and set the
  `egressManagedIdentityConnections` **parameter** to
  `foundry=<account>.services.ai.azure.com,foundry-openai=<account>.services.ai.azure.com`.
  The host pin matters: egress will only mint a token onto that host, so the
  connection name alone can never draw one onto a foreign origin. Set it as a
  parameter, never by hand on the container app — the next apply reverts
  out-of-band env edits without a word.
- **Account key:** seed it twice, once per family (the two endpoints take
  different key headers):
  `pnpm --filter @azx-pbc/portal seed:llm -- <key> --name foundry` and
  `... --name foundry-openai --recipe api-key`. A seeded key always wins over
  the managed-identity path.

Local development has no managed identity, so against Foundry it always uses
the seeded-key path — same code, same connection names.

## Verifying

- `az deployment group show` outputs list `foundryOrigin`,
  `foundryDeployments`, `foundryResourceGroup`, and `llmBudgetUsd`.
- Call a model through any app; the egress span carries
  `helix.credential_source=managed-identity` (vs `secret` for a seeded key) —
  the first thing to check when a Foundry-bound call misauthenticates.
- A 404-class failure on a curated model means the deployment is missing from
  the account; a 401 means RBAC hasn't propagated or the egress identity lacks
  the roles.
