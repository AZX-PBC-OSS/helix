# AZX App Platform — Dev Mode (develop-against-the-platform) (design doc)

**Status:** Design draft v1 · June 2026
**Companion to:** `platform-architecture.md` (the _what & why_ — §2 names "apps built elsewhere with Lovable/Cursor/Claude Code" as a given, §3 the trust split, §6.1 the gateway) and `platform-project-plan.md` (§4 the gateway milestones, §6 the adversarial-test discipline).
**Builds on:** `app-data-storage.md` (the partition model + DB-role split this extends), `secrets-and-connections.md` (dev-tier secrets), `fetch-proxy.md`.
**Why this exists:** The architecture assumes apps are authored *elsewhere* and only specs the **deploy** path (the deploy skill + upload API, §5.1). It never specs the **develop-against** path — how an app still under development, running on `localhost` or in a cloud IDE like Lovable / Claude Artifacts, reaches the platform capabilities (`/_api/llm`, `/_api/data`, `/_api/fetch`) it is being written to use. Without that path the platform is only usable by apps that are *first* built fully self-contained and *then* brought over — which is most apps' worst-case workflow and, for any app that is non-trivially coupled to our APIs, no workflow at all. This doc closes the gap by introducing a **dev tier: a separate data partition on the same app**, reachable from foreign origins through a dedicated dev surface, isolated from production data, budget, and secrets by the same role/RLS machinery the app-data design already established.

---

## 1. The gap, stated precisely

The production gateway is bound to the served origin by **three deliberate, independent walls** (see `app-data-storage.md` §2 and the gate, `apps/edge/src/auth/gate.ts`):

1. **Cookie-only identity.** Handlers read only `__Host-session` (`gate.ts:175`); there is no bearer path. `__Host-` cookies are, by construction, unsendable cross-origin — a foreign page has no credential it *can* present.
2. **Exact-Origin / CSRF check.** Every mutation requires `origin === publicOrigin(slug)` and fails closed on a missing Origin (`apps/edge/src/auth/validate.ts`). `https://myapp.lovable.app` ≠ `https://myapp.azx-labs.com` → 403.
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
| **`azx dev` — local same-origin proxy** | `localhost` development | A local edge serves `/_api/*` on the app's *own* `localhost` origin, so the three walls are satisfied naturally (same-origin, its own cookie/no-CORS-needed). It authenticates the developer via their existing `azx login` token (`packages/cli`, the XDG token cache) and tags all calls `env=dev`. | **None on the platform.** The local proxy is the developer's own machine acting as themselves; it talks to the same dev-tier backends the dev-gateway does. |
| **dev-gateway — CORS surface + dev token** | Lovable and any real cross-origin web IDE | A dedicated platform endpoint (`dev-api.azx-labs.com`, never an app subdomain) that *does* speak CORS — but reflects only origins the owner registered for the app — authed by a scoped **dev token** (§4), routed to `env=dev`. | A bounded, opt-in one (§4, §9). Prod's `*.azx-labs.com` gateway is untouched. |
| **mock SDK** | Claude Artifacts, offline, first-draft UI | The client SDK (§8) runs a pure in-memory transport — no network to the platform at all. | None. |

Why three and not one: Claude Artifacts run in a sandboxed iframe whose CSP generally forbids arbitrary cross-origin `fetch`, so the dev-gateway often isn't even *reachable* from an artifact — the mock is the honest answer there, and that's fine (artifacts are a UI-prototyping surface, not where you build the fully-integrated app). Lovable is a normal cross-origin web app with a stable origin and free network — the dev-gateway fits it exactly. `localhost` is ours to shape, and the same-origin proxy is strictly safer than a CORS hole, so we take it.

The unifying invariant across all three: **the production origin is never called cross-origin from a dev environment.** `localhost` talks to a local same-origin proxy; Lovable talks to a *separate* dev host; Artifacts talk to nothing. We never widen `myapp.azx-labs.com`.

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

- **`azx dev` (localhost):** the proxy runs *server-side on the developer's machine* and holds the developer's `azx login` token directly; it injects identity into same-origin `/_api/*` calls and sets `env=dev`. No browser-held token is needed — same-origin means the production-shaped cookie/Origin path is satisfied without a CORS hole.
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

### 5.2 The RLS predicate gains `env`

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

`helix_dev`'s grant set otherwise mirrors `helix_edge` (the dev-gateway runs the same gateway verbs): `SELECT/INSERT/UPDATE/DELETE` on `app_data` (dev rows only, per policy), `INSERT`-only on `app_collection_items` (the no-collection-read property holds in dev too — `app-data-storage.md` §3.2), `SELECT/INSERT` on `gateway_calls`. Like `helix_edge`, it is `NOINHERIT`, owns nothing, and has no `BYPASSRLS`.

### 5.4 The gate seam already supports this

`Caller` / `CallerResolver` (`apps/edge/src/auth/gate.ts:42-51`) is already the single seam the gateway keys identity off, and `makeCallerResolver` already swaps behavior by app (public short-circuit). The dev surfaces inject:

- a **`DevTokenResolver`** in place of `makeCallerResolver` — it validates the dev token (signature + revocation lookup + Origin-in-allowlist) and yields a `Caller` carrying `{ authenticated: true, oid: developerOid, env: 'dev', ... }`;
- a **CORS-allowlist Origin check** in place of `isSameOrigin` — reflecting only the token's registered origins (vs. production's exact-`publicOrigin` match).

`Caller` grows an `env: 'prod' | 'dev'` field (defaulting `'prod'` everywhere it's constructed today, so the production path is unchanged). Every handler already threads `Caller` into the data store calls; it now also passes `caller.env` into the `set_config('app.env', ...)`.

---

## 6. Connections, secrets, and budgets in dev

- **Dev-tier secrets.** The "can't put prod credentials on a laptop / in Lovable" problem from the conversation is solved by the partition: connections resolve to **dev-tier secret values** the developer configures separately in the portal (`secrets-and-connections.md` write path, scoped to `env=dev`). A dev fetch-proxy call injects the *dev* credential; it can never resolve a prod connection secret. (Egress's `PgSecretResolver` gains the same `env` scoping; `helix_egress`'s grant is env-split exactly like `helix_dev`'s.)
- **Budgets are per-env** (§5.1) — dev experimentation never exhausts a live app's daily LLM dollars or fetch budget, and vice-versa.
- **Same manifest, same approvals.** Because dev and prod share the app row and manifest (§2), a capability the app isn't granted is 403 in dev too — which is the point: you find the missing grant while developing, not after promoting.

---

## 7. Lifecycle: create-before-code, registration, reset, no-promotion

### 7.1 "Create the app before there is code" is already mechanically possible

The registry already supports an app with **zero versions**: `currentVersionId` is nullable (`schema.prisma`), `POST /api/v1/apps` requires no version (`apps.ts`), and the manifest lives on the app row and is enforced regardless of deployed code (`mappers.ts` `toManifest`). So the lifecycle this feature needs already exists in substrate; what's missing is naming it and hanging dev credentials off it:

```
azx create myapp            → app row exists (no version), manifest editable, capabilities enforced
   ↳ portal mints a dev token + registers dev origins      ← the new hook
develop against env=dev      → via azx dev (localhost) or dev-gateway (Lovable)
azx deploy                   → first version lands as `preview` (architecture §5.1)
promote                      → version pointer flips to `live`; serves env=prod
```

A lightweight **`draft`** state (an app with no live version) is worth surfacing in the portal so this is a deliberate flow rather than an emergent one, but it requires no schema change beyond what `currentVersionId == null` already encodes.

### 7.2 Registering dev origins

The owner registers the foreign origins their dev token may be used from (the Lovable preview URL, their `localhost` port) in the portal — the same screen that mints/rotates the dev token. This is owner-driven control-plane state; it rides the existing portal auth (app ownership) and gains an `app_dev_token` / `app_dev_origin` table (Appendix A.3).

### 7.3 Dev data is throwaway, and never promoted

Two hard rules:

- **Reset.** The portal offers "clear dev data" — a `DELETE ... WHERE appId = ? AND env = 'dev'` on the privileged role. Cheap, because the partition is clean.
- **No promotion path.** There is deliberately **no** "copy my dev rows to prod" operation. Promotion moves *code* (the version pointer, architecture §5.1), never data. Conflating them would let a developer seed production state through an unaudited path and would couple two lifecycles that must stay independent. If an app needs seed data in prod, that is an explicit owner-driven import on the prod partition, not a dev-data lift.

---

## 8. The SDK / transport seam (app code identical across dev and prod)

The fetch shim (`apps/edge/src/serving/shim.ts`) already establishes the pattern that makes all of this ergonomic: app code calls capabilities *normally* and the platform intercepts. Dev mode generalizes it into a small **client SDK** (`@azx-pbc/app-sdk`, new) that all platform capabilities are reached through (`helix.llm.chat()`, `helix.data.get()`, …), with a **swappable transport**:

| Environment | Transport | Base | Auth |
|---|---|---|---|
| production (served by edge) | same-origin `/_api/*` | the app's own origin | session cookie (ambient) |
| `localhost` (`azx dev`) | same-origin `/_api/*` | local proxy | developer's `azx login` token (proxy-side) |
| Lovable | dev-gateway | `dev-api.azx-labs.com` | dev token (Bearer) |
| Artifacts / offline | in-memory mock | none | none |

The transport is selected from injected config (base URL + optional dev token), so **the app's source is identical** across all four — which is exactly what "develop in Lovable, then upload, and it just works on the platform" requires. The SDK is also the natural home for the mock (§3) and for the impersonation header (§4.3). Whether the SDK is mandatory or apps may still hand-roll `/_api/*` calls is an open question (§10) — but the SDK is what makes the dev story turnkey.

---

## 9. Threat mapping

| Attack | Defense |
|---|---|
| Foreign origin (Lovable/localhost) tries to call **production** `myapp.azx-labs.com/_api/*` | Unchanged prod walls: cookie-only (no bearer path), exact-Origin, no CORS (§1). Cross-origin → 401/403 exactly as today. |
| A leaked **dev token** is used by an attacker | Bounded blast radius: it reaches only `env=dev` of one app, as the developer, with the dev budget. Revocable from the portal (§4.1); Origin-pinned so it only works from registered origins. No prod data, ever (§5.3). |
| The **dev-gateway process is compromised** and tries to read prod data | `helix_dev`'s RLS policy hardcodes `env = 'dev'` (§5.3); the role literally cannot select a prod row, independent of any GUC/header/`WHERE`. Symmetric to `helix_edge` being pinned to `'prod'`. |
| Dev token / dev surface tries to set `env = 'prod'` to reach live data | `env` is carried by the token/surface, never an app parameter; and even if forged into the GUC, the `helix_dev` policy's literal `env = 'dev'` wins. |
| dev-gateway CORS used as an open relay from an arbitrary site | CORS reflects only the token's registered `origins[]` (§4.1); no wildcard. An unregistered Origin gets no `Access-Control-Allow-Origin`. |
| Developer uses **impersonation** (`X-Helix-Dev-As`) to reach another real user | Header honored only on dev surfaces, only within `env=dev`; `helix_dev` can't touch prod rows, so the synthetic user is always a dev-partition row (§4.3). |
| Dev secret used to reach a prod connection (or vice-versa) | Secrets are `env`-scoped; `helix_egress`'s grant/policy is env-split like `helix_dev` (§6). A dev fetch injects only dev credentials. |
| Dev data silently leaks into production | No promotion-of-data path exists by construction (§7.3); promotion moves code only. |

Residual risk (consistent with architecture §residual-risk and `app-data-storage.md` §8): a dev token is a real credential and a careless developer can leak their *own* dev tier. Governance bounds that to one app's throwaway partition and one developer's budget, and makes it revocable; it does not make a leaked dev token a non-event, only a small and recoverable one.

---

## 10. What's deferred / open questions

- **Is the SDK mandatory?** If apps may still call `/_api/*` by hand, the dev-gateway must accept the same raw calls (it does — same verbs); the SDK is then ergonomics, not a gate. Leaning: SDK optional but strongly recommended, mock + impersonation are SDK-only conveniences.
- **Dev token shape:** stateless JWT-over-JWKS (like the portal bearer chain) vs. opaque token in an `app_dev_token` table. Revocation immediacy (§4.1) and origin-binding push toward an opaque, looked-up token; a short-TTL JWT + a small revocation set is the hybrid. Decide alongside the portal mint route.
- **Impersonation (§4.3):** ship in v1 or fast-follow? It is the highest-value dev affordance for `user`-scoped apps but adds a header path to test carefully.
- **dev-gateway placement:** dedicated host (`dev-api.azx-labs.com`) vs. a path on an existing control-plane host. Dedicated host keeps CORS config and the `helix_dev` role cleanly isolated; favored.
- **`azx dev` proxy fidelity:** how much of the real edge it runs in-process (ideally the actual `buildApp()` with a `DevTokenResolver` + CORS-allowlist injected, so dev ≡ prod code) vs. a thinner shim. Favored: reuse `buildApp()` — the seams (§5.4) exist precisely so this is a wiring change, not a fork.
- **Artifacts beyond mock:** if Anthropic's artifact sandbox ever permits a narrow allowlisted `connect-src`, the dev-gateway becomes reachable from artifacts too; until then, mock is the ceiling there.
- **Multiple developers per app:** dev partition is keyed by `developerOid`; do co-developers share one dev partition or get their own sub-partition? Today each developer's `user`-scope is naturally separate; `shared`/`collections` in dev would be common across the team. Probably fine; revisit with per-app RBAC (the existing v1 `PreviewBadge` item).

## 11. Milestone fit

This is **M5+ territory** — it depends on the `/_api/*` gateway (M4) and the secrets/egress plane (M4.5) being in place, which they are locally, and it pairs naturally with the prod Azure deploy (M5) since the dev-gateway is a new deployable surface. It also relates to the deferred **PR preview environments** in `git-connections.md` (§"deferred") — that feature is the *git-driven* cousin of this *manual/IDE-driven* dev tier, and both want the same `env` partition; this doc should land first and the preview-env work reuse its partition + role split.

Suggested order, each shipping adversarial tests in lockstep (project plan §6):

1. **Schema + role split:** the `env` dimension on `app_data` / `app_collection_items` / `gateway_calls`, the `helix_dev` role with the env-literal RLS policies (§5). Load-bearing assertions: "`helix_dev` cannot SELECT a prod row" and "`helix_edge` cannot SELECT a dev row."
2. **Dev token + origins:** portal mint/rotate/revoke routes, the `app_dev_token` / `app_dev_origin` tables, dev-origin registration UI (§4, §7.2).
3. **dev-gateway surface:** the `DevTokenResolver` + CORS-allowlist seam injection, routed to `env=dev` (§5.4). Adversarial twins: cross-origin/unregistered-Origin rejection, prod-data isolation, `env` forgery.
4. **`azx dev` local proxy:** reuse `buildApp()` with the dev seams; developer identity from the `azx login` token (§3, §4.2).
5. **SDK + mock + impersonation** (§8, §4.3) — the ergonomic layer that makes Lovable/Artifacts turnkey.

The load-bearing security assertions across the whole feature are the two isolation tests in step 1: dev mode is only "not a relaxation of the production APIs" if the database itself refuses to cross the env boundary.

---

## Appendix A — Concrete sketches

Sketches, not committed code — they make §5/§7 concrete and show where each piece lands. They are deltas to `app-data-storage.md` Appendix A.

### A.1 Roles — dev-container bootstrap delta

Beside `helix_portal` / `helix_edge` (`app-data-storage.md` A.1), add the dev data-plane role:

```sql
-- .devcontainer/db-init/01-roles.sql  (append)
-- The dev surfaces (dev-gateway, azx dev) run as this role. Least privilege,
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

Identical to `app-data-storage.md` A.3, with one added GUC:

```ts
// dev surfaces set app.env alongside app.app_id / app.user_oid. Same set_config
// (parameterized, transaction-local) discipline; value is server-derived from
// the Caller, never app input. The helix_dev role's policy pins env='dev' anyway.
await client.query(
  "SELECT set_config('app.app_id', $1, true), set_config('app.user_oid', $2, true), set_config('app.env', $3, true)",
  [appId, callerOid, caller.env],   // caller.env === 'dev' on every dev-surface call
);
```
