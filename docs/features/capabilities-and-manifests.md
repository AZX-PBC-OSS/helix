# Capabilities & manifests

**What it is.** Every app carries a **manifest** that declares the capabilities the gateway will
enforce (architecture §6.3). It is the contract between the control plane (which grants) and the
data plane (which enforces): the portal writes it, the registry projection carries it to the
edge, and the LLM / app-data / fetch-proxy handlers gate every call against it. Nothing an app
does at runtime can exceed its manifest. Capability policy is **per-app**: the manifest is the
only place a grant is declared — there is no per-team or per-group capability policy (group
membership governs app *access*, not what an app may call).

Schema: `packages/shared/src/manifest.ts`. Visibility: `packages/shared/src/visibility.ts`.
Approval classifier + thresholds: `packages/shared/src/approval.ts`.

## The shape

```ts
Capabilities = {
  llm?:  { models: string[]; tokensPerDay?: int }
  data?: { user: boolean
           collections: string[]      // append-only; no app-facing read
           sharedRead: string[]       // world-readable-within-gate keys
           sharedWrite: string[]      // narrower; write never implies read
           writesPerDay?: int; bytesPerDay?: int }
  mcp: string[]                        // platform-registered MCP servers (default [])
  externalOrigins: URL[]               // extra CSP connect-src for DIRECT calls (default [])
  fetch?: { origins: { origin: URL; connection?: string }[]  // proxied via /_api/fetch (egress)
            shim: boolean                                     // serve-time fetch/XHR shim
            requestsPerDay?: int }
}

AppManifest = { app: slug; visibility: Visibility; capabilities: Capabilities }
```

`externalOrigins` (direct browser call, widened into CSP) and `fetch.origins` (routed through the
`/_api/fetch` proxy + `azx-egress`, where a secret can be injected server-side) are the "one knob,
two settings" — same mental model, different `mode`. See [edge-serving.md](./edge-serving.md) and
[fetch-proxy.md](./fetch-proxy.md) and [secrets-and-connections.md](./secrets-and-connections.md).

`Visibility` is a discriminated union — `private` | `group` (+ `groupId`) | `password` |
`public` — stored flattened in the DB (`visibilityMode` + `visibilityGroupId`) and reassembled
by the mappers.

## How grants flow and are enforced

1. **Author** edits the manifest in the portal: `GET`/`PUT /api/v1/apps/:slug/manifest`
   (`apps/portal/src/routes/apps.ts`), validated through `CapabilitiesSchema`. The PUT is a full
   **replace**, but it is **not** committed wholesale — it is routed through the approval
   write-gate (next section), which splits it into a part that commits now and a part that waits.
2. **Project** — the committed `capabilities` JSONB lands in `apps`, and the edge's LISTEN/NOTIFY
   projection picks it up (`apps/edge/src/registry/projection.ts`, parsing `llm`/`data`/`fetch`
   fail-closed). The live registry entry now carries `entry.llm` / `entry.data` / `entry.fetch`.
3. **Enforce** — each gateway handler checks the relevant grant per request:
   - LLM: `entry.llm` must exist and `chat.model ∈ entry.llm.models`; `tokensPerDay` bounds the
     daily budget (see [llm-gateway.md](./llm-gateway.md)).
   - Data: `entry.data` gates the scope, and `collections` / `sharedRead` / `sharedWrite` are
     per-name allowlists; `writesPerDay` bounds writes (see [app-data-gateway.md](./app-data-gateway.md)).
   - Fetch: `entry.fetch.origins` allowlists proxied origins; `requestsPerDay` bounds them (see
     [fetch-proxy.md](./fetch-proxy.md)).
   - CSP: `externalOrigins` extends `connect-src` at the edge (see [edge-serving.md](./edge-serving.md)).

The asymmetry between read and write grants is deliberate: the writer and reader of app-data can
be different principals (an anonymous visitor appends to a collection the owner later drains) — see
[app-data-gateway.md](./app-data-gateway.md).

## The approval write-gate

A manifest PUT does not silently commit whatever it asks for. Capability grants, CSP origin grants,
and going public are **the same problem in three hats** — a privileged actor blessing a change to
effective policy *before* the edge enforces it — so they share one spine (`docs/design/approvals.md`).
The key structural choice: **the edge stays completely dumb about approvals.** They are a
control-plane gate on *writes* to the effective state the edge already projects; the `apps` row
holds only effective state, "requested state" is just the set of open `ApprovalRequest` rows, and
the whole system ships without touching the edge's security-sensitive code (except the independent
CSP `report-to` / `externalOrigins` loop).

**Baseline vs. elevated.** A pure classifier in `@azx-pbc/shared` (`classifyChange`,
`classifyVisibilityChange`) diffs the requested capabilities against effective state and splits the
change into a typed list of **deltas**, each tagged baseline or elevated:

- **Baseline deltas apply immediately**, in the same PUT transaction (`applyCapabilityChange` in
  `apps/portal/src/approvals/service.ts`): curated models, budgets ≤ threshold, the data scopes
  themselves (user/collections/shared keys), and **any privilege reduction**.
- **Elevated deltas** are bundled into one pending `ApprovalRequest` and gated on an admin
  decision; they do not reach the edge until approved. Routes return
  `{ applied: [...deltas], pending: <requestId|null> }`, so a single PUT can do both.

The thresholds are platform-wide policy co-located with the classifier so portal-gating and the
SPA's pre-submit warning never drift:

| Area | Baseline (applies now) | Elevated (needs approval) | Risk |
|---|---|---|---|
| LLM models | `CURATED_LLM_MODELS` (fable-5 / opus-4-8 / sonnet-4-6 / haiku-4-5) | any other model | med |
| LLM budget | `tokensPerDay ≤ BASELINE_TOKENS` (1,000,000) | above threshold | med |
| data scopes | user store, collections, shared keys | — | low |
| data budgets | writes/bytes ≤ thresholds | above threshold | med |
| mcp | `CURATED_MCP_ALLOWLIST` (**empty** ⇒ *every* MCP grant elevates) | any MCP server | high |
| externalOrigins | — | any origin added | med |
| fetch.origins | — | any proxied origin (secret-bound = high) | med / high |
| visibility | private / group / password | **→ public** | high |

Two invariants keep it safe without being annoying (`docs/design/approvals.md` §3):

- **Reducing privilege is always baseline** — removing a grant, shrinking a budget, public→private
  never needs approval; only increases gate. Subtle corollary: an **unset budget is unlimited**
  (the edge only enforces a defined cap), so *removing* a cap is a privilege increase and gates,
  while *adding* one is a reduction and commits.
- **Any elevated part makes the whole submission one atomic request** (the reviewer sees the full
  diff), with `risk` = the max across its deltas.

**Decide.** `apps/portal/src/routes/approvals.ts` serves the admin queue and the decision verbs
(`approve` / `deny` / `needs_changes` / `withdraw`). Approving applies the elevated deltas to the
`apps` row in one transaction → the normal `apps` UPDATE fires NOTIFY → the edge re-projects like
any other write. **Separation of duty:** the approver must differ from the requester, and admin is
membership in `PORTAL_ADMIN_GROUP_ID` carried as a **group claim in the verified bearer token**
(not an env OID list); a dev-only `PORTAL_ALLOW_SELF_APPROVE` flag (refused in prod) lets a solo
operator drive the loop. A sharp edge of the split model — baseline writes commit freely while a
request is open — is handled by a `baseSnapshot` taken at request time and an optimistic-concurrency
check at approve time that auto-bounces a stale request to `needs_changes` rather than clobbering.

## Where it shows up in the UI

The portal SPA has a **real** manifest editor (the Capabilities tab) wired to the live GET/PUT —
LLM models + token budget, the data flags/lists, external origins, fetch origins, and MCP grants —
and a **real Approvals queue** (`/api/v1/approvals`) with approve/deny/needs-changes/withdraw, plus
a "pending approval" banner on app detail. See [portal-web.md](./portal-web.md).

## Planned / not yet built

- **MCP** — `mcp` is carried in the manifest and the classifier already treats any MCP server as
  high-risk-elevated, but there is **no gateway transport yet**: approving an MCP grant writes the
  manifest; enforcement lands with the MCP-as-REST gateway (`docs/platform-custom-backends-and-apis.md`).
- **`bytesPerDay`** is declared and classified but not yet enforced at the edge (app-data design §7).
- **Per-delta partial approval** — v1 approves/denies the whole submission bundle; splitting a
  request is a deliberate future refinement (`docs/design/approvals.md` §9).
- **Approval notifications** — the queue is pull-based for v1; no push when a request is filed or
  decided.
