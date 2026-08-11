# AZX App Platform — App Data Storage (design doc)

**Status:** Design draft v1 · June 2026
**Companion to:** `platform-architecture.md` (the _what & why_, §6.1 names this capability) and `platform-project-plan.md` (§4, the gateway milestones)
**Why this exists:** App data is the second `/_api/*` capability after the LLM gateway (M4). The architecture sketches it in one line — "app-scoped and user-scoped KV/document storage, Postgres JSONB, user-scoped auto-partitioned by the authenticated user" (§6.1, line 170). That sentence hides the load-bearing decision: the naive "per-app KV with symmetric read/write" model is *unsafe* for a whole class of real apps. This doc names that decision, proposes the data model and API, and grounds it in the existing edge/portal trust split.

> **Related ADRs:** [ADR-0015](../adr/0015-app-data-three-scope-model.md) (three-scope app-data) · [ADR-0002](../adr/0002-postgres-role-split-rls.md) (role split + RLS) · [ADR-0023](../adr/0023-one-org-app-id-partitioning.md) (app-id partitioning) · [ADR-0010](../adr/0010-anonymous-shared-writes.md) (anonymous shared writes).

---

## 1. The motivating app (why per-app KV is the wrong default)

A real app from our CEO: a **public** static research site with a chatbot that **harvests visitor email/contact info**. The contacts it collects must reach the *owner* — but no visitor (and no attacker poking the API) may ever read them back. "Dump the contact list" is the headline breach.

The naive model — one per-app bag of keys the frontend reads and writes symmetrically — cannot express this. The contact list is:

- **not user-scoped** — the owner wants every visitor's submission aggregated in one place, not partitioned per visitor;
- **not safe as app-scoped-readable** — if the frontend can list app-scoped rows, any visitor's browser dumps the whole collection.

The reason no app-enforced rule can save us is the platform's founding stance (architecture decision 1): **the app's frontend is untrusted code running in the attacker's browser.** There is no trusted server-side app code to enforce "you may only read your own submission." Therefore:

> **Every confidentiality rule for app data must be enforced by the gateway, keyed off the *caller's identity*, and never off any parameter the untrusted frontend supplies.**

And the structural insight that falls out of the CEO's app:

> **The writer and the reader are different principals.** Visitors *write* contacts; the owner *reads* them. A storage primitive that conflates the two (symmetric KV) cannot be made safe by configuration — the asymmetry has to be in the primitive itself.

---

## 2. Where it lives: edge runtime, portal schema + owner reads

The capability is part of the `/_api/*` gateway, which means **the edge serves the runtime verbs** — same shape and same file neighborhood as the LLM gateway (`apps/edge/src/gateway/llm.ts`). This is forced, not chosen:

- **It must be same-origin.** `/_api/*` lives on the app's own subdomain precisely so the `__Host-session` cookie is usable and CSP `connect-src 'self'` (§4.4) reaches it with zero exceptions. On the portal it would need CORS + cross-origin credentials, fighting the containment model.
- **The authz inputs already live on the edge.** The session gate (`apps/edge/src/auth/gate.ts`) resolves `(app, user)` per request and the Origin/CSRF check (`isSameOrigin`, `apps/edge/src/auth/validate.ts`) is already wired into the gateway. App-data authz is the same triple `(app X, user Y, capability Z)` (§6.3).
- **The edge already writes Postgres.** `PgUsageStore` (`apps/edge/src/gateway/usage.ts`) proves the data plane has a narrow, deliberate write path (`gateway_calls`). App data is the same posture widened by one more table — not a new privilege class.

But the work **splits along the existing trust boundary** (§3), and that split is what makes §1's principal asymmetry real rather than aspirational:

| Plane | Owns | DB privilege |
|-------|------|--------------|
| **Edge** (untrusted-facing, `apps/edge`) | Runtime verbs the app frontend calls: `put`/`get`/`delete` for scoped data; `append` for collections | `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `app_data` **only where the partition key is the caller's own** `(appId[, userOid])`; `INSERT`-only on `app_collection_items` |
| **Portal** (privileged, `apps/portal`) | Schema + Prisma migration; the **owner-facing read/export** of collected data; manifest/capability approval | Full read of `app_collection_items` (the contact drain); the edge role **cannot** do this |

The punchline: **the principal split becomes a database-privilege split.** The edge's DB role gets `INSERT`-only on collection items; the `SELECT *` that drains contacts is a portal-only operation. So even a full edge compromise — or a malicious app — *cannot enumerate the contact list*, because the role it runs as lacks the read grant. Defense-in-depth that falls straight out of the architecture we already have (§3: the data plane "runs with a read-only registry projection and no secret-write access" — we extend that to "and no collection-read access").

### 2.1 Database roles — the split made concrete

Today there is **no split**: both containers connect with the same role, `helix` (`postgresql://helix:helix@db:5432/helix`), which is the database owner. The edge opens several `pg.Pool`s as that role (sessions, usage, registry listener); the portal uses Prisma as the same role. A compromised edge today has owner rights — including `DROP TABLE`. Everything below is the target prod posture. _(ADR-0002 update: the split is now realized for both runtime roles. `helix_edge` and `helix_portal` are the real, tested least-privilege roles in the running config — the portal runtime connects as `helix_portal` via `PORTAL_DATABASE_URL`, the edge as `helix_edge` via `EDGE_DATABASE_URL`. In production both are required and the owner-DSN fallback is refused (boot-fail); outside production the fallback stays a dev convenience. Migrations still run as the `helix` owner.)_

**Three roles, split on the service/trust boundary — not on the operation:**

| Role | Used by | Rights |
|---|---|---|
| `helix_migrate` (object owner) | Prisma migrations only; never a runtime connection | Owns all tables/sequences; `ALTER`/`DROP`/`CREATE` |
| `helix_portal` | portal container runtime | Full DML on all tables (collection drain, usage reads, registry writes) |
| `helix_edge` | edge container runtime | Least-privilege union of the data-plane verbs (below) |

`helix_migrate` is the non-obvious one and it is load-bearing: **neither runtime role may *own* the tables.** An owner can `ALTER`/`DROP` and `GRANT` itself more, and — critically — **a table owner bypasses RLS**. So the object owner is a fourth principal that only the migration step connects as.

**The edge uses one role, not a role-per-operation.** `helix_edge` holds the *union* of everything the edge legitimately does; the containment is the grant set, not switching roles per query. Per-operation `SET ROLE` buys nothing against the threat that matters (a compromised or injected edge process): if `helix_edge` is a member of a stronger role it can just `SET ROLE` into it or never switch down, and the only thing that survives compromise is a grant that *isn't there*. So the boundary lives entirely in the GRANTs, and `helix_edge` must not be a member of any stronger role.

**Layer 1 — table/column GRANTs on `helix_edge`** (survives process compromise):

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions             TO helix_edge;  -- gate + handoff burn
GRANT SELECT                         ON apps, versions        TO helix_edge;  -- registry projection (read-only)
GRANT SELECT, INSERT                 ON gateway_calls         TO helix_edge;  -- meter: append + SUM today
GRANT SELECT, INSERT, UPDATE, DELETE ON app_data             TO helix_edge;  -- §3.1/§3.3 scoped KV
GRANT INSERT                         ON app_collection_items  TO helix_edge;  -- §3.2 append-only; NO SELECT/DELETE
```

The §3.2 write-only property is *purely* the absence of `SELECT` on `app_collection_items`. That single missing grant is what survives an edge RCE. (Note the edge is already read-write on `sessions` and `gateway_calls` — `apps/edge/src/auth/sessions.ts`, `gateway/usage.ts` — so "least privilege" here is a tight union, not "read-only".)

**Layer 2 — Row-Level Security on `app_data`** (survives a buggy or injected `WHERE`):

Table GRANTs can't say "only the caller's rows." The hand-written `WHERE appId = $1 AND userOid = $2` is the first line; RLS makes the partition a database invariant. Each data request runs in a transaction that sets the predicate from the **verified session** (never from app input):

```sql
BEGIN;
SET LOCAL app.app_id   = '<entry.appId>';
SET LOCAL app.user_oid = '<session.user.oid>';
-- policy on app_data:
--   USING (appId = current_setting('app.app_id')::uuid
--          AND (userOid IS NULL OR userOid = current_setting('app.user_oid')))
SELECT value FROM app_data WHERE appId = $1 AND userOid = $2 AND key = $3;
COMMIT;
```

Caveats that make RLS actually hold:
- **`SET LOCAL`, never bare `SET`** — `LOCAL` is transaction-scoped, so it resets at commit and is safe under transaction-mode pgbouncer. A bare `SET` leaks the previous request's `user_oid` onto the next pooled connection. This is the biggest footgun.
- `helix_edge` must **not own** the tables and must **not** have `BYPASSRLS` — both silently skip policies (hence `helix_migrate`).
- Costs a transaction per data request. Treat RLS as recommended hardening for `app_data`; collections need none (there is no read to scope).

**Where it lives:**
- **Role creation** is environment-level → infra/Terraform bootstrap (a small init SQL on the dev-container `db` service), not a Prisma migration.
- **GRANTs and RLS policies** track the schema → in the migrations (`prisma migrate dev --create-only`, then hand-edit the SQL). The migration that creates `app_collection_items` is the one that grants `helix_edge` `INSERT`-only on it.
- This is **fail-closed by default**: a new table grants `helix_edge` nothing until a migration says so (Postgres default is owner-only; do **not** set permissive `ALTER DEFAULT PRIVILEGES` for `helix_edge`). A forgotten grant breaks loudly in staging rather than silently over-sharing.

---

## 3. The data model — three scopes, not two

Replace the architecture's implicit two scopes with three named **access patterns**. The scope *is* the security boundary, so it is named explicitly and is immutable for a given key/collection.

### 3.1 `user` — per-user private store (the safe default)
Auto-partitioned by the authenticated user. The gateway injects `WHERE appId = ? AND userOid = ?` from the **session**, never from app input. The untrusted frontend cannot phrase a query that returns another user's row.

- Verbs (all gated, all caller-scoped): `PUT /_api/data/user/:key`, `GET /_api/data/user/:key`, `DELETE /_api/data/user/:key`, `GET /_api/data/user` (list the caller's own keys).
- Use: "save my todo list," "my chat history," per-user preferences.
- Requires an authenticated user — see §6 on what that means for public apps.

### 3.2 `collection` — append-only, write-from-app / read-from-owner (the harvester)
The right primitive for the CEO's app. The frontend may **insert** an item; **list/read/delete are not exposed to the app frontend at all.** From the browser the collection is write-only. The owner drains it via the portal or an export.

- App-facing verb: `POST /_api/data/collections/:name` — appends one JSON item (plus server-stamped `createdAt`, `userOid` if any, request metadata for abuse triage). **No GET/LIST/DELETE on the edge.**
- Owner-facing: portal UI/API only — list, paginate, export CSV/JSON, delete. Enforced by the portal's own auth (app ownership), on the privileged DB role.
- Use: contact harvest, feedback/suggestion box, waitlist signups, survey responses — anything collected *from* users *for* the owner.
- An attacker hitting the endpoint can add junk rows (an abuse/quota problem — §7, rate-limited and audited) but **can never enumerate**.

#### 3.2.1 The owner-facing drain, as built (2026-08-10)

Three decisions were open when the read side shipped API-only; building the portal UI forced them.

**The reads are `ownsApp`-gated, not merely sign-in-gated.** The original axis — gate mutations, let any signed-in principal read — is wrong for this scope specifically. The whole premise of §3.2 is that the writer and reader are different principals, which makes the read side *by construction* the most privileged thing in the feature. Leaving it open reopened the harvesting class one layer up: not in the app, but between operators in the control plane. Recorded as an amendment to ADR-0007, which now states the criterion as **"any route returning data the app itself cannot read carries `ownsApp`."** Aggregate metering may stay sign-in-gated; per-subject rows may not.

**Both tiers are visible; the UI defaults to prod.** The API returns `prod` and `dev` rows together unless `?env=` narrows it, matching the deliberately cross-env portal RLS policy — an owner is not a different principal from themselves, and dev rows are still their data and their erasure obligation. But the *table* defaults to `prod`, because a developer's own test submissions must never read as real leads. The cost of that default is the "I tested in dev and my data vanished" failure, so the filter is required to announce what it is holding back ("340 more rows in the other tier"). **A tier is a presentation filter here, never a wall.** The alternative — hiding dev rows entirely — was rejected because it conceals the existence of data the owner is accountable for.

**Columns are derived, and the derivation is adversarial input handling.** Owner-declared item schemas stay deferred (§9), so the table and CSV derive columns from the rows themselves. Because `item` is anonymous-visitor JSON, **the column set is attacker-influenced**, which makes these formatting-looking rules into security rules: frequency ranking (so one 60-key junk row cannot evict `email`), scalar-only with a whole-key disqualification (so no column ever silently drops values from an export), a hard cap, `item.` namespacing (which removes collision logic *and* neutralises header-row formula injection), and spreadsheet-formula neutralisation on the CSV path only. Full rules and rationale: `docs/features/app-data-gateway.md` → "Derived columns"; the executable spec is `packages/shared/src/collectionTable.test.ts`.

No ADR for the derivation: it is display-only and fully reversible — the raw `item` column is always present, so nothing is lost by changing or removing it — and a future declared schema would supersede it rather than conflict. Deriving from the loaded rows also means the table (200 rows) and the export (up to 10,000) can legitimately disagree about columns; sharing the code buys one spec, not identical output.

### 3.3 `shared` — app-scoped, world-readable (rare, explicit, dangerous)
Truly shared state every user of the app may read: a public leaderboard, a shared document, a poll tally. Its blast radius is "any visitor reads everything," so it is **never a default** — it is a distinct grant the owner must request, and the manifest copy should say so in plain language.

- Verbs: `GET /_api/data/shared/:key` (open to all who pass the app's visibility gate), writes are a *separate, narrower* grant (`shared:write` — usually off; if on, every visitor can mutate shared state, which is its own footgun, so prefer owner-seeded shared data).
- Use only when the data is *intended* to be visible to every user of the app.

The single most important rule across all three: **a grant of write never implies a grant of read.** §3.2 is the proof that they must be independent.

---

## 4. Manifest capability shape

Today's shape conflates exactly the distinction §3 turns on:

```ts
// packages/shared/src/manifest.ts (current)
export const DataCapabilitySchema = z.object({
  appScope: z.boolean().default(false),   // "app-scoped" — but readable? writable? both?
  userScope: z.boolean().default(false),
});
```

`appScope: true` can't tell "append a contact, owner reads" from "any visitor reads everything." Proposed refinement — name the access patterns, keep read and write independent:

```ts
export const DataCapabilitySchema = z.object({
  /** Per-user private store (§3.1). Auto-partitioned by session user. */
  user: z.boolean().default(false),
  /** Append-only collections the app may write; owner reads via portal (§3.2). */
  collections: z.array(z.string().min(1)).default([]),
  /** App-shared keys readable by every visitor (§3.3). Rare, explicit. */
  sharedRead: z.array(z.string().min(1)).default([]),
  /** App-shared keys the app frontend may also write. Usually empty. */
  sharedWrite: z.array(z.string().min(1)).default([]),
});
```

Manifest YAML (mirrors §6.3 style):

```yaml
# the CEO's harvester
capabilities:
  data:
    collections: [contacts]      # write-only from the app; owner drains via portal
    # no user / sharedRead / sharedWrite — the app stores nothing else
```

```yaml
# a per-user notes app behind SSO
capabilities:
  data:
    user: true
```

`sharedWrite` above a trivial size, and any `sharedRead`/`sharedWrite` on a `public`-visibility app, are *candidates* for the admin-approval baseline (§6.3 "grants above a baseline require approval"). **Reality check (ADR-0010):** in shipped code this is **not** approval-gated — `classifyChange` treats enabling `sharedWrite` as baseline/low-risk, so anonymous writes to `shared` keys on a `public` app apply without admin review; approval-gating `public` + `sharedWrite` is tracked (DEC-02). The registry projection (`apps/edge/src/registry/projection.ts`) gains a `data: DataCapability | null` field, parsed fail-closed exactly like `llm` is today.

---

## 5. API surface and storage schema

### 5.1 Endpoints (all on app hosts; all behind the gate + Origin check)

| Method · Path | Scope | Authz |
|---|---|---|
| `PUT /_api/data/user/:key` | user | session user; manifest `data.user` |
| `GET /_api/data/user/:key` | user | session user; own partition only |
| `DELETE /_api/data/user/:key` | user | session user; own partition only |
| `GET /_api/data/user` | user | lists caller's own keys |
| `POST /_api/data/collections/:name` | collection | `:name` ∈ manifest `data.collections`; **append only** |
| `GET /_api/data/shared/:key` | shared | `:key` ∈ `data.sharedRead`; passes visibility gate |
| `PUT /_api/data/shared/:key` | shared | `:key` ∈ `data.sharedWrite` (rare) |

Every handler reuses the LLM gateway's preamble verbatim (`apps/edge/src/gateway/llm.ts`): `resolveServingEntry` → `gate()` (401/403) → `isSameOrigin` (CSRF 403) → capability/scope check (403 `forbidden`) → body validation (400 `validation_failed`). Errors use the existing `ApiErrorCode` set (`packages/shared/src/api.ts`); add `quota_exceeded`-style reuse for §7. Reads send `cache-control: no-store`. **There is no list/read verb for collections** — its absence is the security property, so it must be covered by an adversarial test (project plan §6) asserting `GET`/`DELETE` on a collection path 404s/405s.

### 5.2 Schema (portal-owned Prisma; edge writes via hand SQL)

Two tables, both `@@map`'d snake-case, both following the `GatewayCall` precedent (no FK to `apps` so the data outlives an app row; the edge supplies `gen_random_uuid()` in raw SQL since Prisma's `uuid()` default is client-side):

```prisma
/// Per-user / per-app key-value store (architecture §6.1, app-data design §3.1/§3.3).
/// Edge-written like sessions/gateway_calls: the edge reads & writes ONLY rows whose
/// partition key is the caller's own (appId[, userOid]); the SELECT-all path does not
/// exist for the edge role. JSONB value, app-supplied.
model AppData {
  id        String   @id @default(uuid()) @db.Uuid
  appId     String   @db.Uuid
  /// null = app-shared (§3.3); non-null = the owning user (§3.1).
  userOid   String?
  key       String
  value     Json
  updatedAt DateTime @default(now()) @updatedAt
  /// One row per (app, user-or-shared, key); the gateway's partition is the unique key.
  @@unique([appId, userOid, key])
  @@map("app_data")
}

/// Append-only collection items (§3.2) — write-from-edge, read-from-portal.
/// The edge role has INSERT only; the portal owns the read/export/delete path.
model AppCollectionItem {
  id         String   @id @default(uuid()) @db.Uuid
  appId      String   @db.Uuid
  collection String
  /// The visitor who submitted, if authenticated; null on public/anon apps (§6).
  userOid    String?
  item       Json
  /// Coarse abuse-triage metadata (hashed IP, UA) — never exposed to the app.
  meta       Json?
  createdAt  DateTime @default(now())
  @@index([appId, collection, createdAt])
  @@map("app_collection_items")
}
```

A new `apps/edge/src/gateway/data.ts` mirrors `usage.ts`: a `PgAppDataStore` with caller-scoped methods only (`getUserKey`, `putUserKey`, `deleteUserKey`, `listUserKeys`, `appendCollection`, `getShared`, `putShared`). The store **has no `listCollection` method** — the type system carries the security property into the edge codebase.

---

## 6. The public-visibility gap (must be closed first)

Critical current-state finding: **public and password apps fail closed today.** `visibilityAllows()` returns `false` for both, and `resolveAppForAuth()` rejects them as `unsupported-mode` (`apps/edge/src/auth/validate.ts:53,81`). There is no anonymous identity in the system — every served request currently carries a real logged-in `session.user.oid`.

So before the CEO's *public* app can call `/_api/data` at all, the platform must define **who "the user" is for an anonymous visitor**, and that decision shapes the data model:

- **No identity (recommended starting point).** Public apps get `user`-scoped storage *disabled* — there is no stable principal to partition by. Only `collection` (§3.2, `userOid` null) and `shared` (§3.3) are available. This fully serves the harvester: it writes to `contacts` with no user attribution, and that's correct.
- **Per-browser anon token (later, opt-in).** A signed, `__Host-` anon cookie gives a stable-but-unauthenticated pseudo-user, enabling `user`-scope on public apps ("your cart" on a public store). It is **spoofable and clearable**, so it is a *convenience* partition, never a confidentiality boundary — it must never gate a `collection` drain or `shared` read.

Either way, the audit/metering record's user field becomes `anon` for these calls, and the abuse story (§7) shifts from per-user to per-IP/per-app — see next.

This gap is a prerequisite, not part of the data feature proper; it likely lands as its own slice (public/password visibility + optional anon identity) that the data capability then builds on.

---

## 7. Abuse, quota, and metering

The append endpoint on a public app is an open write surface, so containment moves from confidentiality (handled structurally by §2–§3) to **abuse**:

- **Per-app daily write budget**, enforced exactly like the LLM `tokensPerDay` block-new/finish-in-flight pattern (`llm.ts`): a `writesPerDay` / `bytesPerDay` in the `data` manifest, checked at admission, returning `429 quota_exceeded`. **Caveat (ADR-0010):** `writesPerDay` is a **single per-app counter** summed across `user.put` + `collection.append` + `shared.put`, so an anonymous flood through an un-elevated `sharedWrite` surface can **self-DoS the app's own authenticated** user/collection writes once the budget is hit. Separating or attributing the anonymous budget is tracked (DEC-02).
- **Per-IP rate limiting** is **implemented** for the whole anonymous tier (not just `collection` appends — the anonymous writer/visitor has no per-user budget to charge): a fixed-window in-memory limiter (`apps/edge/src/gateway/ipRateLimiter.ts`, mirroring the password-login throttle) caps every anonymous `/_api/*` call keyed per IP+app, returning `429 rate_limited`; authenticated callers are charged against per-app budgets instead. Tunable via `EDGE_ANON_RATE_LIMIT` / `EDGE_ANON_RATE_WINDOW_MS` (`max: 0` disables). Same caveat as the login throttle: per-process state on a horizontally-scaled edge, so the effective limit is N×instances — a shared (DB/Redis) counter is future hardening. The **item-size cap** (64 KB) is also in place; **total-collection-size cap** remains a deferred knob.
- **Friction for public collections** (CAPTCHA / proof-of-work) is a later knob; out of scope for v1 but the `meta` column (hashed IP/UA) is there to make abuse triage and retroactive cleanup possible.
- **Every call is metered**, reusing the `gateway_calls` ledger with `capability = "data"` and a sensible `outcome` (`ok` / `quota_blocked` / `error`). The portal's usage tab and audit log (§8) already read this ledger and need no schema change for the common case — only the `capability` value widens.

---

## 8. Threat mapping (the CEO's app, walked through)

| Attack | Defense |
|---|---|
| Visitor's browser tries to list/read `contacts` | No read/list verb exists on the edge for collections (§3.2, §5.1); path 404s. Adversarial test asserts this. |
| Attacker compromises the **edge** process and tries to dump contacts | Edge DB role has `INSERT`-only on `app_collection_items` (§2); the `SELECT *` grant lives only on the portal role. |
| Malicious **app** declares `collections: [contacts]` then tries to read them back | Same as above — the read path is not exposed to any app, by construction, regardless of manifest. |
| Sibling subdomain POSTs to the harvester's `/_api/data/...` on the user's session (CSRF) | `isSameOrigin` Origin check (§4.2), reused from the LLM gateway; missing/foreign Origin → 403. |
| App tries to read *another user's* `user`-scoped notes | Partition key injected from session, not app input (§3.1); query can only ever touch the caller's rows. |
| Spam/flooding the public append endpoint | Per-IP rate limit + per-app `writesPerDay`/`bytesPerDay` quota + size caps (§7); rows are junk, not a disclosure. |
| App granted `sharedRead` leaks data it shouldn't have made shared | Owner-declared, auditable grant. *(Design intent was for `sharedRead`/`sharedWrite` on public apps to hit the admin-approval baseline (§4, §6.3); in shipped code they are **not** approval-gated — enabling `sharedWrite` is baseline/low-risk, ADR-0010 / DEC-02.)* |

Residual risk to name (consistent with architecture §residual-risk): a granted capability can be misused *within its scope*. An app with `sharedWrite` can let any visitor vandalize shared state; an app with `user` scope can still mishandle its own users' data in the UI. Governance bounds blast radius; it does not make app code trustworthy.

---

## 9. What's deferred / open questions

- **Document queries beyond KV.** The architecture says JSONB; this doc keeps v1 to key-addressed values + append-only collections. Richer per-app queries ("filter my items by field") are the "richer app/user data queries" of the custom-backends rung 0 (`docs/design/custom-backends.md` §3) and can layer on `app_data` later without changing the security model.
- **Schema/validation of stored items.** v1 stores opaque app-supplied JSON (size-capped). Owner-declared item schemas (so the portal export has typed columns) is a nice-to-have, not v1. **Partially answered by derivation** (§3.2.1): the drain infers columns from the data instead, which covers the homogeneous-form case without a schema. A declared schema would still be better — it would give the export stable columns regardless of which rows were sampled, and would let junk submissions be rejected on write rather than merely out-ranked at display time.
- **Anon identity for public apps** (§6) — its own slice; pick "no identity" first.
- **Shared-write conflict semantics** (last-write-wins vs optimistic concurrency on `updatedAt`) — only matters once `sharedWrite` has a real user; default LWW.
- **Export/retention** for collections (GDPR-style deletion of a contact) — portal-side, owner-driven; the `meta` column and per-row `id` make it tractable.

## 10. Milestone fit

This is M4/M5 territory (the `/_api/*` gateway, project plan §4), sequenced after the LLM gateway it mirrors. Suggested order:

1. **Prereq:** public/password visibility (+ "no anon identity" decision, §6).
2. `user`-scoped store (§3.1) — the safe, fully-authenticated case; smallest blast radius; validates the edge store + manifest shape end-to-end.
3. `collection` append + portal drain/export (§3.2) — unblocks the CEO's app; the DB-role split (§2) ships here and is the security centerpiece.
4. `shared` read (§3.3) + abuse/quota knobs (§7) as demand appears.

Each step ships adversarial tests in lockstep (project plan §6); the load-bearing assertions are "no collection read verb exists" and "edge role cannot SELECT collection items."

---

## Appendix A — Concrete bootstrap (dev-container init SQL + first GRANT migration)

Sketches, not committed code — they make §2.1 concrete and show where each piece lands. Two artifacts: the **roles** (environment-level, infra/bootstrap) and the **grants + RLS** (schema-level, Prisma migration).

### A.1 Roles — dev-container bootstrap

Roles are environment state, not schema, so they live with the `db` service, not in a migration. Today both containers connect as the `helix` owner (`.devcontainer/docker-compose.yml`); this adds the two runtime roles beside it. Postgres runs `*.sql` in `/docker-entrypoint-initdb.d` once, on an empty data dir.

```sql
-- .devcontainer/db-init/01-roles.sql  (mount into /docker-entrypoint-initdb.d)
-- Dev only. In prod these are Terraform-managed with real/IAM credentials.
-- `helix` (POSTGRES_USER) is the object owner == the §2.1 `helix_migrate` role
-- in dev; migrations already run as it. We add the two least-privilege runtime
-- roles. NOINHERIT + no role membership => neither can SET ROLE up to the owner.
CREATE ROLE helix_portal LOGIN PASSWORD 'helix_portal' NOINHERIT;
CREATE ROLE helix_edge   LOGIN PASSWORD 'helix_edge'   NOINHERIT;

-- Both connect to the same database and need the schema on their search_path.
GRANT CONNECT ON DATABASE helix TO helix_portal, helix_edge;
GRANT USAGE   ON SCHEMA public  TO helix_portal, helix_edge;

-- helix_portal: full DML runtime (control plane). Table grants are reissued by
-- migrations as tables appear; this default keeps existing tables reachable.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO helix_portal;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO helix_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE helix GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helix_portal;

-- helix_edge: NO blanket grant. Every table is owner-only until a migration
-- grants it explicitly (fail-closed, §2.1). Do NOT add ALTER DEFAULT PRIVILEGES
-- for helix_edge — that would silently grant new tables.
```

Then point each service's pool at its own role: the edge runs as `helix_edge`, the portal as `helix_portal`, migrations stay on `helix`. In the dev compose that's a second connection string per service (e.g. `EDGE_DATABASE_URL`, leaving `DATABASE_URL` as the migrate/portal URL); wiring that env split is part of the milestone-3 step (§10), not this doc.

### A.2 Grants + RLS — in the table migration

GRANTs and policies track the schema, so they go **in** the migration that creates the tables (`prisma migrate dev --create-only`, then append this SQL — same hand-edited-raw-SQL pattern as `20260612183907_registry_notify_trigger/migration.sql`). Prisma emits the `CREATE TABLE`s; you append:

```sql
-- migrations/<ts>_app_data/migration.sql  (appended after Prisma's CREATE TABLEs)

-- §3.1/§3.3 scoped KV: edge does full DML, but only within its own partition,
-- enforced below by RLS. Owner (helix) keeps implicit full access for migrations.
GRANT SELECT, INSERT, UPDATE, DELETE ON app_data TO helix_edge;

-- §3.2 append-only collections: INSERT only. The ABSENCE of SELECT/DELETE here
-- is the security property — a compromised edge cannot enumerate the collection.
GRANT INSERT ON app_collection_items TO helix_edge;

-- Portal drains/exports collections and reads everything for owner-facing views.
GRANT SELECT, INSERT, UPDATE, DELETE ON app_data, app_collection_items TO helix_portal;

-- RLS on app_data: the per-user/app partition becomes a DB invariant, holding
-- even if a hand-written WHERE is wrong. The predicate is set per request from
-- the VERIFIED session via SET LOCAL (never from app input). FORCE so the table
-- owner is subject to it too in dev; helix_edge has no BYPASSRLS.
ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_data FORCE  ROW LEVEL SECURITY;

CREATE POLICY app_data_partition ON app_data
  USING (
    "appId" = current_setting('app.app_id', true)::uuid
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  )
  WITH CHECK (
    "appId" = current_setting('app.app_id', true)::uuid
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  );
-- current_setting(..., true) => missing GUC returns NULL (not an error), so the
-- policy fails closed: a query that forgot SET LOCAL matches zero rows.
```

`app_collection_items` gets **no** policy — the edge's `INSERT`-only grant already makes it write-only, and there is no read path to scope.

### A.3 The edge's request shape

Each `app_data` request runs in a transaction so `SET LOCAL` is scoped to it (pgbouncer-safe; resets on commit). A thin helper in the new `apps/edge/src/gateway/data.ts` (mirroring `PgUsageStore`):

```ts
// inside PgAppDataStore — caller-scoped methods only; NO listCollection method.
async getUserKey(appId: string, userOid: string, key: string): Promise<unknown> {
  const client = await this.#pool.connect();
  try {
    await client.query("BEGIN");
    // Parameterized SET LOCAL via set_config — values come from the verified
    // session/registry entry, never from app input.
    await client.query("SELECT set_config('app.app_id', $1, true), set_config('app.user_oid', $2, true)", [appId, userOid]);
    const r = await client.query(
      `SELECT value FROM app_data WHERE "appId" = $1 AND "userOid" = $2 AND key = $3`,
      [appId, userOid, key],
    );
    await client.query("COMMIT");
    return r.rows[0]?.value ?? null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
```

Note `set_config(name, value, true)` rather than `SET LOCAL name = '...'` — it parameterizes the value, so even though `appId`/`userOid` are server-derived, there's no string interpolation into SQL. The `true` is the `is_local` flag (transaction-scoped), matching `SET LOCAL`.
