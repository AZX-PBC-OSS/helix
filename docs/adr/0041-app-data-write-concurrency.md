# 0041. App-data write concurrency: compare-and-swap on an opaque version, mandatory on `shared`

**Status:** Accepted _(recorded 2026-08-24)_
**Related:** `docs/design/app-data-storage.md` (§3.3, §9 — this closes the deferred question); ADR [0015](0015-app-data-three-scope-model.md) (the three scopes this governs); ADR [0010](0010-anonymous-shared-writes.md) (anonymous `shared` writes); `apps/edge/src/gateway/data.ts`, `data-handler.ts`; `apps/portal/src/policy/policyWrite.ts` (the same pattern, control plane)

## Context

App-data writes are unconditional upserts. `putShared` and `putUserKey` (`apps/edge/src/gateway/data.ts:157,98`) both `INSERT … ON CONFLICT DO UPDATE`, so the last writer wins and the loser is told `200`. Nothing detects the collision and nothing records it.

The design doc named this and deferred it (§9): _"Shared-write conflict semantics (last-write-wins vs optimistic concurrency on `updatedAt`) — only matters once `sharedWrite` has a real user; default LWW."_ `sharedWrite` now has a real user, and the deferral's condition is met.

The concrete failure is a lost update on a read-modify-write of a shared key — an index or manifest the app maintains itself, because `shared` has no list verb and so the set of things that exist has to live at some key:

```
t0   Tab A:  GET  index  → ["alpha", "beta"]
t1   Tab B:  GET  index  → ["alpha", "beta"]
t2   Tab A:  PUT  index  = ["alpha", "beta", "gamma"]
t3   Tab B:  PUT  index  = ["alpha", "beta", "delta"]
```

`gamma` is gone. Its own record still sits at its own key, but nothing lists it, so it is invisible to the app — an orphan, discovered weeks later when someone regenerates it and pays for the LLM work twice.

Two things make this worth fixing rather than filing under "unlikely race":

- **The window is not milliseconds.** It is however long the client holds the pre-image, which in a SPA is a query-cache lifetime — potentially the life of the tab. Apps whose writes land at the end of a long generation straddle that whole generation by construction.
- **It is silent.** Both writers get `200`. There is no error, no log line, and no way for the app to know it happened.

The control plane already answered the same question for itself. `casPolicyWrite` (`apps/portal/src/policy/policyWrite.ts:22`) CASes on an integer `apps.policyVersion` and raises `conflict` for the loser, for exactly the reason given in its docstring: read-modify-write of a whole blob makes concurrent writers last-write-wins, and "the loser is told 200 for a value that is not what is stored." This ADR is that pattern applied to the data plane, with one difference — on the data plane the writers are *different, mutually unaware principals*, which is what forces the mandatory half below.

## Decision

App-data gains optimistic concurrency control via HTTP preconditions. Seven decisions:

### 1. The token is an opaque monotonic `version`, not `updatedAt`

`app_data` gains `version BIGINT NOT NULL DEFAULT 1`; every write sets `version = version + 1`. The `ETag` is that number. `updatedAt` stays exactly as it is, for display.

Reusing `updatedAt` is the obvious move and it does not work. Postgres `now()` is microsecond-precision; node-postgres parses `timestamptz` into a JS `Date`, which is millisecond-precision; `data.ts:116` then calls `.toISOString()`. The token handed to the client is therefore already truncated, and `WHERE "updatedAt" = $n` would fail against nearly every stored row — a CAS that rejects every write. (There are no `setTypeParser` overrides anywhere in the repo; this is the default path.) Independently, a timestamp is a value rather than a counter, so it cannot distinguish two writes that land at the same instant, while a counter is immune by construction.

`BIGINT` comes back from node-postgres as a **string**, which is what an opaque ETag should be anyway — there is no `Number` precision question and no formatting step where the token can lose fidelity. That is the specific bug class that disqualified the timestamp, and the type choice closes it rather than re-opening it.

### 2. Reads emit the token

`GET /_api/data/{user,shared}/:key` gains an `ETag: "<version>"` header. Today they return `{ key, value }` and nothing else (`data-handler.ts:265,389`), so a reader has no way to learn what it would be CASing against. This is a prerequisite, not a nicety.

The `ETag` here is purely a concurrency token. Reads keep `cache-control: no-store`; conditional **reads** (`304`) are not in scope and are not implied.

### 3. Three statements, not one clever upsert

The tempting single-statement form — `INSERT … ON CONFLICT DO UPDATE … WHERE version = $n` — is wrong. When no row exists the `INSERT` succeeds and returns `200`, even though the client asserted "the current value is version N" and there was no current value. That is the precise failure the feature exists to catch, passing silently. Each precondition gets its own statement:

| Request | Statement | Zero rows means |
|---|---|---|
| `If-Match: "n"` | `UPDATE … WHERE …key = $k AND version = $n RETURNING version` | `412` |
| `If-None-Match: *` | `INSERT … ON CONFLICT DO NOTHING RETURNING version` | `412` |
| no precondition | today's upsert (`user` scope only — see 4) | n/a |

`If-None-Match: *` is create-if-absent, and is how an app claims a key it believes is unwritten.

### 4. Preconditions are **mandatory** on `shared`, optional on `user`

A `PUT /_api/data/shared/:key` carrying neither `If-Match` nor `If-None-Match` is refused (`428`, below). On `user` scope an unconditional `PUT` keeps today's last-write-wins behaviour.

The mechanism is identical in both scopes; only the default differs, and the asymmetry tracks the actual failure:

- A `user`-scope collision is one person with two tabs. Rare, low-stakes, and the loser is the same human, who notices and redoes it.
- A `shared`-scope collision is between **different principals** — that is the definition of the scope — and the loser never finds out.

Optional-everywhere was rejected on the design doc's own §1 reasoning, one level up. That section rejects symmetric KV because "a storage primitive that conflates [writer and reader] cannot be made safe by configuration — the asymmetry has to be in the primitive itself." A store that is only safe when the app remembers a header is the same bargain in a different coat. `TODO.md` carries the empirical case: the control plane's stale-form write path chose optional-for-compat and the hole is still open months later. Optional means never adopted.

A per-key manifest opt-in (`casRequired: [...]`) was considered and rejected outright: it puts the most technical question in front of the least-equipped principal at the moment they understand the app least.

The failure timing is what makes mandatory affordable. A missing precondition fails on the app's very first shared write — in dev, on the author's own machine, with an error naming the fix. Last-write-wins fails silently, in production, weeks later, as data loss.

### 5. `If-Match: *` is refused on `shared`

`If-Match: *` means "any current representation," which satisfies "a precondition is present" while being semantically identical to last-write-wins. Left open, it is a one-character escape hatch that an agent flailing at a `428` will find immediately, and decision 4 becomes theatre. On `shared`, the only accepted preconditions are a concrete version or `If-None-Match: *`.

### 6. `412` for a failed precondition, `428` for a missing one, and one new error code

- **`412 Precondition Failed` + `conflict`** — you lost a race. Matches `casPolicyWrite`, which already raises `conflict`. The app re-reads, re-applies its change, retries.
- **`428 Precondition Required` + `precondition_required`** (new member of `API_ERROR_CODES`, `packages/shared/src/api.ts`) — you did not state an assumption. The app's code is wrong.

Collapsing both onto one code was rejected on the file's own precedent: `rate_limited` and `quota_exceeded` are both `429` and are deliberately kept distinct "so the app can tell per-IP throttling apart from running out of its own budget" (`api.ts:134`). Distinct conditions get distinct codes. Here the two demand opposite responses — retry the write versus fix the source — so collapsing them would be worse than the case that precedent already rejects.

### 7. The loser is not charged — but contention is visible

_(Amended 2026-08-25 on dual-review finding 4, before this shipped.)_

A `412` or `428` does not count against `writesPerDay`. The write did not happen, and a contended retry loop must not consume the app's daily budget — that would turn contention into a self-inflicted quota outage.

The original wording recorded **no** `gateway_calls` row for either failure. That made a failed precondition invisible, and the paragraph below's safety argument was wrong on inspection: the per-IP limiter covers only *anonymous* callers on public apps (and the dev gateway passes no limiter at all), so a signed-in user — or a buggy app looping a stale `If-Match` — could hammer a shared key at unbounded rate, each attempt taking a connection, a transaction, and row-lock contention, with zero quota consumed and nothing in the ledger. The amended position keeps the not-charged property and restores visibility: a `412` records a `gateway_calls` row with the distinct non-charging outcome `conflict` (`dataWritesToday` counts `outcome = 'ok'` only, so the budget is structurally untouched), while a `428` still records nothing — it never reaches the store, and it fires in dev on the app's first write, where the fix is.

No new abuse control is needed for the anonymous tier: its per-IP limiter already runs inside `preamble` (`data-handler.ts:123`), before any store work, so an anonymous `412` spin loop is bounded before it reaches the `UPDATE`. Bounding an *authenticated* conflict flood (rather than merely seeing it in the ledger) is deferred — extending the per-IP limiter to authenticated shared writes is tracked in `TODO.md`.

## Consequences

- **This is a breaking change to `shared` writes, and it is taken now deliberately.** Every existing `PUT /_api/data/shared/:key` without a precondition begins failing. No real app uses app-data yet, so the cost is zero today and rises monotonically from here; taking the break at the moment the cost is zero is the whole argument for doing it now rather than shipping optional and regretting it.
- **`packages/deploy-skill/SKILL.md` is where mandatory succeeds or fails.** §3.2 currently documents `PUT /_api/data/shared/:key` as a plain write with no hint that a concurrent writer exists, so an agent following it has no way to know. The read → modify → `If-Match` → retry-on-`412` loop has to be in the skill as a copyable pattern, with a bounded retry count, plus a line in the §3.2 checklist. Agents reliably follow an explicit rule and reliably miss a hazard nobody named; this is the whole delivery mechanism for the decision.
- **Dev-mode inherits it for free.** `makeDataHandlers` is built by both the edge (`app.ts:239`) and the dev gateway (`devGateway/app.ts:123`), so the handler change lands in both surfaces with no parallel implementation and no drift between them.
- **`FakeAppDataStore` must mirror the real CAS semantics** (`apps/edge/src/test/fakes.ts:229`). It backs the handler tests, so a fake that ignores preconditions makes every one of those tests assert a behaviour production does not have. Per project plan §6, the adversarial tests land with the change: concurrent writers where exactly one wins, `If-Match` against an absent key, `If-Match: *` refused on `shared`, and a `412` that is ledger-visible but never charged (decision 7, as amended).
- **The migration is additive** — one column with a default on a portal-owned table. `helix_edge` already holds `UPDATE` on `app_data` within its RLS partition (migration `20260616231036_app_data`), so no grant changes and no RLS policy changes are required.
- **Contention is now visible.** A `shared` key under real contention produces a stream of `412`s where previously it produced silent data loss. That is the point, but it does mean an app with a hot shared key will surface a failure mode it did not appear to have before. The failure was always there; only the reporting is new.

### Explicit non-goals

Each of these was raised, is real, and is **not** solved here. Recording them is what stops a later reader assuming CAS covered them.

- **Durable claims / mutual exclusion.** CAS can express "exactly one worker starts this job," but a claim is only sound if the winner finishes. A browser tab that wins a claim and is closed mid-work leaves the record claimed forever, and the static model has no server-side sweeper to recover it — so the claim is taken correctly and still leaks, permanently. **Do not build a job claim on this primitive.** That need is the scheduled/background-work gap at `docs/design/custom-backends.md` rung 0, and it is a separate effort.
- **Multi-key atomicity.** Writing a record and updating an index are two gateway calls with no transaction spanning them; a crash between leaves one without the other. CAS does not change that. The available mitigation is ordering plus repair — write the record first, so the residue is an intact-but-unlisted record rather than a pointer to nothing, and make the repair pass idempotent. A real transaction boundary across gateway calls is a much larger ask.
- **Cross-record uniqueness, and pattern grants.** A single-key predicate cannot express "no other key holds this normalized name." The natural workaround is to make the key *be* the natural key, so uniqueness becomes key collision and creation becomes `If-None-Match: *` — which this ADR ships. It is unusable for runtime-invented keys today, because `sharedWrite` is an exact-string array matched with `.includes()` (`packages/shared/src/manifest.ts:48`, `data-handler.ts:411`), so keys the manifest cannot enumerate at deploy time are refused. Widening that to prefix or pattern grants is a question about **how much an app may write**, not about how writers coordinate: it needs a threat model and an approvals-risk story in `classifyChange`. Separate ADR.
- **A server-side append verb.** For the append-to-a-list shape specifically, a JSONB append performed in one statement would make the lost update structurally impossible rather than merely detectable, and would require the app author to understand nothing at all. It is the better fix for that one shape and a worse fix for the general problem — it does not help counters, settings blobs, or claims, and it pulls app semantics (dedup, ordering, caps) into the platform. CAS first, because it is the general primitive and is needed regardless; revisit if the retry loop proves too much for real apps.
- **ADR-0010 is unaffected.** Mandatory preconditions make accidental clobbering of a shared key visible; they do nothing about a hostile anonymous writer who reads and then writes correctly. Whether `sharedWrite` should require authentication remains open exactly as ADR-0010 left it.
