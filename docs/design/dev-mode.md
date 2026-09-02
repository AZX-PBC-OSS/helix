# AZX App Platform — Dev Mode (develop-against-the-platform) (design doc)

**Status:** Design draft **v2.1** · July 2026 (reconciled against the M4/M4.5 hardening now landed locally, then against **ADR-0028** — single-tenant, customer-deployed — accepted 2026-07-22. `ownsApp`/issue #9 landed in `dc2aacf`, closing the BOLA prerequisite; ADR-0028 then reframed domain-split/#16 into a per-deployment topology and answered the dev-gateway-hostname question it gated. **Both hard prerequisites are now cleared** — the isolation work (step 1) is unblocked start-to-finish.)
**Companion to:** `platform-architecture.md` (the _what & why_ — §2 names "apps built elsewhere with Lovable/Cursor/Claude Code" as a given, §3 the trust split, §6.1 the gateway) and `platform-project-plan.md` (§4 the gateway milestones, §6 the adversarial-test discipline).
**Builds on:** `app-data-storage.md` (the partition model + DB-role split this extends), `secrets-and-connections.md` (dev-tier secrets), `fetch-proxy.md`, and the hardening ADRs this revision leans on: **ADR-0002** (role split + RLS, now with NOBYPASSRLS and the `withPartition` choke point), **ADR-0007** (portal authz v0 — the BOLA this feature must *not* inherit), **ADR-0011** (shared-counter rate limiting), **ADR-0013** (egress trust model — the attested instruction now `jti`-burned + `aud`-pinned), **ADR-0019** (subdomain/domain-per-app isolation, which gated where the dev-gateway lives — now **reframed per-deployment by ADR-0028**), and **ADR-0028** (single-tenant, customer-deployed; it parameterizes the base domain per install and resolves the dev-gateway host to the control-plane base of *this* deployment).
**Why this exists:** The architecture assumes apps are authored *elsewhere* and only specs the **deploy** path (the deploy skill + upload API, §5.1). It never specs the **develop-against** path — how an app still under development, running on `localhost` or in a cloud IDE like Lovable / Claude Artifacts, reaches the platform capabilities (`/_api/llm`, `/_api/data`, `/_api/fetch`) it is being written to use. Without that path the platform is only usable by apps that are *first* built fully self-contained and *then* brought over — which is most apps' worst-case workflow and, for any app that is non-trivially coupled to our APIs, no workflow at all. This doc closes the gap by introducing a **dev tier: a separate data partition on the same app**, reachable from foreign origins through a dedicated dev surface, isolated from production data, budget, and secrets by the same role/RLS machinery the app-data design already established.

---

## 0. What changed since v1 (and why this is now buildable, not just sketchable)

v1 was written against the platform as it stood in June: the mechanisms this feature rides — the RLS partition, the egress instruction, rate limiting, role isolation — were real but soft in places. Since then the hardening pass landed most of the load-bearing primitives, which turns several of this doc's "sketches" into concrete wiring against named code. The deltas that matter here:

- **The RLS partition has one choke point now.** `apps/edge/src/db/partition.ts` `withPartition(pool, appId, userOid, fn)` is the *only* place the edge sets the partition GUCs, and a lint rule (ADR-0002, commit `82e9074`) bans raw RLS-table SQL outside it. So "add an `env` dimension to the partition" (§5) is now a precise change — **one signature gains `env`**, not a scattered `set_config` audit. All runtime roles are explicitly `NOBYPASSRLS` (`5127306`) and the edge/portal **boot-fail when their least-privilege role DSN is absent in prod** (`408a395`); `helix_dev` inherits both, which is what makes §5.3's "the role literally cannot cross env" claim enforceable rather than aspirational.
- **The attested instruction is `jti`-burned and `aud`-pinned** (ADR-0013 step 1, `e542bf2`/`357bfb7`). `mintInstruction` (`apps/edge/src/gateway/instruction.ts`) stamps `jti = requestId` + `aud: "azx-egress"`; egress asserts `aud` and burns the `jti` in a shared `instruction_jti` table before resolving any secret. The dev fetch path inherits this for free — but the instruction carries **no `env` today**, so §6 now specifies adding `env` to `AttestedInstruction` so egress env-scopes secret resolution (and pairs it with the step-2 `method`+`path` binding, issue #6).
- **Rate limiting / throttle is a shared Postgres counter now**, not in-memory (ADR-0011, `b939318`, `rate_counters` table). This matters because the dev-gateway is a *new replica surface*: its per-env budgets (§5.1) and any dev-side throttle ride the same shared counter by construction. The `EDGE_TRUST_PROXY` residual (issue #13) is wired but **not live-verified** — the deployments pass `edgeTrustProxy` (the trusted ingress **address**, defaulting to the ACA infrastructure subnet) to the dev-gateway as well as the edge, so its `${req.ip}:${appId}` throttle key resolves to the real client behind ingress *provided the ingress peer really sits in that subnet*, which no one has confirmed against a live deployment yet (ADR-0011's 2026-09 amendment).
- **`Caller` is a discriminated union** (`apps/edge/src/auth/gate.ts:43`), not the flat struct v1's §5.4 assumed. The `env` field is added to the authenticated arm (defaulting `'prod'`), and the resolver — not the handler — is where it's stamped.
- **The BOLA is now closed — the gate exists and must be *adopted*, not built.** `ownsApp` landed (commit `dc2aacf`, issue #9): an owner-or-admin preHandler in `apps/portal/src/plugins/auth.ts` (fail-closed on a null legacy `ownerId`), attached to every app-scoped mutating route across `apps.ts`/`versions.ts`/`secrets.ts`/`data.ts` plus the credential-returning `GET /:slug/access/password` and (since 2026-08-10) the collection read/export routes, with an adversarial sweep in `apps/portal/src/routes/ownership.test.ts`. This is the single most important reconciliation since v1: **the dev-token mint/rotate/revoke routes are exactly the app-scoped mutating writes the BOLA exposed**, and the gate that contains them now exists. So the step-2 co-requisite has shifted from "build `ownsApp` first" to "wire `ownsApp` onto the mint/rotate/revoke routes from their first commit" — a hard requirement still, but no longer a prerequisite that gates the work (§4.1, §7.2, §11). (Residual, narrowed 2026-08-10: reads that return only aggregates stay authenticated-only, but any read returning data the app itself cannot see — collection items, secret metadata, the password credential — now carries `ownsApp` too; see ADR-0007's amendment. Owner-scoped read *filtering* / per-app RBAC is still the v1 `PreviewBadge` feature.)

The rest of the doc is unchanged in intent; the edits below thread these five facts through the sections they touch.

---

## 1. The gap, stated precisely

The production gateway is bound to the served origin by **three deliberate, independent walls** (see `app-data-storage.md` §2 and the gate, `apps/edge/src/auth/gate.ts`):

1. **Cookie-only identity.** Handlers read only `__Host-session` (`gate.ts:175`); there is no bearer path. `__Host-` cookies are, by construction, unsendable cross-origin — a foreign page has no credential it *can* present.
2. **Exact-Origin / CSRF check.** Every mutation requires `origin === publicOrigin(slug)` and fails closed on a missing Origin (`apps/edge/src/auth/validate.ts`). `https://myapp.lovable.app` ≠ `https://myapp.azx.helix.azxlabs.io` → 403.
3. **No CORS anywhere on the edge.** Even a GET you somehow authenticated couldn't be read back.

These are not oversights to patch — they are the containment model. The LLM proxy is safe *because* it runs on the app's own origin under the visitor's session (architecture decision 1: the frontend is untrusted code in the attacker's browser). So "let `localhost`/Lovable reach prod's gateway" means knocking out the three walls that make production safe. **We will not do that.**

The reframe that resolves the tension:

> Don't bring the dev environment to production's gateway. Bring an **isolated copy of the capabilities** to the dev environment — a separate tier with its own principal, its own data partition, its own budget, and its own secrets — and leave the three production walls untouched.

The load-bearing claim of this doc is that "dev mode" is **not** a relaxation of the production APIs. It is a *second, isolated environment* that happens to share an app's slug and manifest. The blast radius of the entire dev surface is "a developer's own throwaway dev data and dev budget" — bounded by partition, not by policy, and revocable.

---

## 2. The decision: a dev *partition*, not a dev *app*

The fork: when an app is in development, is its dev environment **(a)** a separate partition on the *same* app row (one slug, one manifest, an `env` dimension on the data), or **(b)** a distinct shadow "dev app" with its own slug/registry row?

**This doc commits to (a), the separate partition.** Reasoning:

- **Fidelity.** The whole point of developing *against* the platform (rather than a mock) is to exercise the *real* policy: the same manifest, the same model allowlist, the same capability approvals, the same SSRF controls. A separate dev-app drifts — its manifest, its grants, its approval state diverge from the thing you will actually promote, and "works in dev, 403s in prod" becomes routine. One app row, one manifest, one approval state, two data partitions keeps dev and prod policy-identical by construction.
- **One slug, one mental model.** `myapp` is `myapp` whether you're iterating on it or it's live. The dev surface targets `myapp`'s dev partition; promotion is a version pointer flip, never a copy-from-dev-app-to-prod-app reconciliation.
- **It rides machinery we already have.** The app-data design (`app-data-storage.md` §2.1, §3) already partitions every data row and enforces the partition with a DB-role split + RLS. A dev tier is *one more dimension on that existing partition key* (`env`), policed by *one more role* (`helix_dev`) with the same "containment is the grant, not the query" discipline. We are widening a proven boundary by one axis, not inventing a parallel system.

The cost we accept: every data table, the metering ledger, the RLS predicate, and the gate's `Caller` gain an `env` dimension. §5 makes that concrete. The thing we explicitly avoid: **dev data must never silently become prod data** — there is no "promote my dev rows" path; promotion moves *code* (versions), never the dev partition (§7.3).

---

## 3. Where it lives: three surfaces, keyed on what the host origin can do

"Dev mode" is one *tier* (the dev partition) reached by different *surfaces* depending on where the in-development code runs. The surface differs; the partition, the manifest, and the policy do not.

| Surface | For | How it reaches the dev partition | New trust surface |
|---|---|---|---|
| **`helix dev` — local same-origin proxy** | `localhost` development | A local edge serves `/_api/*` on the app's *own* `localhost` origin, so the three walls are satisfied naturally (same-origin, its own cookie/no-CORS-needed). It authenticates the developer via their existing `helix login` token (`packages/cli`, the XDG token cache) and tags all calls `env=dev`. | **None on the platform.** The local proxy is the developer's own machine acting as themselves; it talks to the same dev-tier backends the dev-gateway does. |
| **dev-gateway — CORS surface + dev token** | Lovable and any real cross-origin web IDE | A dedicated platform endpoint (`dev-api.<control-base>` — `dev-api.azx.helix.azxlabs.io` on our reference deployment — never an app subdomain) that *does* speak CORS — but reflects only origins the owner registered for the app — authed by a scoped **dev token** (§4), routed to `env=dev`. | A bounded, opt-in one (§4, §9). Prod's `*.azx.helix.azxlabs.io` gateway is untouched. |
| **mock SDK** | Claude Artifacts, offline, first-draft UI | The client SDK (§8) runs a pure in-memory transport — no network to the platform at all. | None. |

Why three and not one: Claude Artifacts run in a sandboxed iframe whose CSP generally forbids arbitrary cross-origin `fetch`, so the dev-gateway often isn't even *reachable* from an artifact — the mock is the honest answer there, and that's fine (artifacts are a UI-prototyping surface, not where you build the fully-integrated app). Lovable is a normal cross-origin web app with a stable origin and free network — the dev-gateway fits it exactly. `localhost` is ours to shape, and the same-origin proxy is strictly safer than a CORS hole, so we take it.

The unifying invariant across all three: **the production origin is never called cross-origin from a dev environment.** `localhost` talks to a local same-origin proxy; Lovable talks to a *separate* dev host; Artifacts talk to nothing. We never widen `myapp.azx.helix.azxlabs.io`.

---

## 4. Identity and the dev token (the credential)

The dev tier has a **different principal** from production, and naming that is what makes "this isn't lowering security" true. In production the caller is an *end-user* whose session the untrusted frontend rides — hence cookie-only, Origin-locked, no-CORS. In dev the caller is the **developer themselves**, explicitly, holding a credential they own. A bearer token is the *correct* primitive here precisely because there is no end-user session to protect — you **are** the user.

### 4.1 What a dev token is

A dev token is minted by the **portal** (the control plane — the only place that may write app state) and is bound to:

- **`app`** — a single slug; the token is useless against any other app.
- **`developerOid`** — the principal the dev partition is keyed by; also the metering/audit identity.
- **`origins[]`** — the exact foreign origins the dev-gateway will reflect in CORS for this token (e.g. `https://myapp.lovable.app`, `http://localhost:5173`). Wildcards are disallowed; the owner registers concrete origins.
- **`env: "dev"`** — non-negotiable, baked in. A dev token can never name `env=prod`; the value is carried by the token, never by a request parameter.
- **TTL** — short by default (hours/days), renewable from the portal.
- **revocation** — a row the portal can flip; the dev-gateway checks it (the dev tier is small and revocation must be immediate, so this is a lookup, not a stateless-JWT-only check — see §5.3).

### 4.2 How each surface presents identity

- **`helix dev` (localhost):** the proxy runs *server-side on the developer's machine* and holds the developer's `helix login` token directly; it injects identity into same-origin `/_api/*` calls and sets `env=dev`. No browser-held token is needed — same-origin means the production-shaped cookie/Origin path is satisfied without a CORS hole.
- **dev-gateway (Lovable):** the app's config carries the dev token (pasted by the developer, or injected by the SDK from an env var). The browser sends it as `Authorization: Bearer <devToken>`; the dev-gateway validates token + Origin-in-allowlist before reflecting CORS and routing to `env=dev`.

### 4.3 Testing as multiple users (a dev-only affordance)

A real need in dev is exercising `user`-scoped behavior across several users — which production forbids (you may only ever be yourself). Because the dev partition is isolated, dev mode can safely offer **impersonation**: a dev-only `X-Helix-Dev-As: <synthetic-user-id>` header that re-keys the `user` partition within `env=dev`. It is honored *only* on the dev surfaces and *only* within `env=dev` — the RLS role (§5.3) cannot touch prod rows regardless of this header, so the worst case is "the developer reads their own synthetic dev users." This is impossible-and-forbidden in prod, trivial-and-safe in dev, purely because of the partition. (v1-optional; see §10.)

---

## 5. The partition made concrete

This extends `app-data-storage.md` §2.1/§5.2 by one dimension. Read that doc first; this section only states the deltas.

### 5.1 The `env` dimension on the data model

Every app-data table, the collection table, and the metering ledger gain an `env` column (`'prod' | 'dev'`), and it becomes part of the partition key:

```prisma
// delta to app-data-storage.md §5.2 — env added to the partition.
model AppData {
  id        String   @id @default(uuid()) @db.Uuid
  appId     String   @db.Uuid
  env       String   @default("prod")          // 'prod' | 'dev'  — partition dimension
  userOid   String?
  key       String
  value     Json
  updatedAt DateTime @default(now()) @updatedAt
  @@unique([appId, env, userOid, key])          // was [appId, userOid, key]
  @@map("app_data")
}

model AppCollectionItem {
  id         String   @id @default(uuid()) @db.Uuid
  appId      String   @db.Uuid
  env        String   @default("prod")          // 'prod' | 'dev'
  collection String
  userOid    String?
  item       Json
  meta       Json?
  createdAt  DateTime @default(now())
  @@index([appId, env, collection, createdAt])
  @@map("app_collection_items")
}
```

`gateway_calls` (the meter, `apps/edge/src/gateway/usage.ts`) gains the same `env` column, so **budgets and usage are naturally per-env**: a developer hammering the LLM in dev burns the dev budget window, never the live one, because the `SUM(...) WHERE env = ?` that enforces the cap is partitioned too. No new budget concept — the existing `dollarsPerDay` / `writesPerDay` / `requestsPerDay` knobs apply within each env independently, falling straight out of the ledger column.

The short-window **rate limiting / throttle** is a separate mechanism from the daily budget, and since v1 it moved to a shared Postgres counter (`rate_counters`, ADR-0011 / `b939318`) precisely so it holds across replicas. The dev-gateway is a *new* replica surface, so this is load-bearing: its throttle rides the same shared counter (never a per-process in-memory count), keyed like the edge's on `${req.ip}:${appId}`. The `EDGE_TRUST_PROXY` residual (issue #13) that this inherited is wired but not live-verified: the deployments pass `edgeTrustProxy` — the trusted ingress **address**, not a hop count, which fastify 5.12.1 removed (GHSA-3m5p-2c4r-xxw2) — to the dev-gateway container as well as the edge, so its per-client limits resolve the real client IP as long as the ingress peer falls inside that subnet, which is inferred rather than verified (ADR-0011's 2026-09 amendment). The dev-gateway's own **short-window throttle** is still the open piece — see the riders below.

### 5.2 The RLS predicate gains `env`

Concretely, the `env` GUC is set in exactly one place: `withPartition` (`apps/edge/src/db/partition.ts`), the single choke point that already sets `app.app_id` / `app.user_oid` and behind which the ADR-0002 lint rule bans raw RLS-table SQL. Its signature gains `env` — `withPartition(pool, appId, userOid, env, fn)` — and its `set_config` call adds `app.env`. Because it's the only door, every RLS-guarded table the runtime touches (`app_data`, `gateway_calls`, `app_collection_items`) is env-scoped by that one edit; a path that forgets it resolves `env` to NULL via `current_setting(..., true)` and matches zero rows / fails the `WITH CHECK` — fail-closed, exactly as the missing-`app_id` case does today.

The app-data partition policy (`app-data-storage.md` Appendix A.2) gets one more clause, set per request from the surface — never from app input:

```sql
-- delta: the partition predicate now includes env, sourced from a GUC the
-- surface sets (prod gateway => 'prod'; dev surfaces => 'dev'). Same SET LOCAL /
-- set_config(...) discipline as app.app_id / app.user_oid.
CREATE POLICY app_data_partition ON app_data
  USING (
    "appId" = current_setting('app.app_id', true)::uuid
    AND "env" = current_setting('app.env', true)
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  )
  WITH CHECK ( /* same */ );
```

### 5.3 The role split: `helix_dev`, isolated *by the policy literal*

This is the security centerpiece, and it mirrors the app-data doc's core move — **containment lives in the GRANT/role, so it survives a process compromise, not in a query a compromised process could rewrite.**

The production edge role and the dev role get **policies hardcoded to their env**, so the isolation does not depend on the GUC being set correctly:

```sql
-- helix_edge (production data plane) may see ONLY prod rows — env literal, not GUC.
CREATE POLICY app_data_edge_prod ON app_data TO helix_edge
  USING ("env" = 'prod' AND <partition predicate above, sans the env GUC>)
  WITH CHECK ("env" = 'prod' AND <...>);

-- helix_dev (the dev surfaces' DB role) may see ONLY dev rows — env literal.
CREATE POLICY app_data_dev_only ON app_data TO helix_dev
  USING ("env" = 'dev' AND <partition predicate>)
  WITH CHECK ("env" = 'dev' AND <...>);
```

The promise this buys, stated as the app-data doc states its own: **a compromised production edge cannot read or write a single dev row, and a compromised dev-gateway cannot read or write a single prod row — because each role's RLS policy hardcodes its env, independent of any GUC, header, or `WHERE`.** The `env` GUC in §5.2 is convenience/defense-in-depth; the role policies are the invariant.

`helix_dev`'s grant set otherwise mirrors `helix_edge` (the dev-gateway runs the same gateway verbs): `SELECT/INSERT/UPDATE/DELETE` on `app_data` (dev rows only, per policy), `INSERT`-only on `app_collection_items` (the no-collection-read property holds in dev too — `app-data-storage.md` §3.2), `SELECT/INSERT` on `gateway_calls` and `instruction_jti` (the dev fetch path burns its own instruction `jti`s — §6). Like `helix_edge`, it is `NOINHERIT`, owns nothing, and is **explicitly `NOBYPASSRLS`** (the hardening pass made this explicit on every runtime role, `5127306`) — so the env-literal policy cannot be sidestepped. And like the edge/portal roles, the dev-gateway **boot-fails in prod if its `helix_dev` DSN is absent** (`408a395`): it cannot silently fall back to a superuser connection that would ignore the policy. Its pools carry the same `statement_timeout` as the rest (`f50ffd2`).

### 5.4 The gate seam already supports this

`Caller` / `CallerResolver` (`apps/edge/src/auth/gate.ts:42-51`) is already the single seam the gateway keys identity off, and `makeCallerResolver` already swaps behavior by app (public short-circuit). The dev surfaces inject:

- a **`DevTokenResolver`** in place of `makeCallerResolver` — it validates the dev token (signature + revocation lookup + Origin-in-allowlist) and yields a `Caller` carrying `{ authenticated: true, oid: developerOid, env: 'dev', ... }`;
- a **CORS-allowlist Origin check** in place of `isSameOrigin` — reflecting only the token's registered origins (vs. production's exact-`publicOrigin` match).

`Caller` is a discriminated union today (`gate.ts:43`): `{ authenticated: true; oid; displayName; groups } | { authenticated: false }`. The `env: 'prod' | 'dev'` field is added to **both arms** (or, equivalently, alongside the union) and defaults `'prod'` everywhere `makeCallerResolver` constructs it, so the production path is byte-identical. Only the `DevTokenResolver` sets `env: 'dev'`. Handlers already thread `Caller` into the store calls; the one wiring change is that the resolver's `env` flows into the new `withPartition(..., env, ...)` argument (§5.2) — the handlers themselves don't learn a new concept.

---

## 6. Connections, secrets, and budgets in dev

- **Dev-tier secrets.** The "can't put prod credentials on a laptop / in Lovable" problem from the conversation is solved by the partition: connections resolve to **dev-tier secret values** the developer configures separately in the portal (`secrets-and-connections.md` write path, scoped to `env=dev`). A dev fetch-proxy call injects the *dev* credential; it can never resolve a prod connection secret. (Egress's `PgSecretResolver` gains the same `env` scoping; `helix_egress`'s grant is env-split exactly like `helix_dev`'s.)
  - **The attested instruction must carry `env`.** This is the concrete delta since v1. `AttestedInstruction` (`@azx-pbc/shared`, minted by `apps/edge/src/gateway/instruction.ts`) carries `appId / userOid / capability / origin / requestId / connection` — **no `env` today**. Add `env` to the claims so egress resolves the secret under the `env`-split `helix_egress` policy rather than trusting the edge to have picked the right connection row. The dev fetch path otherwise inherits the ADR-0013 step-1 hardening unchanged: the dev-minted instruction is `jti`-burned (in the shared `instruction_jti` table) and `aud: "azx-egress"`-pinned, so a captured dev instruction can't be replayed. Fold `env` in **together with** the step-2 `method`+`path` binding (issue #6) — both are the same one-field-per-claim change to the shared schema and both verify sides, so do them in one pass rather than twice.
- **Budgets are per-env** (§5.1) — dev experimentation never exhausts a live app's daily LLM dollars or fetch budget, and vice-versa.
- **Same manifest, same approvals.** Because dev and prod share the app row and manifest (§2), a capability the app isn't granted is 403 in dev too — which is the point: you find the missing grant while developing, not after promoting.

---

## 7. Lifecycle: create-before-code, registration, reset, no-promotion

### 7.1 "Create the app before there is code" is already mechanically possible

The registry already supports an app with **zero versions**: `currentVersionId` is nullable (`schema.prisma`), `POST /api/v1/apps` requires no version (`apps.ts`), and the manifest lives on the app row and is enforced regardless of deployed code (`mappers.ts` `toManifest`). So the lifecycle this feature needs already exists in substrate; what's missing is naming it and hanging dev credentials off it:

```
helix create myapp            → app row exists (no version), manifest editable, capabilities enforced
   ↳ portal mints a dev token + registers dev origins      ← the new hook
develop against env=dev      → via helix dev (localhost) or dev-gateway (Lovable)
helix deploy                   → first version lands as `preview` (architecture §5.1)
promote                      → version pointer flips to `live`; serves env=prod
```

A lightweight **`draft`** state (an app with no live version) is worth surfacing in the portal so this is a deliberate flow rather than an emergent one, but it requires no schema change beyond what `currentVersionId == null` already encodes.

### 7.2 Registering dev origins

The owner registers the foreign origins their dev token may be used from (the Lovable preview URL, their `localhost` port) in the portal — the same screen that mints/rotates the dev token. This is owner-driven control-plane state and gains an `app_dev_token` / `app_dev_origin` table (Appendix A.3).

**This is where the BOLA would have bitten — and where the now-landed gate must be adopted.** v1 said this "rides the existing portal auth (app ownership)"; when v2 was drafted that ownership check did *not* exist (ADR-0007's v0 posture was authenticated == authorized). It exists now: `ownsApp` landed (commit `dc2aacf`, issue #9) as an owner-or-admin preHandler on every app-scoped mutating route. A dev-token mint route is precisely one of those routes, and it mints a *credential* — so without the gate, any authenticated user could mint a working dev token (and register CORS origins) against **anyone's** app, a self-service path into another owner's dev partition and dev secrets. Therefore: **the dev-token mint/rotate/revoke routes must carry the existing `ownsApp` preHandler from their first commit** — the same gate `secrets.ts` already uses, applied identically. This is no longer "build the ownership check first"; it is "don't forget to attach it." The adversarial twin is still mandatory: "operator B cannot mint/rotate/revoke a dev token for operator A's app," mirroring the existing sweep in `apps/portal/src/routes/ownership.test.ts`.

### 7.3 Dev data is throwaway, and never promoted

Two hard rules:

- **Reset.** The portal offers "clear dev data" — a `DELETE ... WHERE appId = ? AND env = 'dev'` on the privileged role. Cheap, because the partition is clean. **Not built yet** (2026-08-10): the collection drain now *shows* dev rows, so this is the obvious next click and the gap is visible where it wasn't before.
- **Visible, not merged.** The owner-facing drain (`GET /apps/:slug/collections/:name`) reads cross-env — the portal policy is deliberately not env-scoped, unlike the runtime roles — and every row carries `env`. The Data tab narrows to `prod` by **default** so a developer's own test submissions never read as real leads, and tells the owner how many rows the filter is holding back rather than hiding their existence. A tier is a presentation filter here, never a wall: dev rows are still the owner's data and still their erasure obligation.
- **No promotion path.** There is deliberately **no** "copy my dev rows to prod" operation. Promotion moves *code* (the version pointer, architecture §5.1), never data. Conflating them would let a developer seed production state through an unaudited path and would couple two lifecycles that must stay independent. If an app needs seed data in prod, that is an explicit owner-driven import on the prod partition, not a dev-data lift.

---

## 8. The SDK / transport seam (app code identical across dev and prod)

The fetch shim (`apps/edge/src/serving/shim.ts`) already establishes the pattern that makes all of this ergonomic: app code calls capabilities *normally* and the platform intercepts. Dev mode generalizes it into a small **client SDK** (`@azx-pbc/app-sdk`, new) that all platform capabilities are reached through (`helix.llm.chat()`, `helix.data.get()`, …), with a **swappable transport**:

| Environment | Transport | Base | Auth |
|---|---|---|---|
| production (served by edge) | same-origin `/_api/*` | the app's own origin | session cookie (ambient) |
| `localhost` (`helix dev`) | same-origin `/_api/*` | local proxy | developer's `helix login` token (proxy-side) |
| Lovable | dev-gateway | `dev-api.azx.helix.azxlabs.io` | dev token (Bearer) |
| Artifacts / offline | in-memory mock | none | none |

The transport is selected from injected config (base URL + optional dev token), so **the app's source is identical** across all four — which is exactly what "develop in Lovable, then upload, and it just works on the platform" requires. The SDK is also the natural home for the mock (§3) and for the impersonation header (§4.3). Whether the SDK is mandatory or apps may still hand-roll `/_api/*` calls is an open question (§10) — but the SDK is what makes the dev story turnkey.

---

## 9. Threat mapping

| Attack | Defense |
|---|---|
| Foreign origin (Lovable/localhost) tries to call **production** `myapp.azx.helix.azxlabs.io/_api/*` | Unchanged prod walls: cookie-only (no bearer path), exact-Origin, no CORS (§1). Cross-origin → 401/403 exactly as today. |
| A leaked **dev token** is used by an attacker | Bounded blast radius: it reaches only `env=dev` of one app, as the developer, with the dev budget. Revocable from the portal (§4.1); Origin-pinned so it only works from registered origins. No prod data, ever (§5.3). |
| The **dev-gateway process is compromised** and tries to read prod data | `helix_dev`'s RLS policy hardcodes `env = 'dev'` (§5.3); the role literally cannot select a prod row, independent of any GUC/header/`WHERE`. Symmetric to `helix_edge` being pinned to `'prod'`. |
| Dev token / dev surface tries to set `env = 'prod'` to reach live data | `env` is carried by the token/surface, never an app parameter; and even if forged into the GUC, the `helix_dev` policy's literal `env = 'dev'` wins. |
| dev-gateway CORS used as an open relay from an arbitrary site | CORS reflects only the token's registered `origins[]` (§4.1); no wildcard. An unregistered Origin gets no `Access-Control-Allow-Origin`. |
| Developer uses **impersonation** (`X-Helix-Dev-As`) to reach another real user | Header honored only on dev surfaces, only within `env=dev`; `helix_dev` can't touch prod rows, so the synthetic user is always a dev-partition row (§4.3). |
| Dev secret used to reach a prod connection (or vice-versa) | Secrets are `env`-scoped; `helix_egress`'s grant/policy is env-split like `helix_dev` (§6). A dev fetch injects only dev credentials. |
| Dev data silently leaks into production | No promotion-of-data path exists by construction (§7.3); promotion moves code only. |
| A logged-in user mints a dev token / registers CORS origins against **someone else's** app | The mint/rotate/revoke routes carry the now-landed `ownsApp` preHandler (issue #9, commit `dc2aacf`) — the same owner-or-admin gate `secrets.ts` uses — from their first commit (§7.2). Without it, this is a self-service path into another owner's dev partition; adversarial twin required. |
| Captured **dev** attested instruction replayed against egress | Inherits ADR-0013 step-1: `jti` burned in `instruction_jti`, `aud: "azx-egress"` asserted, short TTL. Dev mints ride the same choke point (§6). |

Residual risk (consistent with architecture §residual-risk and `app-data-storage.md` §8): a dev token is a real credential and a careless developer can leak their *own* dev tier. Governance bounds that to one app's throwaway partition and one developer's budget, and makes it revocable; it does not make a leaked dev token a non-event, only a small and recoverable one.

---

## 10. What's deferred / open questions

- **Is the SDK mandatory?** If apps may still call `/_api/*` by hand, the dev-gateway must accept the same raw calls (it does — same verbs); the SDK is then ergonomics, not a gate. Leaning: SDK optional but strongly recommended, mock + impersonation are SDK-only conveniences.
- **Dev token shape:** ~~open~~ **leaning resolved toward opaque + looked-up.** The `app_dev_token` table (Appendix A.3) already stores a hash; revocation immediacy (§4.1) and origin-binding both want a per-request lookup, and we now have a *precedent* for lookup-on-the-hot-path being acceptable at this scale — the egress `jti` burn (ADR-0013 step 1) is exactly a per-call DB check on a shared table. So the opaque-token design is no longer a trade-off against a "stateless is cheaper" default; take it. (A short-TTL JWT + small revocation set stays available if the dev tier ever outgrows a table lookup, but there's no reason to start there.)
- **Impersonation (§4.3):** ship in v1 or fast-follow? It is the highest-value dev affordance for `user`-scoped apps but adds a header path to test carefully. Leaning: fast-follow (step 5) — it's SDK-only and rides the partition, so it doesn't gate the isolation work.
- **dev-gateway placement:** ~~open~~ ~~now coupled to ADR-0019 / issue #16~~ **resolved by ADR-0028.** The deployment model is now single-tenant, customer-deployed (ADR-0028), so #16's domain split is a *per-deployment topology*, not a domain we own: within each install, untrusted apps sit on a separate site from that install's control plane. The dev-gateway is neither an app subdomain nor the app domain — it's a control-plane-adjacent surface — so it belongs on **the control-plane base of *this* deployment** (`dev-api.<control-base>`; `dev-api.azx.helix.azxlabs.io` on our reference deployment), never the apps zone. ADR-0028's Consequences section states this outright ("control-plane base of *this* deployment, never the apps zone"), so the hostname no longer waits on the domain split. A dedicated host still wins (clean CORS config + `helix_dev` isolation). Also make it a **per-plane opt-in flag** in the mold of `EDGE_ALLOW_PUBLIC_APPS` / `EDGE_ALLOW_PASSWORD_APPS` (`663bf1f`) so the dev surface can be disabled per environment.
- **`helix dev` proxy fidelity:** how much of the real edge it runs in-process (ideally the actual `buildApp()` with a `DevTokenResolver` + CORS-allowlist injected, so dev ≡ prod code) vs. a thinner shim. Favored: reuse `buildApp()` — the seams (§5.4) exist precisely so this is a wiring change, not a fork.
- **Artifacts beyond mock:** if Anthropic's artifact sandbox ever permits a narrow allowlisted `connect-src`, the dev-gateway becomes reachable from artifacts too; until then, mock is the ceiling there.
- **Multiple developers per app:** dev partition is keyed by `developerOid`; do co-developers share one dev partition or get their own sub-partition? Today each developer's `user`-scope is naturally separate; `shared`/`collections` in dev would be common across the team. Probably fine; revisit with per-app RBAC (the existing v1 `PreviewBadge` item).

## 11. Milestone fit

This is **M5+ territory** — it depends on the `/_api/*` gateway (M4) and the secrets/egress plane (M4.5) being in place, which they are locally, and it pairs naturally with the M5 deploy work — now a **customer-applied IaC artifact** rather than a service we run (ADR-0028) — since the dev-gateway is a new deployable surface *within each instance*. It also relates to the deferred **PR preview environments** in `git-connections.md` (§"deferred") — that feature is the *git-driven* cousin of this *manual/IDE-driven* dev tier, and both want the same `env` partition; this doc should land first and the preview-env work reuse its partition + role split.

**Hard prerequisites:**

- **`ownsApp` / issue #9 — ✅ landed (commit `dc2aacf`).** No longer a prerequisite: the owner-or-admin gate now exists on every app-scoped mutating route. What remains is an *adoption* requirement, not a blocker — the dev-token mint/rotate/revoke routes must carry the existing `ownsApp` preHandler from their first commit (§7.2), with the cross-owner-mint adversarial twin in lockstep. Step 2 is unblocked.
- **Domain split / ADR-0019 (issue #16) — ✅ reframed & resolved for dev mode by ADR-0028.** ADR-0028 (single-tenant, customer-deployed; accepted 2026-07-22) turns #16 into a *per-deployment topology* and answers the one thing it gated here — the dev-gateway hostname — directly: the control-plane base of *this* deployment (`dev-api.<control-base>`), never the apps zone. Step 3 no longer waits on a domain decision. (The physical apps↔control-plane site split remains a per-deployment recommendation the customer applies, per ADR-0019's 2026-07-22 amendment, but it does not gate any dev-mode step.)

Suggested order, each shipping adversarial tests in lockstep (project plan §6), with the concrete anchor each step touches:

1. **Schema + role split. — ✅ landed.** The `env` dimension on `app_data` / `app_collection_items` / `gateway_calls` (migration `20260722192440_dev_env_partition`); `env` added to `app_secrets` with the egress resolver env-scoping connection-secret resolution and `AttestedInstruction` carrying `env` (the §6 egress half, folded in); the `helix_dev` role — `NOINHERIT`, `NOBYPASSRLS` (`.devcontainer/db-init/01-roles.sql`) — with the env-**literal** RLS policies (`app_data_edge_prod` / `app_data_dev_only` and the `gateway_calls` / `app_collection_items` pins); `env` threaded end-to-end through `withPartition` (`apps/edge/src/db/partition.ts`), the `Caller` union (`gate.ts`), the app-data/usage stores, and every gateway handler (production stamps `'prod'`; only a dev surface will set `'dev'`). **Load-bearing assertions (all passing):** "`helix_dev` cannot SELECT a prod row", "`helix_edge` cannot SELECT a dev row", a forged-`app.env` GUC is inert (the role literal wins), per-role write containment, and dev-vs-prod connection-secret isolation — in `role-split.integration.test.ts` + `secrets.integration.test.ts`. _(Deferred to its own step: the `helix_dev` connection/pool/boot-fail DSN config, which arrives with the dev-gateway process in step 3 — step 1 exercises the role directly from tests.)_
2. **Dev token + origins. — ✅ landed.** Portal mint/rotate/revoke routes (opaque `azxdev_…` token, SHA-256-hashed in `app_dev_token`, plaintext shown once — §10), the `origins String[]` on the token row (no separate `app_dev_origin` table — A.3), and the dev-mode registration UI (`apps/portal-web` Dev-mode tab). The hash primitive is a shared node-only subpath (`@azx-pbc/shared/devToken`) so the step-3 dev-gateway recomputes it identically; a guarded `GRANT SELECT ON app_dev_token TO helix_dev` ships now so step 3 is resolver-only. **`ownsApp`** gates mint/rotate/revoke (list is authenticated-only, matching the secrets read posture); the cross-owner adversarial twin is in `ownership.test.ts`.
3. **dev-gateway surface (core). — ✅ landed.** A SEPARATE process running as `helix_dev` only (never the `helix_edge` pool — the isolation thesis), `buildDevGateway()` (`apps/edge/src/devGateway/`) reusing the edge's `/_api/*` handler factories with two swapped seams: the `DevTokenResolver` (bearer → hash → app-binding → revocation/expiry → Origin-in-allowlist, yielding `env='dev'`) in place of `makeCallerResolver`, and the `checkOrigin` seam (`() => true`, the resolver already matched the origin) in place of `isSameOrigin`. Slug rides the path (`/:slug/_api/*`, host is fixed). Hand-rolled CORS (no new dep): a preflight route (reflect a registered origin, allow the `Authorization` header) + an `onSend` reflection, with the LLM SSE `writeHead` reflecting it on the hijacked path. Config: `EDGE_DEV_DATABASE_URL` (helix_dev DSN, prod boot-fail), `EDGE_ALLOW_DEV_MODE` (per-plane opt-in, default off — §10), `EDGE_DEV_GATEWAY_PORT` (8082); `helix_dev` gains a **column-scoped** SELECT on `apps` (non-secret columns only — never the `password*` credential columns) plus SELECT on `versions`, with a no-password registry projection variant (`dev_registry_grant_columns`) — a compromised dev-gateway can't read a prod `password`-app credential. Adversarial suite (`devGateway.test.ts`): unknown/revoked/expired → 401, cross-app token → 403, unregistered Origin → 403 with no ACAO, env=dev routing (the write threads `env='dev'` to the store), CORS preflight reflect/reject, and env is not client-influenceable. **Deferred riders — ✅ both landed** (follow-up commits): (a) the `AttestedInstruction` `method`+`path` binding (issue #6 / ADR-0013 step 2) — the edge stamps method + pathname, egress refuses a mismatch (assert-when-present for rollout safety); (b) the **dev-secret write path** — `env` on `SecretMetadata`/`SecretCreateRequest`, portal app-scoped secret CRUD parametrized (create takes the tier, list returns both, rotate/delete take `?env`), with an `env` selector + badge in the portal Secrets tab, so a dev fetch can inject a dev connection secret. (Admin `global`/`platform` secrets stay prod-only — a dev fetch bound to a *global* connection is a documented gap, not built.) Per-env dev **budgets** fall out of step 1's env-partitioned `gateway_calls` for free. **Acceptance (from step 1, still open):** the `platform` (LLM vendor) key is env-agnostic (§6), so a *separate* dev LLM budget should bound real spend before the surface is enabled in a real deployment.
4. **`helix dev` local proxy.** Reuse `buildApp()` with the dev seams injected (the §5.4 seams exist precisely so this is wiring, not a fork); developer identity from the `helix login` token (§3, §4.2).
5. **SDK + mock + impersonation** (§8, §4.3) — the ergonomic layer that makes Lovable/Artifacts turnkey.

The load-bearing security assertions across the whole feature are the two isolation tests in step 1: dev mode is only "not a relaxation of the production APIs" if the database itself refuses to cross the env boundary. The second-most-important is the step-2 cross-owner-mint test — because a dev token is a credential; the `ownsApp` gate that contains it now exists platform-wide (commit `dc2aacf`), and this test proves the dev-token routes actually adopted it.

---

## Appendix A — Concrete sketches

Sketches, not committed code — they make §5/§7 concrete and show where each piece lands. They are deltas to `app-data-storage.md` Appendix A.

### A.1 Roles — dev-container bootstrap delta

Beside `helix_portal` / `helix_edge` (`app-data-storage.md` A.1), add the dev data-plane role:

```sql
-- .devcontainer/db-init/01-roles.sql  (append)
-- The dev surfaces (dev-gateway, helix dev) run as this role. Least privilege,
-- NOINHERIT, owns nothing, no BYPASSRLS — and, crucially, RLS-pinned to env=dev
-- (A.2) so it cannot read a single production row.
CREATE ROLE helix_dev LOGIN PASSWORD 'helix_dev' NOINHERIT;
GRANT CONNECT ON DATABASE helix TO helix_dev;
GRANT USAGE   ON SCHEMA public  TO helix_dev;
-- No blanket table grant: every table is owner-only until a migration grants it.
```

### A.2 Grants + env-literal RLS — in the env migration

```sql
-- migrations/<ts>_dev_env_partition/migration.sql (appended after Prisma adds the env columns)

-- Dev data-plane grants mirror helix_edge (same verbs), confined by policy below.
GRANT SELECT, INSERT, UPDATE, DELETE ON app_data             TO helix_dev;
GRANT INSERT                         ON app_collection_items  TO helix_dev;  -- no read, as in prod
GRANT SELECT, INSERT                 ON gateway_calls         TO helix_dev;
GRANT SELECT, INSERT                 ON instruction_jti       TO helix_dev;  -- dev fetch burns its own jti (§6)
-- helix_dev is NOINHERIT + NOBYPASSRLS (declared with the role in A.1); the
-- env-literal policies below are therefore un-bypassable by the running process.

-- Env-literal policies: the isolation invariant (§5.3). Independent of any GUC.
DROP POLICY IF EXISTS app_data_partition ON app_data;  -- replaced by per-role policies

CREATE POLICY app_data_edge_prod ON app_data TO helix_edge
  USING (
    "env" = 'prod'
    AND "appId" = current_setting('app.app_id', true)::uuid
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  )
  WITH CHECK (
    "env" = 'prod'
    AND "appId" = current_setting('app.app_id', true)::uuid
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  );

CREATE POLICY app_data_dev_only ON app_data TO helix_dev
  USING (
    "env" = 'dev'
    AND "appId" = current_setting('app.app_id', true)::uuid
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  )
  WITH CHECK ( /* same, env = 'dev' */ );
-- helix_portal keeps full DML for migrations / owner-facing reset + drain (both envs).
```

`app_collection_items` keeps **no** read policy for either runtime role — the `INSERT`-only grant is the write-only property, in dev as in prod.

### A.3 Dev-token + origins (portal-owned)

```prisma
/// A scoped credential for developing an app against its env=dev partition.
/// Minted/rotated/revoked from the portal; verified by the dev-gateway.
model AppDevToken {
  id            String    @id @default(uuid()) @db.Uuid
  appId         String    @db.Uuid
  developerOid  String                       // the principal env=dev is keyed by
  tokenHash     String    @unique            // opaque token, stored hashed (revocable lookup)
  origins       String[]                     // exact CORS origins this token may be used from
  expiresAt     DateTime
  revokedAt     DateTime?
  createdAt     DateTime  @default(now())
  @@index([appId])
  @@map("app_dev_token")
}
```

The dev-gateway's `DevTokenResolver`: hash the presented bearer → look up a non-revoked, non-expired row for the request's app → check `req.headers.origin ∈ row.origins` → yield `Caller { authenticated: true, oid: row.developerOid, env: 'dev' }` and reflect the Origin in CORS. Any failure → 401/403, no `Access-Control-Allow-Origin` emitted.

### A.4 The dev surface's request shape

Identical to `app-data-storage.md` A.3, with one added GUC — but in the current code the raw `set_config` lives inside `withPartition` (`apps/edge/src/db/partition.ts`) and the ADR-0002 lint rule forbids RLS-table SQL anywhere else. So the delta is to that helper's signature, and every call site inherits it:

```ts
// apps/edge/src/db/partition.ts — env joins app_id / app_user_oid as a GUC.
// Same set_config (parameterized, transaction-local) discipline; value is
// server-derived from the Caller, never app input. The helix_dev role's policy
// pins env='dev' anyway (the GUC is convenience / defense-in-depth, §5.3).
export async function withPartition<T>(
  pool: Pool, appId: string, userOid: string | null,
  env: "prod" | "dev",                     // NEW — defaults 'prod' at every prod call site
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  // ...BEGIN...
  await client.query(
    "SELECT set_config('app.app_id', $1, true), set_config('app.env', $2, true)",
    [appId, env],
  );
  if (userOid !== null) {
    await client.query("SELECT set_config('app.user_oid', $1, true)", [userOid]);
  }
  // ...fn(client); COMMIT...
}
```
