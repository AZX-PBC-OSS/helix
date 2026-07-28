# Phase 1 user stories — coverage

How the platform today addresses (or doesn't) the Phase 1 user stories from the PM brief
*Phase 1 User Stories.docx*. Terse and honest: status reflects **code as it stands at M4.5
(local)**, not intent. The brief's product framing (personas, the pilot apps) does not appear
anywhere in the engineering history — this maps stories to the platform purely on the merits.

**Legend:** ✅ done · ⚠️ partial (works, with a named gap) · ⬜ not yet built.
Cross-references point at the feature docs in [`features/`](./features/).

## Business User
*Non-engineer who wants to ship prototypes without DevOps.*

| Story | Pri | Status | How / Gap |
|---|---|---|---|
| Upload a React bundle / HTML file and get a secure hosted URL | P0 | ✅ | Zip-upload deploy (CLI `azx deploy` or the portal drop-zone) → immutable version → `<slug>.<base>` behind the edge. [registry-and-deploys](./features/registry-and-deploys.md), [edge-serving](./features/edge-serving.md) |
| Choose SSO (Entra) **or** password access per deployment | P0 | ✅ | Per-app `visibility`: `private`/`group` (Entra SSO), `password` (shared passphrase for external demos), `public`. [authentication](./features/authentication.md) |
| Use pre-provisioned platform API endpoints without handling keys | P0 | ⚠️ | The **mechanism is done**: the LLM gateway proxies chat with the key held platform-side (app never sees it), and any other third-party API is reachable through the **fetch-proxy + secret-backed connections** (credential injected server-side in egress). *Gap:* only the LLM capability is a first-class metered catalog entry; additional vendors (e.g. a second LLM like Gemini, a curated geocoding endpoint) are `LlmProvider`/connection **config**, not yet a pre-provisioned catalog. [llm-gateway](./features/llm-gateway.md), [fetch-proxy](./features/fetch-proxy.md), [secrets-and-connections](./features/secrets-and-connections.md) |
| Roll back a deployment to a previous version | P1 | ✅ | Versions are immutable; promote/rollback is a pointer flip in the portal — no engineering. [registry-and-deploys](./features/registry-and-deploys.md) |
| View usage metrics (sessions, errors, latency) | P1 | ✅ | Per-app and platform **usage dashboards** present **spend (USD), tokens, requests, p95 latency, and outcomes** over selectable time ranges (per-app 24h/7d/30d, platform 7d/30d/90d) as real charts — dollars-primary with a tokens/requests toggle. The `gateway_calls` ledger now captures **latency** (`durationMs`), full **error** dimensions (`statusCode`, `stopReason`, `errorDetail` + the outcome breakdown), and cache-aware token classes; cost is priced per model at read time. *Note:* "**sessions**" is represented by **active users** (distinct caller) — true per-session counting was deliberately deferred as low-value, not a hidden gap. [llm-gateway](./features/llm-gateway.md), [portal-web](./features/portal-web.md) |

## Platform Administrator
*IT/security owner of access, credential governance, and compliance.*

| Story | Pri | Status | How / Gap |
|---|---|---|---|
| Manage all AI keys / enterprise tokens in one vault | P0 | ⚠️ | App-scoped and global connection secrets are managed (write-only/rotate-only) through the portal and sealed by the `SecretStore` seam; the egress role is the only reader. *Gap:* prod **Key Vault** backing is wired in M5 — the dev AES-GCM envelope is what runs today. [secrets-and-connections](./features/secrets-and-connections.md) |
| Embed a client org's licensed API tokens (e.g. a client's own licensed contracts) | P0 | ✅ | **Global** secrets + per-app **grants**: store the client's token once, grant the apps that may spend it; one secret backs many connections, so rotation is one write. [secrets-and-connections](./features/secrets-and-connections.md) |
| Define + enforce which AI models each team can access | P0 | ⚠️ | Enforced **per app**: the manifest model allowlist gates every LLM call, and an **approval workflow** makes any non-curated model an admin-gated elevated grant (a platform-wide policy, not a courtesy). *Gap:* policy is per-app + platform-wide, **not per-team/per-group** — there is no "group X may only use models Y." [capabilities-and-manifests](./features/capabilities-and-manifests.md) |
| Tamper-evident audit log of every AI call | P0 | ⚠️ | Every gateway call is recorded to the append-only `gateway_calls` ledger (the edge role has INSERT, not UPDATE/DELETE) and surfaced in the portal Audit log — now with per-call latency, status, cost, and error detail. *Gap:* **not cryptographically tamper-evident** (no hash chain / signature), and audit shipping to an immutable external sink is deferred (project plan §5.8). [llm-gateway](./features/llm-gateway.md), [portal-web](./features/portal-web.md) |
| Provision/deprovision builders via Entra groups | P0 | ⚠️ | Auth is group-aware end to end: app visibility checks Entra groups, admin rights are a group claim, and deploy access rides the per-user Entra device-flow token (revocation is free when the Entra account dies). *Gap:* the real Entra registration is the M3 tail (M5), and there's no dedicated builder-provisioning UI — it's group membership, not a console. [authentication](./features/authentication.md), [cli](./features/cli.md) |
| Alert when usage/spend thresholds are exceeded | P1 | ⬜ | Per-app daily **budgets** exist and block-new once hit (runaway is *capped*), and **spend is now tracked in dollars** (per-model rates, cache-aware) across every dashboard — the precondition for alerting. *Gap:* still no **alerting/notification** when a threshold trips; now a small add on top of the dollar data. [llm-gateway](./features/llm-gateway.md) |
| Export audit + usage data to a data warehouse | P2 | ⬜ | App-data collections have an owner export path, but there is no audit/usage **warehouse export** — tied to the deferred immutable-sink shipping (project plan §5.8). |

## End User
*Person using a hosted experience.*

| Story | Pri | Status | How / Gap |
|---|---|---|---|
| Useful fallback when the AI service is unavailable | P1 | ⚠️ | The gateway fails cleanly — a missing/unconfigured provider returns a structured `503` rather than hanging, so the app can detect and degrade. *Gap:* the **fallback UX is the app's** to render; the platform surfaces the error but ships no default outage experience. [llm-gateway](./features/llm-gateway.md) |

## Pilot apps (context)
The brief names two first apps to validate against: **migrate the Trilliant demos**, and a
**Heatwave DR simulation** (peak-demand study using thermostat-setpoint DR events over ResStock
models, HARES simulations, and weather data). Neither is built; the platform features above are
what they would land on. The Heatwave app in particular still leans on one area in motion — a
**geocoding/weather** third-party endpoint (today via fetch-proxy + a connection, not a
pre-provisioned catalog entry); the richer **usage metrics** it wanted (spend, latency, time-range
views) have since landed.

## Summary

| Priority | ✅ | ⚠️ | ⬜ |
|---|---|---|---|
| P0 | 3 | 5 | 0 |
| P1 | 2 | 1 | 1 |
| P2 | 0 | 0 | 1 |

The platform's **mechanisms** for the P0 stories largely exist — deploy, per-app SSO/password,
key-free API access, a single secret vault, per-app model policy, an audit ledger, group-aware
auth. The recurring P0 gaps are **production hardening** (Key Vault, real Entra — both M5) and
**governance depth** (team-scoped policy, tamper-evident audit). **Usage visibility is now a
strength** — dollar-denominated spend, latency, and errors over selectable time ranges, presented
as real charts. The clearest remaining asks are **alerting** (now a small add on top of the dollar
data) and **warehouse export** (P1/P2).
