# ADR-0049 — Warden as an optional inference backend

## Status

Proposed _(2026-10-01)_. The Warden feature requests below are not yet filed.

**Related:** ADR [0008](0008-llm-key-via-egress.md) (vendor key held by egress),
ADR [0013](0013-egress-trust-model.md) (attested instructions), ADR
[0021](0021-metering-ledger.md) (the `gateway_calls` ledger), ADR
[0033](0033-openai-compatible-gateway-surface.md) (the vendor seam this slots into),
ADR [0046](0046-azure-ai-foundry-keyless-llm-backend.md) (managed-identity tokens from
egress), ADR [0047](0047-operator-declared-servable-model-set.md) (the servable model
set), ADR [0048](0048-canonical-principal-oid.md) (the user identifier sent as the
subject).

## Context

[Warden](https://github.com/AZX-PBC-OSS/warden) is a self-hosted LLM gateway. It
handles provider keys, multi-provider routing and failover, pricing, budgets at every
level of an org → team → project → user hierarchy, Redis-backed RPM/TPM limits,
guardrails, and usage reporting. Helix does a smaller version of some of that work in
the edge: model routing by catalogue, cost from `MODEL_PRICING`, and a per-app daily
dollar cap. Helix has no per-user budget or rate limit.

Helix should be able to use Warden for that work when an operator runs it, and keep
working without it. ADR-0033 already made the upstream base URL configuration so that
Warden could be added this way. Warden ships `docs/helix-integration.md`, which
describes the config-only path.

Warden code is cited at commit `70975c31`.

### How Warden authenticates callers today

- **Project tokens only.** Inference routes accept one credential: an opaque project
  token (`w-…`, argon2id-hashed, cached 60s, revocation takes effect at once —
  `src/warden/auth/tokens.py`). The token fixes the project, team, budgets, model
  allowlist and guardrail floor for the request. Holding the token is the whole trust
  model.
- **No way to assert who the caller acts for.** There is no header, signed assertion,
  mTLS or IP allowlist that lets a trusted upstream say which project or user a request
  is for. An M2M JWT validator exists (`auth/dependency.py:379`), but no route uses it.
  Admin SSO does not apply to inference.
- **Only per-request dimension: the end user.** The OpenAI `user` field (or
  `metadata.user_id` on `/v1/messages`) is stored as `usage_events.end_user_id`, with
  an `end_user` budget scope keyed `"<project>:<user>"`. Token tags live on the token,
  not the request.

### Per-app tokens: what we would have to do today

For Warden to budget, allowlist or report per Helix app, today each app would need its
own Warden project **and its own token**. Warden's integration doc recommends this.
Helix would then mint a token per app, store it as an app-scoped egress secret
(egress only resolves `llm` secrets at platform scope today,
`apps/egress/src/secrets.ts:95`), rotate and revoke it, and reconcile drift. The cost
sits in the per-app token, not the per-app project. A project is configuration and can
be upserted safely; a token is secret material with a lifecycle.

### Gaps found in Warden's per-user support

- The end-user registry check compares raw ids while enforcement keys on
  `project:user` (`metering/budget.py:503-591`). Also, one registry row anywhere makes
  `user` mandatory for every project.
- `end_user_id` is not a usage filter or group-by, and the rollups drop it
  (`metering/meter.py:23-33,125-138`).
- There is no `end_user` rate-limit scope (`metering/ratelimit.py:205`).
- Cost is integer cents, floored per request (`metering/pricing.py:136-140`). A cheap
  chat call records $0.
- `user` is forwarded upstream unchanged (`providers/openai_compat.py:546`).
- `/v1/responses` drops `user` (`routes/responses.py:253,401`).

## Warden feature requests

These are listed in the order Helix needs them. Each one can be filed as its own
GitHub issue. WFR-10 is a standalone bug and is worth filing whether or not Helix
adopts Warden.

### WFR-1 — Delegating gateway tokens: assert the project per request

**Problem.** A caller that is itself a multi-tenant gateway (Helix) must hold one token
per downstream tenant to get per-tenant budgets, allowlists and usage. That makes the
caller run a token-provisioning and rotation system.

**Proposal.**

- Add a token kind (for example `TokenPolicy.gateway = true`) that is scoped to a
  **team** rather than to one project.
- A request on a gateway token names its project in a header,
  `X-Warden-Project: <project id>`.
- Warden resolves the project's policy as if a project token had been presented:
  allowlist, budgets and budget windows, guardrail floor, provider-key resolution,
  RPM/TPM/RPS and concurrency.
- The gateway token's own limits apply on top, as a ceiling across all its projects.
- The usage row records the asserted `project_id` and the gateway `token_id`.
- Optional team setting `auto_create_projects`: an unknown project id under the team is
  created on first use with team defaults. Without it, an unknown id returns 404.

**Acceptance criteria.**

- The header is only accepted on gateway tokens. On any other token it returns 400; it
  is never silently ignored.
- The asserted project must belong to the gateway token's team. A project in another
  team returns 403 and writes an audit entry, and is never resolved.
- A request on a gateway token without the header returns 400. Warden never picks a
  default project.
- Per-project concurrency limits apply per asserted project, not per token.
- Every cache keyed by credential includes the asserted project: the token-policy cache,
  the response cache and idempotency keys. The response cache also includes the
  subject from WFR-2.
- Revoking the gateway token, or soft-deleting the asserted project, stops requests
  within the existing cache TTL.
- Covered on every inference ingress: chat completions, completions, embeddings,
  `/v1/messages`, `/v1/responses`, and `/v1/models`. `/v1/models` lists the asserted
  project's allowlist.
- Admin API: mint and list gateway tokens (team-admin can mint within their team).
  The admin UI shows the kind.
- Red-team tests for cross-team assertion, a missing header, and a header on a
  non-gateway token.

**Code pointers.** `auth/dependency.py:361-377` (`get_principal_from_token`),
`auth/tokens.py:58-71` (policy query joining project/team/org), `models.py:1768`
(`TokenPolicy`), `filter_chain.py:100-138` (`RequestContext`).

### WFR-2 — Gateway-asserted end-user subject

**Problem.** `end_user_id` comes from a body field the client controls. It is optional,
it is forwarded to the model vendor, and it is missing on `/v1/responses`. A gateway
that has already authenticated the user needs a dimension it can rely on, that never
leaves Warden.

**Proposal.**

- A request header, `X-Warden-Subject: <opaque id>`, accepted only on gateway tokens
  (WFR-1).
- When present, it sets `end_user_id` and overrides `user` / `metadata.user_id` from
  the body.
- Scoping is always `"<project>:<subject>"`, as for `end_user_scope_id` today.
- A per-token `subject_mode` of `optional` or `required` decides whether a missing
  subject is rejected.
- On gateway tokens, the end-user identifier is removed from the upstream request by
  default: strip `user`, `metadata.user_id` and `safety_identifier`.
- Optionally, a `hash` mode forwards an HMAC of `project:subject` under a Warden-held
  key, for vendors that want a stable abuse-monitoring id.

**Acceptance criteria.**

- Subjects are 1–256 printable ASCII characters. Anything else returns 400.
- The subject header does not trigger the global `end_user_budgets` registration gate.
  WFR-6 covers caps for subjects that were never registered.
- In strip mode, no end-user identifier reaches the upstream request on any ingress.
  A test asserts this per provider adapter.
- `/v1/responses` (HTTP and WebSocket) carries the subject through the same as chat.
- The subject is never a metrics label. It is recorded on usage rows and audit only.

**Code pointers.** `filter_chain.py:1383-1403, 1849-1851` (extraction),
`routes/anthropic.py:587-592`, `routes/responses.py:253-266, 401-409`,
`providers/openai_compat.py:546`.

### WFR-3 — Return cost and a correlation id to the caller, and store both

**Problem.** A calling gateway that keeps its own audit ledger cannot record Warden's
cost for a request, or point at Warden's usage row, without re-deriving the price.

**Proposal.**

- Store an inbound `X-Request-ID` as `usage_events.request_id`, indexed. Warden already
  validates and echoes the header (`app.py:199-207`).
- Return the computed cost and usage row id to the caller:
  - On non-streaming responses: `X-Warden-Cost-Micro-Usd` and `X-Warden-Usage-Id`
    headers.
  - On streams, where headers have already gone out: an extension object on the final
    usage chunk, for example
    `usage.warden = { cost_micro_usd, usage_id, project_id }`. For `/v1/messages`, the
    same object on the final `message_delta`.

**Acceptance criteria.**

- The streamed cost equals the cost written to `usage_events` for that request.
- The extension is additive. Standard OpenAI and Anthropic SDKs parse the stream
  without errors (test with both).
- The admin usage API can look up rows by `request_id`.

**Code pointers.** `filter_chain.py:2078-2105` (`MeteringFilter`),
`routes/inference.py:4455-4480` (stream finalization), `metering/meter.py:41-76`.

### WFR-4 — Sub-cent cost precision

**Problem.** `cost_cents INTEGER` is floored per request and per component
(`metering/pricing.py:136-140, 411-463`). A chat call costing under one cent records 0.
Totals are therefore biased low, and the error is largest in exactly the many-small-calls
pattern that per-user metering exists to measure.

**Proposal.**

- Add `usage_events.cost_micro_usd BIGINT`, computed without per-component truncation.
  `cost_cents` stays as a derived column for compatibility.
- Budget accounting, the Redis reservations and the rollups sum the precise value and
  round only when displaying.

**Acceptance criteria.**

- A request priced at $0.0004 records 400 micro-USD.
- 1,000 such requests show $0.40 in usage and budget reads, not $0.
- Existing cent-based admin API fields keep their meaning.

### WFR-5 — Idempotent project upsert by caller-chosen id

**Problem.** Project ids are already caller-supplied (`models.py:1725`), but `POST
/projects` conflicts on an existing id and `PUT /projects/{id}` returns 404 on a
missing one (`routes/admin.py:4815-4830`). A syncing caller has to handle both cases
and the race between them.

**Proposal.** `PUT /admin/api/projects/{id}?create=true`, or a dedicated upsert route.
It creates the project under the body's `team_id` when it is missing, and updates it
otherwise. The same applies to `PUT /budget-windows/{scope}/{scope_id}` (already an
upsert) and any per-project end-user defaults from WFR-6.

**Acceptance criteria.**

- Repeated identical calls are no-ops.
- Concurrent creates of the same id produce one project.
- A team-admin key can upsert only within its team.

### WFR-6 — Default per-end-user budget windows

**Problem.** End-user caps today need one row per end user (`end_user_budgets` or
`budgets` with a composite `scope_id`). Setting them is platform-admin only
(`routes/admin.py:6299-6307`). A gateway cannot pre-register every user.

**Proposal.**

- A project-level (and team-level, inherited) **default end-user window**: "each
  subject in this project may spend at most N per day / rolling window".
- It applies to every `project:subject` scope without a per-subject row.
- An explicit per-subject row still overrides it, subject to the existing
  child-not-looser-than-parent ceiling rule (`metering/ceiling.py`).
- Team-admins can set it within their team.

**Acceptance criteria.**

- With a default of $1/day and no per-subject rows, a subject's second $0.60 request is
  rejected with 402 and `X-Warden-Budget-Window-End`.
- A different subject in the same project is unaffected.
- The `soft` mode works the same as for other windows.

### WFR-7 — Sub-day rolling budget windows

**Problem.** Rolling windows take `window_days` (`routes/admin.py:1661-1700`). Helix
enforces a burst cap of one sixth of the daily budget over a rolling hour
(`apps/edge/src/gateway/llm.ts:55`), which Warden cannot express.

**Proposal.** Accept `window_hours` (or `window_seconds`) on rolling windows, at every
scope including `end_user`.

**Acceptance criteria.** A one-hour rolling window caps spend over any 60-minute span.
Its window end header reflects when the oldest counted spend ages out.

### WFR-8 — `end_user` rate-limit scope

**Problem.** RPM, TPM and RPS scopes stop at the token, user, project, team and org
(`metering/ratelimit.py:205-358`). One subject can use all of a project's request rate.

**Proposal.**

- An `end_user` rung, keyed `rl:{kind}:end_user:{project}:{subject}:{bucket}`.
- Limits come from a project or team default, the same as WFR-6, with optional
  per-subject overrides.

**Acceptance criteria.** With a per-subject limit of 10 RPM, an 11th request in the
window returns 429 for that subject only, with `Retry-After`.

### WFR-9 — `end_user` in usage queries, rollups and erasure

**Problem.** Per-subject usage can only be read with SQL against raw `usage_events`.
The rollups drop the column (`migrations/versions/0001_baseline.sql:1294-1296`), so
history past the 90-day raw retention is lost.

**Proposal.**

- Add `end_user_id` to `_FILTER_COLUMNS` and `_ALLOWED_GROUP_BY` (`meter.py:23-33,
  125-138`), and to `/usage/export` and `/chargeback`.
- On the token-scoped `GET /api/v1/usage`, allow `group_by=end_user` within the
  caller's own project(s).
- Add an opt-in rollup grain that keeps `end_user_id`.
- Add an erasure endpoint, `DELETE /admin/api/end-users/{project}/{subject}`, that
  pseudonymizes the subject in raw and rolled-up rows.

**Acceptance criteria.**

- Group-by `end_user` within a project matches the raw sum.
- A token-scoped caller cannot read other projects' subjects.
- After erasure, no row matches the subject.

### WFR-10 — Fix end-user registry and enforcement id mismatch (bug)

**Problem.** `check_end_user_binding` compares the raw id against the registry. Limit
lookup uses `"<project>:<user>"` (`metering/budget.py:503-528, 561-591`). A row created
with the documented `POST /end-user-budgets` passes the binding check and is never
enforced. A composite-id row is enforced but fails the binding check. Separately, the
registry is global, so one row anywhere makes `user` mandatory for every project in the
deployment.

**Proposal.** Make the registry per project, keyed on the composite id in both checks.
Have the admin API take `project_id` plus `end_user_id` and build the composite itself.
Migrate existing raw rows, or report them.

**Acceptance criteria.**

- A row registered through the API is enforced.
- Registering an end user in project A has no effect on project B.

### WFR-11 — Project and subject on budget webhooks

**Problem.** The `budget.exceeded` payload carries only `{scope, estimated_cost_cents}`
(`filter_chain.py:1891-1900`).

**Proposal.** Include `project_id`, `scope_id`, `window_type`, `window_end` and, for
`end_user` scopes, `end_user_id`, on both `budget.exceeded` and `budget.warning`.

**Acceptance criteria.** A consumer can tell from the payload alone which project and
subject crossed which window.

### WFR-12 — Workload-identity authentication for gateway tokens

**Problem.** A gateway token is a static long-lived secret. Helix already avoids static
secrets for Azure-hosted upstreams by minting managed-identity tokens in egress
(ADR-0046).

**Proposal.**

- Wire the existing `get_principal_from_jwt` / `OIDCProvider.validate_access_token`
  path (`auth/dependency.py:379-417`, `auth/oidc.py:823-935`) to inference.
- A JWT from a configured issuer whose `sub` (or `azp`/`appid`) is bound by an admin to
  a gateway-token policy resolves to that policy.
- WFR-1 and WFR-2 apply unchanged.

**Acceptance criteria.**

- A token from an unbound client returns 401.
- An expired token, or one with the wrong audience, returns 401.
- Unbinding takes effect within the JWKS/cache TTL.

## Decision

1. **Warden is an optional backend, off by default.** Direct mode, today's code path,
   stays fully supported and is the default. Warden mode is selected per deployment,
   never per app. No hosted app can tell which mode is running.

2. **One gateway token, held by egress. No per-app tokens.** The token is a `platform`
   secret like the vendor keys (ADR-0008), so the edge never holds it. Helix will not
   mint, store or rotate a Warden token per app. Per-app attribution comes from WFR-1.

3. **Egress asserts project and subject from the attested instruction.** A new
   injection kind, `warden-gateway`, is added next to `header-bearer` in
   `packages/shared/src/secrets.ts`. It injects the bearer token, and sets
   `X-Warden-Project` and `X-Warden-Subject` from the verified instruction's `appId`,
   `env` and `userOid`.
   - The edge does not write these headers, and the app cannot: the request-header
     safelist (`packages/shared/src/fetch.ts:90`) already drops them.
   - The values come from the same signed instruction that already authorizes the
     call (ADR-0013). Warden's trust in them therefore reduces to its trust in the
     gateway token.

4. **Hierarchy mapping.**
   - A Helix deployment is one Warden **team**.
   - Each Helix app and env tier is one Warden **project**, with id
     `helix-<appId>-<env>`. Helix's budgets are per `(appId, env)`
     (`apps/edge/src/gateway/usage.ts:294`), so the project id follows that grain.
   - The **subject** is the principal oid (ADR-0048) for `user` callers, and the
     `pw_…` pseudonym for `password` callers.
   - All `anon` callers share the literal subject `anon`. This puts anonymous traffic
     on a public app into one capped pool.

5. **Warden owns enforcement in Warden mode. Helix owns identity, authorization and
   audit in both modes.**

   | Concern | Direct mode | Warden mode |
   |---|---|---|
   | End-user login, app visibility, CSRF, same-origin `/_api/*` | Helix | Helix |
   | Whether an app may use `llm`, and which models (manifest + approval, ADR-0016) | Helix | Helix (source of truth; pushed to Warden) |
   | Model allowlist check per request | Helix | Helix and Warden (Warden's from the pushed allowlist) |
   | Per-IP limit for anonymous callers | Helix | Helix |
   | Provider keys, routing, failover | Helix (`RoutingLlmProvider`) | Warden |
   | Pricing and cost | Helix (`MODEL_PRICING`) | Warden (reported back, WFR-3) |
   | Per-app budget | Helix (`dollarsPerDay`) | Warden (pushed window) |
   | Per-user budget and rate limit | none | Warden (WFR-6, WFR-8) |
   | Guardrails | none | Warden |
   | Audit row per call (`gateway_calls`) | Helix | Helix, with Warden's cost and usage id |
   | Per-user usage in the portal | Helix ledger | Helix ledger |

   The ledger stays in both modes. It is Helix's audit record, not a second meter, and
   it already carries `userOid`. So per-user reporting in the portal reads Helix's
   ledger, and does not depend on WFR-9. WFR-9 is for operators who use Warden's own
   UI and chargeback, and for reconciliation.

6. **The manifest stays the source of truth.** The portal pushes each app's model
   allowlist, `dollarsPerDay` and the deployment's per-user defaults to the Warden
   project when the app is approved or its manifest changes. A failed push never
   blocks an approval. Warden runs on team defaults until a reconcile loop catches up.

## Implementation plan

Steps are in implementation order. Each lists the Warden feature requests it waits on.
Steps 1, 2 and 8 can ship today.

| Step | What | Blocked on |
|---|---|---|
| 1 | Config-only routing through one Warden project | — |
| 2 | Catalogue and servable set from Warden aliases | — |
| 3 | `warden-gateway` injection: project and subject headers | WFR-1, WFR-2 |
| 4 | Warden mode in the edge: cost from Warden, ledger correlation | WFR-3, WFR-4 |
| 5 | Portal provisioning sync and reconcile loop | WFR-1, WFR-5 |
| 6 | Hand per-app budgets to Warden | Step 5; WFR-7 for the burst cap |
| 7 | Per-user budgets and rate limits | WFR-2, WFR-6; WFR-8 for rate limits |
| 8 | Map Warden errors to the gateway contract | — (refined by WFR-11) |
| 9 | Budget webhooks into the portal | WFR-11 |
| 10 | Reconciliation against Warden usage | WFR-3, WFR-9 |
| 11 | Workload identity instead of a static token | WFR-12 |

### Step 1 — Route through Warden with one token (no Warden changes)

- **Warden setup:** one team, one project (`helix-shared`) and one project token.
  Create a route alias for each `MODEL_PRICING` id Helix serves, so Helix's model ids
  resolve unchanged.
- **Helix configuration:**
  - Point `EDGE_LLM_ENDPOINT` and `EDGE_LLM_OPENAI_ENDPOINT` at Warden.
  - Set `EDGE_LLM_ANTHROPIC_PATH=/api/v1/messages` and
    `EDGE_LLM_OPENAI_PATH=/api/v1/chat/completions`.
  - Seed one `platform` secret, `warden`, with the `header-bearer` injection, and point
    both `EDGE_LLM_*_CONNECTION` variables at it.
- **Helix behavior:** unchanged. Pricing and budgets stay in the edge, and Warden adds
  routing, failover and guardrails.
- **Verify before relying on it:** Warden's `/v1/messages` translates through its chat
  pipeline (`routes/anthropic.py:585`). Confirm its stream carries input and cache
  token counts on `message_start`, and output tokens on `message_delta`, in the shape
  `mapAnthropicStream` reads (`apps/edge/src/gateway/provider.ts:98-156`). If it
  doesn't, route `claude-*` through the OpenAI-compatible surface in Warden mode.
- **Docs:** a Warden section in `docs/features/llm-gateway.md`.

### Step 2 — Catalogue and servable set from Warden (no Warden changes)

- Set the ADR-0047 servable set (`PORTAL_LLM_MODEL_ALLOWLIST`) to the aliases Warden
  serves. Or have the portal read `GET /api/v1/models` with the gateway token at boot.
- `MODEL_PRICING` stays the catalogue of models Helix knows how to route and describe.
  In Warden mode it is no longer the price source.

### Step 3 — `warden-gateway` injection (blocked on WFR-1, WFR-2)

- **Injection kind:** add `warden-gateway` to `INJECTION_KINDS`
  (`packages/shared/src/secrets.ts:215`). Implement it in `applyInjection`
  (`apps/egress/src/proxy.ts:166`): bearer token, plus `X-Warden-Project` and
  `X-Warden-Subject` derived from the verified instruction as in decision 3–4.
- **Scope:** only valid for `capability: "llm"`. Egress refuses it on a `fetch`
  instruction.
- **Migration:** re-seed the `warden` secret with the new kind and move the Warden
  side to a gateway token.
- **Adversarial tests (`apps/egress`):**
  - An app-supplied `X-Warden-*` header never reaches Warden.
  - A `fetch` instruction can never select this injection.
  - The project and subject always match the signed instruction.
- **Telemetry:** extend `spanAttributes.test.ts` to show the subject never appears on
  a span. `userOid` is never a dimension.

### Step 4 — Warden mode in the edge (blocked on WFR-3, WFR-4)

- **Config:** add `EDGE_LLM_BACKEND` (`direct` | `warden`, default `direct`) to
  `apps/edge/src/config.ts`.
- **Cost source:** in Warden mode, `recordOnce` (`apps/edge/src/gateway/llm.ts:254`)
  takes cost from the `usage.warden` extension instead of `costUsd`.
- **Ledger correlation:** a new nullable `gateway_calls.backendUsageId` column holds
  Warden's usage id. The schema is owned by the portal migration.
- **Missing cost data:** a stream that ends without the extension is recorded with the
  catalogue estimate and an `errorDetail` marker. It is never recorded as $0.
- **Admission check:** the edge stops requiring a `MODEL_PRICING` price before calling
  Warden (`llm.ts:144` onward). It still requires the model to be in the app's
  allowlist.
- **Telemetry:** a bounded `llm.backend` attribute on the existing LLM span, added as
  an `ATTR_*` constant in `packages/shared/src/telemetry.ts`, with the observability
  inventory updated.

### Step 5 — Portal provisioning sync (blocked on WFR-1, WFR-5)

- **Credential:** the portal holds a **team-admin** Warden admin key, as a portal secret
  through `@azx-pbc/secret-store`. It is never a platform-admin key.
- **Sync:** on app approval, manifest change or delete, upsert the project
  `helix-<appId>-<env>`: allowlist, plus its daily budget window from `dollarsPerDay`.
  Deleting an app soft-deletes the project.
- **Reconcile:** a background loop re-pushes any app whose last push failed or whose
  manifest version is newer than the last push.
- **Telemetry:** the outbound hop and the loop are seams. Add spans and
  `event: warden.sync.*` log lines. The portal has no metric instruments (ADR-0037
  decision 8); adding one for sync failures is a separate decision.

### Step 6 — Hand per-app budgets to Warden (blocked on step 5; WFR-7 for the burst cap)

- In Warden mode, skip the edge's `dollarsPerDay` pre-check and rolling-hour burst
  check (`llm.ts:183-215`).
- Until WFR-7 lands, the hour cap is not expressible in Warden. Either keep the edge's
  burst check in Warden mode, or accept no burst cap.
- **Known semantic differences:**
  - Warden reserves a cost estimate before the call; Helix blocks new calls but lets
    in-flight ones finish.
  - Warden's daily window is UTC; Helix's is server-local midnight.
  - Warden fails open on a Redis or DB outage by default (`metering/budget.py:619-660`).
    Operators should know this before relying on Warden caps.

### Step 7 — Per-user budgets and rate limits (blocked on WFR-2, WFR-6; WFR-8 for rate limits)

- Add deployment-level per-user defaults: a portal setting, pushed as the team's
  default end-user window (WFR-6) and rate limit (WFR-8).
- An optional per-app override can go in the manifest's `llm` capability. That would
  be a classifier change under ADR-0016: a per-user cap above baseline is elevated.
- Direct mode does not get per-user caps from this ADR. Adding them there is separate
  work.

### Step 8 — Map Warden errors to the gateway contract (no Warden changes; refined by WFR-11)

- Warden `402` maps to the existing `429 quota_exceeded`, with `Retry-After` taken
  from `X-Warden-Budget-Window-End`.
- Warden `429` maps to `429 rate_limited`; this mapping exists today
  (`llm.ts:444-482`).
- A Warden allowlist rejection maps to the edge's model-not-allowed error. Confirm
  Warden's status code for it during this step.
- Ledger outcomes stay in the existing vocabulary (`quota_blocked`, etc.), so the Usage
  tab needs no change.
- Can ship alongside step 1, since Warden can already return 402 on a project cap.

### Step 9 — Budget webhooks (blocked on WFR-11)

- A portal endpoint verifies Warden's HMAC-signed webhooks
  (`webhooks.py:136-171`) and records `budget.warning` / `budget.exceeded` against the
  app. The Overview tab surfaces them.
- Telemetry: a new inbound route on the portal gets a span.

### Step 10 — Reconciliation (blocked on WFR-3, WFR-9)

- A daily job compares ledger totals per `(app, env, day)`, and optionally per subject,
  with Warden's usage API. It reports drift as a log event.
- This is an operator check. Neither side corrects the other.

### Step 11 — Workload identity (blocked on WFR-12)

- Add an injection variant that mints a managed-identity token in egress, reusing the
  ADR-0046 path, in place of the static gateway token.

## Consequences

- **Small Helix footprint.** Warden mode is an injection kind, a backend flag in the
  edge, and a portal sync loop. Most of the work is in Warden, where it benefits every
  multi-tenant caller, not just Helix.
- **Wider token blast radius.** Holding the gateway token allows acting as any app and
  any user under the Helix team. That matches what egress can already do with every
  platform and app secret. The token gets the same custody as the vendor keys it
  replaces.
- **Two copies of usage data.** Helix's ledger and Warden's `usage_events` both record
  each call. The ledger is audit and the source for the portal UI. Warden is
  enforcement and the source for chargeback. Step 10 keeps them comparable.
- **Subjects in Warden are personal-data-adjacent.** Warden keeps raw usage rows 90
  days by default, and `oid` is a stable directory id. WFR-2's strip mode keeps the
  subject away from model vendors. WFR-9's erasure endpoint is what Helix's eventual
  ledger retention and erasure work (`TODO.md`) will call.
- **Abandoned streams.** Warden bills abandoned streams. In Warden mode, Helix's known
  gap of metering a client-aborted call at $0 while the vendor still bills it
  (`TODO.md`) closes for Warden-side budgets.
- **Rejected: per-app Warden tokens.** Workable today, but it makes Helix a token
  lifecycle system: minting, storage, rotation, revocation and drift repair per app.
  WFR-1 moves the per-tenant boundary to configuration, where drift is harmless.
- **Rejected: subject in the request body, set by the edge.** It works with today's
  Warden, but the value is client-controlled from Warden's point of view, optional, and
  forwarded to the vendor. Asserting it in egress from the signed instruction keeps the
  edge out of the Warden trust path, as it already is for secret injection.
