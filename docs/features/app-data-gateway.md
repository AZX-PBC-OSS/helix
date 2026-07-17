# App-data gateway

> **Related ADRs:** [ADR-0015](../adr/0015-app-data-three-scope-model.md) (three-scope app-data) · [ADR-0002](../adr/0002-postgres-role-split-rls.md) (role split + RLS) · [ADR-0014](../adr/0014-same-origin-api-gateway.md) (same-origin `/_api/*` gateway) · [ADR-0010](../adr/0010-anonymous-shared-writes.md) (anonymous shared writes) · [ADR-0021](../adr/0021-metering-ledger.md) (metering ledger) · [ADR-0023](../adr/0023-one-org-app-id-partitioning.md) (app-id partitioning).

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
PUT    /_api/data/user/:key          putUser
GET    /_api/data/user/:key          getUser
DELETE /_api/data/user/:key          deleteUser
GET    /_api/data/user               listUser
POST   /_api/data/collections/:name  postCollection   (append-only)
GET    /_api/data/shared/:key        getShared
PUT    /_api/data/shared/:key        putShared
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

Validation knobs: keys ≤ 256 chars with no control chars; values size-capped at **64 KiB** of
opaque app JSON (`MAX_VALUE_BYTES`). Writes (`user.put`, `collection.append`, `shared.put`) go
through `admitWrite` — a per-app daily `writesPerDay` budget, block-new like the LLM
`tokensPerDay` (over budget → `429` + a `quota_blocked` meter row). Every verb meters into
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
endpoint (`apps/portal/src/routes/data.ts`), running on the privileged `helix_portal` role and
bearer-gated like the usage routes:

```
GET    /api/v1/apps/:slug/collections/:name           paginate newest-first (?limit≤200, ?before=ISO)
GET    /api/v1/apps/:slug/collections/:name/export    JSON or CSV, capped at 10,000 rows
DELETE /api/v1/apps/:slug/collections/:name/items/:id GDPR-style single-item erasure → 204
```

The export surfaces truncation via an `x-helix-export-truncated` header rather than silently
capping (app-data design §7). Wire shapes: `CollectionItem` / `CollectionItemsPage` in
`packages/shared/src/data.ts`.

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
so neither runtime role (`helix_edge`, `helix_portal`) may own tables. (Today both still connect as
the `helix` owner; the per-role grants above are applied, the dedicated `helix_migrate`/runtime-role
separation is the documented target — ADR-0002. `helix_edge` is the real, tested least-privilege
role; the portal-as-owner connection and the edge's owner-DSN fallback are tracked to boot-fail on a
missing role DSN before M5.)

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
