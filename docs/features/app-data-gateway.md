# App-data gateway

> **Related ADRs:** [ADR-0015](../adr/0015-app-data-three-scope-model.md) (three-scope app-data) · [ADR-0002](../adr/0002-postgres-role-split-rls.md) (role split + RLS) · [ADR-0014](../adr/0014-same-origin-api-gateway.md) (same-origin `/_api/*` gateway) · [ADR-0010](../adr/0010-anonymous-shared-writes.md) (anonymous shared writes) · [ADR-0021](../adr/0021-metering-ledger.md) (metering ledger) · [ADR-0023](../adr/0023-one-org-app-id-partitioning.md) (app-id partitioning) · [ADR-0041](../adr/0041-app-data-write-concurrency.md) (write concurrency: CAS on an opaque version, mandatory on `shared`).

**What it is.** `/_api/data/*` — the gateway's second capability (architecture §6.1, app-data
design [§3/§5](../design/app-data-storage.md)). Untrusted apps get persistent storage without a
backend of their own, in **three named access patterns** (not a symmetric KV — reader and
writer can be different principals, so read and write are independent grants):

- **`user`** (§3.1) — a per-user private store, auto-partitioned by the signed-in user. Public
  apps have no user scope.
- **`collections`** (§3.2) — **append-only** from the app; the owner drains them via the portal.
  There is deliberately **no app-facing read** — the absence is the security property.
- **`shared`** (§3.3) — app-scoped, world-readable-within-the-gate keys. Rare and dangerous;
  a `sharedWrite` grant never implies `sharedRead`.

Edge handler: `apps/edge/src/gateway/data-handler.ts` (`makeDataHandlers`). Store:
`apps/edge/src/gateway/data.ts` (`PgAppDataStore`). Route table: `apps/edge/src/app.ts`
(the `/_api/data/*` block).

## How it works

### The route table is part of the security model

```
PUT    /_api/data/user/:key          putUser        (precondition optional)
GET    /_api/data/user/:key          getUser        (emits ETag)
DELETE /_api/data/user/:key          deleteUser
GET    /_api/data/user               listUser
POST   /_api/data/collections/:name  postCollection (append-only)
GET    /_api/data/shared/:key        getShared      (emits ETag)
PUT    /_api/data/shared/:key        putShared      (precondition MANDATORY)
```

Note the **deliberate absence** of any collection list/read/delete verb. The §3.2 write-only
invariant is carried into the route table **and** the store type — `AppDataStore` has no
`listCollection`/`getCollection` method at all — and an adversarial test asserts those paths
404/405.

### Shared preamble + per-verb checks

`preamble()` reuses the LLM gateway's shape: resolve entry → resolve `Caller` (gate, or anon on
public apps) → Origin/CSRF check **on mutations** → capability configured (`store` non-null,
else 503) → app holds a `data` grant (`entry.data`, else 403). Then per verb:

- **User scope** (`requireUser`) requires `entry.data.user` **and** an authenticated caller —
  public apps get `403` ("requires a signed-in user").
- **Collections** require the name to be in `entry.data.collections`; available to authenticated
  **and** anonymous callers (the harvester is a public app). The response is `201` with **no
  body** — the writer gets no row id and no read-back.
- **Shared** requires the key to be in `entry.data.sharedRead` (read) or the narrower
  `entry.data.sharedWrite` (write).

### Optimistic concurrency (ADR-0041)

Writes are compare-and-swap on an opaque monotonic `version` column (`BIGINT` — pg returns
it as a **string**, which is exactly what an opaque ETag should be; `updatedAt` was rejected
because the microsecond→millisecond round-trip through node-postgres can't survive a `WHERE`
equality). Single-key GETs and successful PUTs emit it as `ETag: "<version>"` (reads stay
`cache-control: no-store`; conditional reads/`304` are not in scope). A PUT states its
assumption with a header, and each precondition is its **own SQL statement** — a single
`INSERT … ON CONFLICT DO UPDATE … WHERE version = $n` upsert was rejected because it inserts
when no row exists even though the client asserted a current value:

| Request           | Statement                                             | Zero rows means |
| ----------------- | ----------------------------------------------------- | --------------- |
| `If-Match: "n"`   | `UPDATE … WHERE … AND version = $n`                   | `412 conflict`  |
| `If-None-Match: *`| `INSERT … ON CONFLICT DO NOTHING` (create-if-absent)  | `412 conflict`  |
| no precondition   | today's upsert — `user` scope only                    | n/a             |

Preconditions are **mandatory on `shared`** (a race there is between different, mutually
unaware principals; the loser never finds out) and **optional on `user`** (the race is one
person's two tabs; last-write-wins stays the default). A shared PUT with neither header is
`428 precondition_required`; `If-Match: *` is refused everywhere — on shared it is the
one-character escape hatch around the mandate. Neither failure is **charged** against
`writesPerDay` (a contended retry loop must not become a quota outage), but a `412` still
records a non-charging `conflict` ledger row so contention is visible in the usage tab and
audit log; a `428` records nothing (it never reaches the store and fires in dev on the
first write). A `412` body also carries `error.details.currentVersion` — the version the
winner committed (null when the key is absent) — so the loser can recover in-band; for a
`sharedWrite`-only key, whose writer holds no read grant, that disclosure is the *only*
recovery path. Strict parsing: ETag lists, weak validators, a concrete `If-None-Match`,
duplicated headers, and non-canonical or out-of-int64-range versions are all `400
validation_failed` rather than silently downgraded to last-write-wins (or, for the
out-of-range case, exploded as a 502 at bind time). One known gap, deliberately accepted:
the version is a per-row counter, so `DELETE` + recreate restarts it at 1 and a stale
`If-Match: "1"` would match a value it never read (ABA). DELETE is user-scope-only today —
the race is one person's own tabs — and the fix (a row-birth nonce in the ETag) is due the
day a shared delete verb lands, not before (ADR-0041 non-goals).

Validation knobs: keys ≤ 256 chars with no control chars; values size-capped at **64 KiB** of
opaque app JSON (`MAX_VALUE_BYTES`). Writes (`user.put`, `collection.append`, `shared.put`) go
through `admitWrite` — a per-app daily `writesPerDay` budget, block-new like the LLM
`dollarsPerDay` (over budget → `429` + a `quota_blocked` meter row). Every verb meters into
`gateway_calls` with `capability: "data"` and a `model` like `user.put` / `collection.append`.
On `public` apps the **anonymous tier is also per-IP rate-limited** ahead of the store call (the
shared preamble, before the size/budget checks): a fixed-window limiter keyed per IP+app
(`ipRateLimiter.ts`) returns `429 rate_limited`. Rate-limited calls are deliberately **not**
metered — a ledger row per throttled request would be its own write-amplification vector.

### Storage + the RLS partition

`PgAppDataStore` uses hand-written SQL (no ORM):

- **`app_data`** (user + shared) — every access runs in a transaction that sets the RLS
  partition GUCs **from the verified session**:
  `SELECT set_config('app.app_id', $1, true), set_config('app.user_oid', $2, true)` — the
  parameterized, transaction-scoped (`SET LOCAL`) form, pgbouncer-safe, no string interpolation,
  no app input. The values are server-derived (registry entry + session). The RLS policy on the
  table (`FORCE`, so the table owner is subject too) admits a row only when `app_id` matches and
  the row is either user-owned-by-this-user or shared (`userOid IS NULL`). Missing GUCs → zero
  rows (fail closed).
- **`app_collection_items`** (collections) — a plain `INSERT` with **no transaction or RLS**:
  the edge role has `INSERT`-only on this table, which **is** the containment. There is no read
  to scope. A coarse, non-reversible `meta` is stamped server-side (`triageMeta`: hashed IP +
  truncated UA) and is never echoed to the app.

### The owner-facing read side (portal)

Because the edge cannot read collections, the **portal** is the exclusive read/export/erase
endpoint (`apps/portal/src/routes/data.ts`), running on the privileged `helix_portal` role. Every
route is `[authenticate, ownsApp]` — **including the reads**, unlike the aggregate usage routes,
because these return per-subject PII the collecting app cannot itself see (ADR-0007, amended
2026-08-10):

```
GET    /api/v1/apps/:slug/collections                 what exists: [{name, env, count, lastAt}]
GET    /api/v1/apps/:slug/collections/:name           paginate newest-first (?limit≤200, ?before=ISO)
GET    /api/v1/apps/:slug/collections/:name/export    JSON or CSV, newest 10,000, emitted oldest-first
DELETE /api/v1/apps/:slug/collections/:name/items/:id GDPR-style single-item erasure → 204
```

Both per-collection reads take `?env=prod|dev`; **absent (or empty) means both tiers** (the portal
policy on the table is cross-env by design — only the runtime roles are pinned). The index does not
take it — it groups by `(collection, env)` instead, so a prod-filtered UI can say how many rows it
is holding back. The index is a pure aggregate over the
rows, deliberately not a manifest join: grants are owner-editable and nothing deletes rows, so a
collection dropped from `data.collections` still holds PII the owner must be able to reach — the
manifest alone cannot surface those orphans. Callers union the two.

**The export selects newest-first and emits oldest-first**, which are two separate decisions. When a
collection outgrows the cap the rows that must survive are the ones that just arrived, so selection
is descending; the kept window is then reversed so the file still reads as a chronological log.
(The list route is newest-first in both senses — only the export reverses.) Conflating the two is
what the first cut got wrong: it selected oldest-first and capped, dropping every recent submission
from a drain while reporting the opposite.

The export surfaces truncation via an `x-helix-export-truncated` header rather than silently
capping (app-data design §7), and writes a `collection.exported` audit row; the item delete writes
`collection.item_deleted`. The paginated list is deliberately not audited (too chatty). Since
platform-admins pass `ownsApp`, the audit row — not the gate — is what makes a cross-owner read
reviewable. Wire shapes: `CollectionItem` / `CollectionItemsPage` / `CollectionSummary` in
`packages/shared/src/data.ts`.

**The owner's view: `apps/portal-web` → app detail → Data tab** (`pages/tabs/DataTab.tsx`) — a
collection picker with counts, the newest 200 rows, a per-row raw-JSON detail, per-item erasure, and
CSV/JSON download. Because `item` has no declared schema, columns are **derived** from the rows:
`deriveCollectionColumns` in `packages/shared/src/collectionTable.ts` is shared by the table and
the CSV so both obey one spec (see "Derived columns" below). The download goes through `fetchText`
rather than an `<a href>` — a browser navigation carries no `Authorization` header.

### Derived columns (`packages/shared/src/collectionTable.ts`)

`item` is opaque, unvalidated, **anonymous-visitor-supplied** JSON, so the rules that pick columns
are security rules, not formatting preferences: the column set is attacker-influenced. The
specification is `collectionTable.test.ts`; the rules are:

- **Scalar only** (`string | number | boolean | null`), and a key qualifies only if *every*
  occurrence is scalar. A sometimes-object key gets **no** column — better than a column that
  silently drops the object-valued rows from an export.
- **Frequency-ranked**, tie-broken by order of first encounter. Not first-seen-wins: one junk
  submission carrying 60 keys would otherwise evict `email`. (Equal-frequency columns land in
  `jsonb`'s canonical key order — Postgres normalises by key length then bytewise, so the order the
  app posted its fields in is already lost on write. Deterministic, but not authored.)
- **Capped at 12**, with a `truncated` flag so the UI can say keys are missing.
- **`item.`-namespaced** — `id,createdAt,env,userOid,userName,userEmail,item.email,…,item,meta`. This removes all
  collision logic (an app posting `{"env":…}` cannot shadow the platform column), survives adding
  new platform columns, and neutralises formula injection in the header row for free.
- **Null and missing both render empty** in CSV. CSV has no null and any sentinel re-imports as a
  literal string; the raw `item` column keeps the distinction losslessly.
- **Formula injection is neutralised on the CSV path only.** RFC-4180 quoting does *not* protect a
  reader — Excel evaluates `=…` after unquoting — so a leading `=`/`+`/`-`/`@`/tab/CR gets an
  apostrophe. Values that are genuinely numeric are exempt, so `-5` isn't corrupted into `'-5`.
  Confined to CSV because it mutates data: never the JSON export, never the SPA.

The SPA derives from the rows on screen and the export from up to 10,000, so **the two column sets
can legitimately differ**. Sharing the code buys one spec and one test suite, not identical output.

**The CSV layout is anchored from both ends, not the left.** `id, createdAt, env, userOid,
userName, userEmail` are always the first six columns and `item, meta` always the last two; only
the derived block between them varies in width, so the raw columns land at a different absolute
index per collection. (The prefix widened from four when the captured display half landed — which
is exactly the "survives adding new platform columns" property the `item.` namespace buys, and why
the promise below is about the *anchors*, not about absolute offsets.) The CSV
is optimised to be *read* — derivation exists so the file opens to `email` and `name` rather than to
JSON, and moving the raw blob left to win a fixed index would put a cell that can hold 64 KB ahead
of the columns the owner opened it for. **Anything needing stable offsets should use
`?format=json`**, whose shape does not depend on what was collected.

### The role split is the real boundary

| Table | `helix_edge` | `helix_portal` |
| --- | --- | --- |
| `app_data` | SELECT/INSERT/UPDATE/DELETE **+ RLS partition** | full |
| `app_collection_items` | **INSERT only** (no SELECT/UPDATE/DELETE) | full |
| `gateway_calls` | SELECT, INSERT (append) | full |
| `apps`, `versions` | SELECT (projection) | full |

Migrations: `20260616000001_edge_role_grants`, `20260616231036_app_data`,
`20260616231730_app_collection_items` (under `apps/portal/prisma/migrations/`). Asserted by
`apps/edge/src/registry/role-split.integration.test.ts`. A compromised edge cannot enumerate,
update, or delete collection rows **regardless of what the app declares**.

## Design notes (why)

**The writer and the reader are different principals.** The motivating case (app-data design §1)
is the CEO's *public* contact-harvester: an anonymous visitor submits their email, and only the
owner may ever read the list back — "dump the contact list" is the headline breach. The visitor
(writer) and the owner (reader) are distinct identities. Confidentiality therefore **cannot live
in the app's code**: the frontend runs in the attacker's own browser, so any check it makes is the
attacker's to remove. Only the gateway — keyed off the *caller* identity it derived (the session
or anon resolution), never a frontend-supplied parameter — can enforce the asymmetry. A symmetric
KV (read and write as one grant) can't be configured safe; the asymmetry has to be in the
primitive. Hence three named scopes, not one, and the hard rule: **a write grant never implies a
read grant.**

**Write-only collections are a structural absence of a read verb.** §3.2's containment is not a
permission flag that could be flipped — it is the *non-existence* of the code that would read.
`AppDataStore` has no `listCollection`/`getCollection`/`deleteCollection` method, the route table
has no GET/DELETE on `/_api/data/collections/*`, and `helix_edge` has `INSERT`-only on the table.
Three independent layers, each of which alone would suffice, all say the same thing: from the app
side a collection is append-only. Junk-row spam becomes purely a rate-limit problem (`writesPerDay`
+ the anon per-IP cap), never an enumeration one — there is no verb to enumerate *with*. The owner
reads exclusively through the privileged portal path.

**The role split is the boundary that survives a process compromise.** It is two layers:

- **Coarse table/column GRANTs** (survive an edge RCE). The grant set *is* the boundary —
  deliberately **one role per service, not a per-operation `SET ROLE`**. `SET ROLE` is the
  intuitive design and it's wrong: it doesn't survive a process the attacker now controls. The
  only thing that survives compromise is a grant that *isn't there* — so `helix_edge` simply has
  no `SELECT` on `app_collection_items` and no grant at all on `app_secrets`.
- **RLS via `SET LOCAL` GUCs** (survives a SQL bug). Even with full DML on `app_data`, the edge
  sees only the partition the transaction-scoped GUCs admit; a forgotten GUC fails closed to zero
  rows, and the policy is `FORCE` so even the table owner is subject to it. Collections need no
  RLS — there is no read to scope.

**Fail-closed by construction.** Postgres defaults a new table to owner-only, and the migrations
deliberately do **not** set permissive `ALTER DEFAULT PRIVILEGES` for `helix_edge`. A new table
therefore grants the edge *nothing* until a migration explicitly says so — a forgotten grant
breaks loudly in staging rather than silently over-sharing. The target prod posture (app-data
design §2) is a **fourth** principal, `helix_migrate`, that *owns* the objects and is the only role
the migration step connects as: a table owner can `ALTER`/`DROP`/`GRANT`-self **and bypasses RLS**,
so neither runtime role (`helix_edge`, `helix_portal`) may own tables. (Both runtime roles now
connect least-privilege — the edge as `helix_edge` (`EDGE_DATABASE_URL`), the portal as
`helix_portal` (`PORTAL_DATABASE_URL`), required in production with the owner-DSN fallback refused.
The remaining target is cosmetic: `helix` still doubles as owner *and* migration role — splitting a
dedicated `helix_migrate` principal out from the owner is the documented follow-up — ADR-0002.)

## Try it

`examples/waitlist` is a public contact harvester that `POST`s to a collection; the owner drains
it via the portal export API. See [examples.md](./examples.md).

## Planned / not yet built

- **`bytesPerDay`** and **total-collection-size caps** are deferred — they need a stored byte
  column (app-data design §7). Item-size caps, `writesPerDay`, and **per-IP rate limiting** of the
  anonymous tier (`ipRateLimiter.ts`) are enforced today; a shared (DB/Redis) per-IP counter to
  beat the per-process / N×instances limit is future hardening.
- **Tighter edge grants (Phase 5)** per the design doc — further narrowing of `helix_edge`.
- Collections stay intentionally write-only from the app; no app-facing read is planned.
- **Owner-declared item schemas** stay deferred (app-data design §9). The derived columns are a
  *display convention*, not a schema: nothing is validated on write, the raw `item` column is always
  present, and dropping the derivation would lose no data. A real declared schema would supersede
  the derivation rather than conflict with it.
- **Paging the drain.** The Data tab shows the newest 200 rows and points at the export for the
  full set; the cursor (`?before=`) exists server-side and is unused by the SPA. Deliberate — the
  column set is derived from the rows loaded, so incremental paging shifts columns underfoot.
- **"Clear dev data"** (dev-mode design §7.3) is still unbuilt, and now visible: the drain shows
  dev-tier rows, so bulk-clearing them is the obvious next affordance.
