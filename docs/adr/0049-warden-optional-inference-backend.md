# ADR-0049 — Warden as an optional inference backend

## Status

Proposed _(2026-10-01; amended 2026-10-02)_.

- **Phase 1, the light integration, is proposed.** Warden becomes an optional LLM
  upstream behind Helix's existing gateway.
- **Phase 2, the deep integration, is deferred.** That is where Warden would take over
  per-app and per-user enforcement. The criteria for reopening it are below.

None of the Warden feature requests are filed yet.

**Related:** ADR [0008](0008-llm-key-via-egress.md) (vendor key held by egress),
ADR [0013](0013-egress-trust-model.md) (attested instructions and their trust limits),
ADR [0021](0021-metering-ledger.md) (the `gateway_calls` ledger), ADR
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
dollar cap.

ADR-0033 already made the upstream base URL configuration so that Warden could be
added. Warden ships `docs/helix-integration.md`, which describes that config-only path.
Warden code is cited at commit `70975c31`.

### Why there are two phases

The first draft of this ADR planned a deep integration. In it, Warden would own:
- pricing;
- per-app budgets;
- per-user budgets and rate limits.

Helix would push configuration to Warden and record Warden's cost. That needs 13
Warden feature requests and an 11-step Helix plan, and on review it buys Helix
little today:

- **Per-user metering is cheap in Helix.** Every `gateway_calls` row already records
  `userOid` and a micro-USD cost. A per-user cap is the per-app budget query
  (`apps/edge/src/gateway/usage.ts:294`) with one more predicate and index. A per-user
  rate limit can reuse `PgCounterStore`.
- **Helix keeps most of the work anyway.** It still owns authentication,
  authorization, the manifest and approval flow, the ledger and the wire codecs. Deep
  integration adds a sync loop, a reconcile loop, a cost-source switch and a second
  budget path. It removes only pricing, the daily-cap check and vendor routing.
- **Two enforcement paths would have to be maintained.** Most deployments run direct
  mode, so the Warden enforcement path would be the one that rots.
- **Helix's per-user features would depend on another roadmap.** The central request,
  delegating gateway tokens, is likely to be contested.
- **Warden's metering is coarser than Helix's** (whole cents per request against
  micro-USD), and its budgets fail open on a Redis outage by default.

What Warden does offer that Helix should not build:
- routing and failover across many providers, including self-hosted models;
- guardrails (moderation, PII redaction);
- one organization-wide view of LLM spend and policy.

A light integration delivers all three without moving enforcement out of Helix.

It also serves a second goal. Warden has no production users yet. Running Helix
traffic through it gives Warden real usage. Because Helix keeps its own independent
meter, that usage comes with a ledger to reconcile Warden's numbers against.

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
  an `end_user` budget scope keyed `"<project>:<user>"`. It is client-controlled,
  optional, and forwarded to the model vendor unchanged
  (`providers/openai_compat.py:546`). `/v1/responses` drops it
  (`routes/responses.py:253,401`).
- **The project token reaches more than inference.** The same token is accepted on:
  - files and batches;
  - the raw provider passthrough (`/v1/passthrough/*`);
  - A2A (`/v1/a2a`);
  - MCP (`/mcp`);
  - token self-management (`/v1/keys/self/*`).

  Helix uses only chat completions and `/v1/messages`.

## Decision

1. **Warden is an optional upstream, off by default.** Direct mode, today's code path,
   stays fully supported and is the default. Warden mode is selected per deployment,
   never per app. No hosted app can tell which mode is running.

2. **Phase 1 keeps enforcement in Helix in both modes.**
   - Helix keeps pricing, the ledger, per-app budgets, and authorization.
   - Per-user caps are built natively in Helix, so they work identically in both
     modes. That is a separate ADR.
   - Warden adds routing, failover, guardrails and its own usage view.
   - Where Warden also enforces a limit (a team or project cap set by its operator),
     the lower limit wins. The two layers never have to agree.

3. **One project token, held by egress.** Phase 1 uses one Warden project
   (`helix-<deployment>`) and one project token. The token is stored as a `platform`
   secret like the vendor keys (ADR-0008), so the edge never holds it. Helix never
   creates Warden objects.

4. **Egress pins the Warden paths.**
   - Platform-secret injection recipes gain an optional allowed-paths list, a set of
     `METHOD path` pairs.
   - The Warden secret allows only `POST /api/v1/chat/completions` and
     `POST /api/v1/messages`. Egress refuses anything else before dialing out.
   - A compromised edge chooses the instruction's path, so this check must belong to
     egress and not compare against the instruction.
   - Without it, an edge compromise could use the project token on every Warden route
     listed above, including `/v1/keys/self/revoke`.

5. **Egress sends the user as a subject, and Warden keeps it from the vendor.** A
   `warden` injection kind sends `X-Warden-Subject`, derived from the verified
   instruction:
   - the principal oid (ADR-0048) for `user` callers;
   - the `pw_…` pseudonym for `password` callers;
   - the literal `anon` for anonymous callers.

   This depends on WFR-1. Until it ships, Helix sends no subject, and Warden's usage is
   attributed only to the project.
   - The app cannot set the header: it is not on the request-header safelist
     (`packages/shared/src/fetch.ts:90`), and the edge rebuilds the upstream body
     rather than passing the app's through.
   - The edge still chooses `userOid`, because it mints the instruction. ADR-0013
     records that a single multi-tenant minter can always forge any tenant. This design
     keeps the credential away from the edge, not the choice of user.

6. **Responsibilities by mode.**

   | Concern | Direct mode | Phase 1 Warden mode | Phase 2 (deferred) |
   |---|---|---|---|
   | End-user login, app visibility, CSRF, same-origin `/_api/*` | Helix | Helix | Helix |
   | Manifest, model allowlist, approval (ADR-0016) | Helix | Helix | Helix, pushed to Warden |
   | Per-IP limit for anonymous callers | Helix | Helix | Helix |
   | Provider keys, routing, failover | Helix | Warden | Warden |
   | Guardrails | none | Warden (operator-configured) | Warden |
   | Pricing and cost in the ledger | Helix | Helix | Warden, reported back |
   | Per-app budget | Helix | Helix | Warden |
   | Per-user budget and rate limit | Helix (separate ADR) | Helix | Warden |
   | Audit row per call (`gateway_calls`) | Helix | Helix | Helix |
   | Org-wide LLM spend view | none | Warden (per project, and per subject with WFR-1) | Warden (per app and per subject) |

## Phase 1 — the light integration

### Phase 1 Warden feature requests

Each can be filed as its own GitHub issue.
- **WFR-1** is the only one Phase 1 needs.
- **WFR-2** is a standalone bug, worth filing regardless.
- **WFR-3** is a correctness issue that the battle-test reconciliation will show.
- **WFR-4** is optional.

#### WFR-1 — Trusted end-user subject header

**Problem.** `end_user_id` comes from a body field the client controls. It is optional,
it is forwarded to the model vendor, and it is missing on `/v1/responses`. A calling
gateway that has already authenticated the user needs a way to attribute usage that
it controls and that never leaves Warden.

**Proposal.**

- A per-token flag, `trusted_subject`, set when the token is minted or patched.
- On a flagged token, a request header `X-Warden-Subject: <opaque id>` sets
  `end_user_id` and overrides `user` / `metadata.user_id` from the body. On an
  unflagged token the header returns 400; it is never silently ignored.
- Scoping is `"<project>:<subject>"`, as for `end_user_scope_id` today.
- On flagged tokens, the end-user identifier is removed from the upstream request:
  strip `user`, `metadata.user_id` and `safety_identifier`.
- Optionally, a `hash` mode forwards an HMAC of `project:subject` under a Warden-held
  key, for vendors that want a stable abuse-monitoring id.

**Acceptance criteria.**

- Subjects are 1–256 printable ASCII characters. Anything else returns 400.
- The header does not trigger the global `end_user_budgets` registration gate (see
  WFR-2).
- In strip mode, no end-user identifier reaches the upstream request on any ingress. A
  test asserts this per provider adapter.
- Chat completions, completions, embeddings, `/v1/messages` and `/v1/responses` (HTTP
  and WebSocket) all honour the header.
- The subject is never a metrics label. It is recorded on usage rows and audit only.

**Code pointers.** `filter_chain.py:1383-1403, 1849-1851` (extraction),
`routes/anthropic.py:587-592`, `routes/responses.py:253-266, 401-409`,
`providers/openai_compat.py:546`, `models.py:1768` (`TokenPolicy`).

#### WFR-2 — Fix end-user registry and enforcement id mismatch (bug)

**Problem.**
- `check_end_user_binding` compares the raw id against the registry, but limit lookup
  uses `"<project>:<user>"` (`metering/budget.py:503-528, 561-591`). So a row created
  with the documented `POST /end-user-budgets` passes the binding check and is never
  enforced, and a composite-id row is enforced but fails the binding check.
- Separately, the registry is global. One row anywhere makes `user` mandatory for every
  project in the deployment. For Helix, an operator registering one end user for
  another product would make every Helix call fail with 403.

**Proposal.** Make the registry per project, keyed on the composite id in both checks.
Have the admin API take `project_id` plus `end_user_id` and build the composite itself.
Migrate existing raw rows, or report them.

**Acceptance criteria.**

- A row registered through the API is enforced.
- Registering an end user in project A has no effect on project B.

#### WFR-3 — Sub-cent cost precision

**Problem.** `cost_cents INTEGER` is floored per request and per component
(`metering/pricing.py:136-140, 411-463`). A chat call costing under one cent records 0.
Totals are therefore biased low. The error is largest for many small calls, which is
Helix's traffic pattern. In Phase 1, it shows up as Warden reporting much less spend
than Helix's ledger.

**Proposal.**

- Add `usage_events.cost_micro_usd BIGINT`, computed without per-component truncation.
  `cost_cents` stays as a derived column for compatibility.
- Budget accounting, the Redis reservations and the rollups sum the precise value and
  round only when displaying.

**Acceptance criteria.**

- A request priced at $0.0004 records 400 micro-USD.
- 1,000 such requests show $0.40 in usage and budget reads, not $0.
- Existing cent-based admin API fields keep their meaning.

#### WFR-4 — Workload-identity authentication for inference tokens (optional)

**Problem.** A project token is a static, long-lived secret. Helix already avoids
static secrets for Azure-hosted upstreams by minting managed-identity tokens in egress
(ADR-0046).

**Proposal.**

- Wire the existing `get_principal_from_jwt` / `OIDCProvider.validate_access_token`
  path (`auth/dependency.py:379-417`, `auth/oidc.py:823-935`) to inference.
- An admin binds a client identity from a configured issuer (`azp`/`appid`, plus an
  optional required app role) to a project-token policy, once.
- A valid JWT from that client then behaves as that token, including WFR-1.

**Acceptance criteria.**

- A JWT from an unbound client returns 401.
- An expired JWT, or one with the wrong audience, returns 401.
- Unbinding the client takes effect on Warden's next check, without waiting for
  issued JWTs to expire. Managed-identity tokens can live up to 24 hours.
- The issuer config states which Entra token version it expects (v1
  `sts.windows.net` or v2 `login.microsoftonline.com/.../v2.0`). A mismatch fails with
  a clear error, not a generic 401.

### Phase 1 implementation plan

| Step | What | Blocked on |
|---|---|---|
| 1 | Config-only routing through one Warden project | — |
| 2 | Map Warden errors to the gateway contract | — |
| 3 | Allowed-paths pinning on platform-secret injection | — |
| 4 | Servable model set from Warden aliases | — |
| 5 | Battle-test runbook: reconcile the ledger against Warden | — (WFR-3 makes the numbers agree) |
| 6 | `warden` injection kind: subject header | WFR-1; WFR-2 recommended first |
| 7 | Workload identity instead of the static token (optional) | WFR-4 |

#### Step 1 — Route through Warden (no Warden changes)

- **Warden setup (once per deployment):** one team, one project (`helix-<deployment>`)
  and one project token. Create a route alias for each `MODEL_PRICING` id Helix serves,
  so Helix's model ids resolve unchanged. Any guardrails or caps the operator wants are
  set on the project.
- **Helix configuration:**
  - Point `EDGE_LLM_ENDPOINT` and `EDGE_LLM_OPENAI_ENDPOINT` at Warden.
  - Set `EDGE_LLM_ANTHROPIC_PATH=/api/v1/messages` and
    `EDGE_LLM_OPENAI_PATH=/api/v1/chat/completions`.
  - Seed one `platform` secret, `warden`, with the `header-bearer` injection, and point
    both `EDGE_LLM_*_CONNECTION` variables at it.
- **Helix behavior:** unchanged. Pricing, budgets and the ledger stay in the edge.
- **Verify before relying on it:**
  - **Anthropic stream shape.** Warden's `/v1/messages` translates through its chat
    pipeline (`routes/anthropic.py:585`). Confirm its stream carries input and cache
    token counts on `message_start`, and output tokens on `message_delta`, in the
    shape `mapAnthropicStream` reads (`apps/edge/src/gateway/provider.ts:98-156`). If
    it doesn't, file it upstream and route `claude-*` through the OpenAI-compatible
    surface meanwhile.
  - **Structured output.** Confirm it passes through on both families.
- **Docs:** a Warden section in `docs/features/llm-gateway.md`, and the Bicep or
  operator wiring in `infra/azure/README.md` if Warden is deployed alongside.

#### Step 2 — Map Warden errors to the gateway contract (no Warden changes)

- Warden `402` maps to the existing `429 quota_exceeded`, with `Retry-After` taken
  from `X-Warden-Budget-Window-End`. This only happens when the Warden operator has set
  a cap.
- Warden `429` maps to `429 rate_limited`; this mapping exists today
  (`llm.ts:444-482`).
- A Warden allowlist rejection maps to the edge's model-not-allowed error. Confirm
  Warden's status code for it during this step.
- A guardrail block maps to the existing `refusal` outcome.
- Ledger outcomes stay in the existing vocabulary, so the Usage tab needs no change.

#### Step 3 — Allowed-paths pinning (no Warden changes)

- **Recipe field:** add an optional `allowedPaths` (`METHOD path` pairs) to the
  platform-secret injection recipe (`packages/shared/src/secrets.ts`).
- **Enforcement:** egress refuses a request whose method and path aren't listed,
  before resolving the credential or dialing out (`apps/egress/src/proxy.ts`).
- **Seeding:** the `warden` secret is seeded with the two paths in decision 4. The same
  field can later pin the first-party vendor keys, though this ADR doesn't require it.
- **Adversarial test:** an instruction naming `/v1/keys/self/revoke`, `/mcp`,
  `/v1/files` or `/v1/passthrough/*` is refused.
- **Telemetry:** the refusal is a new denial. It logs under the egress `event`
  convention, and the existing egress span records the outcome.

#### Step 4 — Servable set from Warden (no Warden changes)

- Set the ADR-0047 servable set (`PORTAL_LLM_MODEL_ALLOWLIST`) to the aliases Warden
  serves.
- `MODEL_PRICING` stays Helix's catalogue and price source in Phase 1.

#### Step 5 — Battle-test runbook (no Warden changes; WFR-3 makes the numbers agree)

This step is the main way Phase 1 helps Warden mature. It is an operator runbook in
`docs/runbooks/`, not code.

- **Daily comparison:** Helix's ledger totals per model, from the portal's
  `/api/v1/gateway/usage` or a SQL query, against Warden's usage for the Helix project
  (`GET /admin/api/usage?project=…&group_by=model_id&time_bucket=day`). Compare token
  counts and cost.
  - Token counts should match exactly.
  - Cost will differ until WFR-3 lands, and the drift itself is evidence for it.
- **Other checks to run and record:**
  - streaming usage completeness on both families;
  - abandoned-stream billing (Warden bills them, Helix records $0: `TODO.md`);
  - latency added per call;
  - behaviour during a Warden restart and a Redis outage.
- **Output:** discrepancies are filed as Warden issues.

#### Step 6 — Subject header (blocked on WFR-1; WFR-2 recommended first)

- **Injection kind:** add `warden` to `INJECTION_KINDS`
  (`packages/shared/src/secrets.ts:215`). It is `header-bearer` plus
  `X-Warden-Subject`, set in `applyInjection` (`apps/egress/src/proxy.ts:166`) from
  the verified instruction's `userOid` and `userKind`, as in decision 5.
- **Scope:** only valid for `capability: "llm"`. Egress refuses it on a `fetch`
  instruction. The step 3 path pinning still applies.
- **Warden side:** set `trusted_subject` on the Helix project token.
- **Adversarial tests (`apps/egress`):**
  - An app-supplied `X-Warden-*` header never reaches Warden.
  - A `fetch` instruction can never select this injection.
  - The subject always matches the signed instruction.
- **Telemetry:** extend `spanAttributes.test.ts` to show the subject never appears on
  a span. `userOid` is never a dimension.

#### Step 7 — Workload identity (optional; blocked on WFR-4)

- Extend `EGRESS_MANAGED_IDENTITY_CONNECTIONS` so each rule carries its own token
  audience. Today the audience is one constant with an env override
  (`EGRESS_MANAGED_IDENTITY_RESOURCE`).
- Add a `warden` rule with Warden's app-registration audience. In Bicep, assign the
  egress identity Warden's app role.
- Delete the static `warden` secret once this is live. A stored secret still wins in
  local dev, as for Foundry.

### Phase 1 security notes

- **Warden joins the trusted path for LLM traffic.** It sees every prompt and response
  and holds the vendor keys. Choosing Warden mode is the operator's decision, the same
  as choosing a vendor.
- **What egress holds changes.** Egress holds a Warden project token instead of raw
  vendor keys. That token is metered by Warden and revocable by its operator, and
  capped if the operator sets a project budget.
- **An edge compromise.** It can spend as any app or user through Warden, as it can
  through the vendor keys today. Step 3 limits it to the two inference paths.
- **The subject never reaches the model vendor** once WFR-1's strip mode is on.
- **Warden budgets fail open on a Redis or DB outage by default**
  (`metering/budget.py:619-660`). Helix's own budgets still apply, so Phase 1 does not
  depend on Warden enforcement.

## Phase 2 — the deep integration (deferred)

Phase 2 would move per-app and per-user enforcement into Warden. Helix would
provision one Warden project per app over the API, through a delegating gateway token
held by egress. A narrow configuration key in the portal would push each app's
allowlist and budgets. The ledger would record Warden's cost.

It is deferred because, today, it duplicates enforcement Helix already has or can build
cheaply, and it depends on the most contested Warden changes.

### When to reopen it

Reopen Phase 2 when at least one of these is true:

- The organization decides to centralize LLM budget and policy enforcement in Warden
  across products. Helix would then be one tenant among several.
- Helix needs enforcement features Warden has and Helix should not build: guardrail
  floors per app, or provider-key scoping per app.
- Phase 1 has run in production long enough that Warden's metering reconciles with
  Helix's ledger. Then handing enforcement to it is a low-risk swap.

### The design, if reopened

**Credentials.** Two Warden credentials, split by Helix's planes:
- **Gateway token, in egress.** A team-scoped gateway token (WFR-5) that asserts the
  project per request with `X-Warden-Project: helix-<appId>-<env>`. Helix's budgets
  are per `(appId, env)`, so the project follows that grain.
- **Configuration key, in the portal.** A permission-scoped admin key (WFR-6), allowed
  only to upsert projects and set budget windows. It cannot mint tokens.
- **Later, managed identities.** Both become managed identities by extending WFR-4.

**Projects.** The portal upserts each app's project on approval, manifest change and
delete, and a reconcile loop retries failures. Nothing is configured by hand per app.

**Rejected alternative: per-app Warden tokens.** They work with today's Warden, but
make Helix a token lifecycle system: minting during app creation, per-app rotation,
revocation on delete, repairing partial failures. The security analysis below shows
they contain no Helix-container compromise better than a gateway token. They also rule
out workload identity, because one workload has one identity. If Warden declines WFR-5,
they are the fallback: the portal mints a token per app, stored as an app-scoped
secret, and egress resolves `llm` secrets by app. That last part is ADR-0013 step 2's
per-action check on the `llm` path.

### Phase 2 security analysis

Reach is the Warden access an attacker gets, comparing the Phase 2 design with per-app
tokens.

| Compromised | Per-app tokens | Gateway credential |
|---|---|---|
| Hosted app (untrusted JS) | None | Same |
| Edge (RCE) | Mints instructions for any `appId`/`userOid`; egress injects that app's token. Never sees a token. | Same, limited to the pinned paths |
| Egress (RCE) | `helix_egress` can `SELECT` all of `app_secrets`, so every app token. | The one gateway credential. Same reach |
| Portal (RCE) | A key that can mint tokens, plus plaintext tokens on every app create. | A key that configures projects and budgets within team ceilings but cannot mint (WFR-6). |
| Static secret leaked short of RCE | One app. | Every app and user. With workload identity there is no static secret. |
| Network between egress and Warden | Token stealable without TLS. | Token stealable and headers rewritable without TLS. Both need TLS. |

Conclusions:
- No Helix-container compromise is better contained by per-app tokens, because egress
  holds every credential and the edge chooses the tenant in both designs (ADR-0013).
- Per-app tokens win only on a partial static-secret leak, which workload identity
  removes.
- The portal is better off with the gateway design.

**The case for per-app tokens, which Warden's maintainers are likely to raise:**

1. **A gateway token adds a delegation primitive to Warden's auth.** Its authority
   depends on a header. That opens a bug class, state keyed by credential instead of
   by project, for every Warden deployment, not only those serving Helix.
2. **One credential is worth every tenant.**
3. **A team-scoped token moves authority from the Warden operator to the caller.**
4. **Attribution becomes asserted rather than authenticated.**

WFR-5 answers these as follows:
- **Narrower delegation.** It limits delegation to a default-deny set of routes, with
  a red-team test for each piece of per-credential state.
- **Keeping the operator in control.** The team budget, allowlist and guardrail floor
  bound every project, and an optional project cap and id prefix bound the namespace.
- **Asserted attribution.** Per-app tokens are selected by egress because the edge
  named the app, so they are no stronger on this point.

### Phase 2 Warden feature requests

These are kept at issue-ready detail so Phase 2 can start without redoing the
analysis. Phase 2 also extends WFR-1 and WFR-4 to gateway tokens and admin keys.

#### WFR-5 — Delegating gateway tokens: assert the project per request

**Problem.** A caller that is itself a multi-tenant gateway must hold one token per
downstream tenant to get per-tenant budgets, allowlists and usage. That makes the
caller run a token-provisioning and rotation system.

**Proposal.**

- **A team-scoped token kind.** For example `TokenPolicy.gateway = true`. A request on
  it names its project in `X-Warden-Project: <project id>`. The project must already
  exist in the token's team.
- **Policy resolution.** Warden resolves the project's policy as if a project token had
  been presented: allowlist, budgets and windows, guardrail floor, provider-key
  resolution, RPM/TPM/RPS and concurrency. The gateway token's own limits apply on top
  as a ceiling. Team limits bound every project through the existing
  child-not-looser-than-parent rule (`metering/ceiling.py`).
- **Attribution.** The usage row records the asserted `project_id` and the gateway
  `token_id`.
- **Delegation-aware routes only.** Gateway tokens work only on routes made
  delegation-aware, initially the inference ingresses and `/v1/models`. Every other
  route rejects them with 403 until extended deliberately. Reasons for the exclusions:
  - files and batches are stored objects;
  - passthrough reaches vendor-side objects under a shared key;
  - A2A dials caller-supplied URLs;
  - MCP can mint tokens;
  - self-revoke takes down every tenant.

  Token-scoped reads join the set once they are scoped to the asserted project.
  Gateway tokens never carry admin `scopes`.
- **Optional team settings, off by default:**
  - `auto_create_projects`;
  - a required project-id prefix;
  - a maximum project count.

**Acceptance criteria.**

- **Header rules:**
  - The header is accepted only on gateway tokens, and returns 400 on any other.
  - A project in another team returns 403 with an audit entry.
  - A missing header returns 400. Warden never picks a default project.
- **Route coverage:** the delegation-aware route set is an explicit allowlist. A test
  enumerates every registered route and fails when a new one accepts gateway tokens
  without being listed.
- **Per-project keying.** Every piece of per-credential state is keyed by the asserted
  project, each with its own red-team test:
  - the token-policy cache and its revocation tombstones;
  - the response cache (also keyed by subject);
  - idempotency keys;
  - concurrency counters;
  - rate-limit keys;
  - budget reservations.
- **Revocation:** revoking the token, or soft-deleting the project, stops requests
  within the existing cache TTL.
- **Minting:** needs team-admin or higher within the team, plus an explicit
  `confirm: true`.

**Code pointers.** `auth/dependency.py:361-377`, `auth/tokens.py:58-71`,
`models.py:1768`, `filter_chain.py:100-138`. Routes using `get_principal_from_token`:
`routes/inference.py`, `routes/anthropic.py`, `routes/responses.py`,
`routes/responses_ws.py`, `routes/files.py`, `routes/batches.py`,
`routes/self_keys.py`, `mcp.py`, `a2a.py`.

#### WFR-6 — Permission-scoped admin keys

**Problem.**
- Admin keys are role-based. The smallest role that can manage projects is team-admin,
  which also has `tokens:mint`, `tokens:list` and `tokens:revoke`
  (`auth/policy.py:101-106`).
- Setting budget windows needs `budgets:set`, which only platform-admin holds
  (`auth/policy.py:119-126`). So pushing per-tenant budgets needs a platform-admin key.

**Proposal.**

- **Explicit permission lists.** Admin keys can be minted with a permission list scoped
  to a team, for example `{projects:manage, budgets:set}`. The list must be a subset of
  what the minter holds.
- **`budgets:set` at team scope.** It becomes grantable at team scope. The
  budget-window routes already check it against the resource's team lineage
  (`routes/admin.py:6285-6310`). The `end_user` scope gains a lineage through its
  project.

**Acceptance criteria.**

- A `{projects:manage, budgets:set}` key can upsert projects and set budget windows in
  its team. It gets 403 on token operations, other teams and everything else.
- `MintAdminKeyRequest` keeps `extra="forbid"` (`routes/admin.py:1882-1894`).

#### WFR-7 — Return cost and a correlation id to the caller, and store both

**Problem.** A calling gateway that keeps its own ledger cannot record Warden's cost or
point at Warden's usage row without re-deriving the price.

**Proposal.**
- Store an inbound `X-Request-ID` as `usage_events.request_id`, indexed. Warden already
  validates and echoes the header (`app.py:199-207`).
- Return cost and usage id as headers on non-streaming responses
  (`X-Warden-Cost-Micro-Usd`, `X-Warden-Usage-Id`).
- On streams, return them as an extension on the final usage chunk
  (`usage.warden = { cost_micro_usd, usage_id, project_id }`), or on the final
  `message_delta` for `/v1/messages`.

**Acceptance criteria.**
- The streamed cost equals the stored cost.
- Standard OpenAI and Anthropic SDKs parse the stream without errors.
- Rows can be looked up by `request_id`.

#### WFR-8 — Idempotent project upsert by caller-chosen id

**Problem.** Project ids are caller-supplied (`models.py:1725`), but `POST /projects`
conflicts on an existing id, and `PUT /projects/{id}` returns 404 on a missing one
(`routes/admin.py:4815-4830`).

**Proposal.** `PUT /admin/api/projects/{id}?create=true`, or a dedicated upsert route.

**Acceptance criteria.**
- Repeated calls are no-ops.
- Concurrent creates produce one project.
- A team-scoped key upserts only within its team.

#### WFR-9 — Default per-end-user budget windows

**Problem.** End-user caps need one row per end user, and setting them is
platform-admin only (`routes/admin.py:6299-6307`).

**Proposal.**
- Add a project-level (and team-level, inherited) default end-user window that applies
  to every `project:subject` scope without a per-subject row.
- Explicit rows still override it, within the ceiling rule.

**Acceptance criteria.**
- With a $1/day default, a subject's second $0.60 request returns 402 with
  `X-Warden-Budget-Window-End`.
- Other subjects in the same project are unaffected.

#### WFR-10 — Sub-day rolling budget windows

**Problem.** Rolling windows take `window_days` (`routes/admin.py:1661-1700`). Helix's
burst cap is one sixth of the daily budget over a rolling hour
(`apps/edge/src/gateway/llm.ts:55`).

**Proposal.** Accept `window_hours` or `window_seconds` at every scope.

**Acceptance criteria.** A one-hour window caps spend over any 60-minute span.

#### WFR-11 — `end_user` rate-limit scope

**Problem.** Rate-limit scopes stop at the token, user, project, team and org
(`metering/ratelimit.py:205-358`).

**Proposal.** An `end_user` rung keyed `rl:{kind}:end_user:{project}:{subject}:{bucket}`,
with project or team defaults.

**Acceptance criteria.** With a per-subject limit of 10 RPM, the 11th request returns
429 for that subject only.

#### WFR-12 — `end_user` in usage queries, rollups and erasure

**Problem.** Per-subject usage can only be read with SQL. The rollups drop the column
(`migrations/versions/0001_baseline.sql:1294-1296`).

**Proposal.**
- Add `end_user_id` to `_FILTER_COLUMNS` and `_ALLOWED_GROUP_BY` (`meter.py:23-33,
  125-138`), to export and to chargeback.
- Add an opt-in rollup grain that keeps it.
- Add an erasure endpoint, `DELETE /admin/api/end-users/{project}/{subject}`.

**Acceptance criteria.**
- Grouping by `end_user` matches the raw sum.
- After erasure, no row matches the subject.

#### WFR-13 — Project and subject on budget webhooks

**Problem.** The `budget.exceeded` payload carries only `{scope, estimated_cost_cents}`
(`filter_chain.py:1891-1900`).

**Proposal.** Include `project_id`, `scope_id`, `window_type`, `window_end` and
`end_user_id` on both `budget.exceeded` and `budget.warning`.

**Acceptance criteria.** The payload alone identifies the project, subject and window.

### Phase 2 implementation outline

In order, if reopened. Steps already done in Phase 1 are not repeated.

| Step | What | Blocked on |
|---|---|---|
| A | Extend the `warden` injection with `X-Warden-Project`; move to a gateway token | WFR-5 |
| B | Edge backend flag (`EDGE_LLM_BACKEND`); record Warden's cost and usage id in the ledger | WFR-7, WFR-3 |
| C | Portal provisioning sync and reconcile loop with the configuration key | WFR-5, WFR-6, WFR-8 |
| D | Hand per-app budgets to Warden | C; WFR-10 for the burst cap |
| E | Hand per-user budgets and rate limits to Warden | WFR-9, WFR-11 |
| F | Budget webhooks into the portal | WFR-13 |
| G | Automated reconciliation job replacing the Phase 1 runbook | WFR-7, WFR-12 |

Phase 2 has known semantic differences from Helix's own enforcement:
- Warden reserves a cost estimate before the call; Helix lets in-flight calls finish.
- Warden's daily window is UTC; Helix's is server-local midnight.
- Warden's budgets fail open on a Redis outage by default.

## Consequences

- **Phase 1 is small and reversible.** It is configuration, an error mapping, an
  allowed-paths field and an injection kind. Turning Warden mode off is a config
  change. Nothing about apps, manifests or the ledger differs between modes.
- **Helix keeps its enforcement, and Warden can add its own on top.** Helix enforces
  budgets in both modes, so Warden budget outages or metering defects cannot over-spend
  an app. An operator can still add team or project caps in Warden; the lower limit
  wins.
- **Per-user caps are a Helix feature, not a Warden one.** They need their own ADR, and
  they work in both modes.
- **Warden gets production traffic with an independent cross-check.** The step 5
  runbook turns Helix's ledger into a reconciliation source for Warden's metering.
  Defects found go upstream.
- **Vendor keys move to Warden in Warden mode.** Egress holds a Warden token pinned to
  two paths instead of raw vendor keys.
- **Subjects in Warden are personal-data-adjacent.** Warden keeps raw usage rows for
  90 days by default, and `oid` is a stable directory id. WFR-1's strip mode keeps the
  subject away from model vendors. Erasure on the Warden side waits for WFR-12.
- **Phase 2's analysis is kept, not discarded.** It is the starting point if the
  organization later centralizes LLM governance in Warden.
