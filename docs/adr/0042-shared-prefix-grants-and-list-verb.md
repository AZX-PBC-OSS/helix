# 0042. Prefix grants on `shared` app-data, with a list verb

**Status:** Accepted _(proposed 2026-09-02; implemented 2026-09-03 — `sharedReadPrefixes`/`sharedWritePrefixes`, `GET /_api/data/shared?prefix=…`, the elevated/low approval category, and the `forbidden`-metered deny path; the maintained detail is `docs/features/app-data-gateway.md` → "Prefix grants + the list verb")_
**Related:** ADR [0015](0015-app-data-three-scope-model.md) (the three scopes); ADR [0041](0041-app-data-write-concurrency.md) (CAS — this closes the "pattern grants" follow-up it deferred); ADR [0016](0016-capability-manifest-approval-classifier.md) (the classifier this extends); ADR [0010](0010-anonymous-shared-writes.md) (anonymous `shared` writes); `docs/design/app-data-storage.md` §3.3; `packages/shared/src/manifest.ts`, `packages/shared/src/approval.ts`, `apps/edge/src/gateway/data-handler.ts`, `apps/edge/src/gateway/data.ts`

## Context

`shared` scope cannot hold a set of records that grows at runtime.

Both shared verbs authorize against an exact-string array fixed in the manifest at deploy time — `ctx.entry.data?.sharedRead.includes(key)` (`data-handler.ts:557`) and `.sharedWrite.includes(key)` (`:599`), against `sharedRead`/`sharedWrite: z.array(z.string())` (`manifest.ts`). A key the manifest cannot enumerate at deploy time is refused with `403`. Creating a record therefore means editing the manifest and redeploying — through approvals — which is not a thing an app can do per user action.

Lining the scopes up against what a runtime-growing shared record set needs:

| scope | runtime-invented keys | shared across users | enumerable by the app | per-value cap |
|---|---|---|---|---|
| `user` | yes (blanket boolean grant) | no — per-user | yes (`listUserKeys`) | 64 KiB |
| `shared` | **no** — literal manifest keys | yes | **no** | 64 KiB |
| `collection` | yes | no — write-only | no (the absence is the security property) | 64 KiB |

The intersection is empty. This is the gap ADR-0041 named from the other side and deferred: _"unusable for runtime-invented keys today, because `sharedWrite` is an exact-string array matched with `.includes()` … Separate ADR."_ This is that ADR.

### The measurement that prompted it

The pilot app whose requirements forced ADR-0041 is the same one here — the first real user of `sharedWrite`. It keeps a set of AI-generated records, each an opaque JSON document, shared across every user of the app and growing at roughly 26 new records per month. Measured against its live database (99 records, 2026-09-02), counting exactly what the edge counts — `Buffer.byteLength(JSON.stringify(v), "utf8")`:

| | stored record |
|---|---|
| median | 42.4 KB (66% of cap) |
| p90 | 48.4 KB |
| max | **52.8 KB (83% of cap)** |
| over the 64 KiB cap | **0 / 99** |

Two conclusions, and the second is the load-bearing one:

- **The 64 KiB value cap is not the blocker.** Every live record fits, and size is flat over four months (median 42.5 KB oldest quartile → 43.6 KB newest). Headroom at the worst case is 17%, i.e. a record can grow 1.21× before it breaks — thin, but not the thing standing in the way. Raising the cap is not part of this decision; it would also make an already-filed unbounded-allocation issue worse (`TODO.md` — the collection export's worst case is `MAX_EXPORT_ROWS × 64 KB`).
- **The self-maintained index is a real ceiling, and it is an artifact of the missing verb.** Because `shared` has no list verb, the app maintains its own `shared/index` key — which is itself a 64 KiB-capped value. At a realistic index-entry shape that measures 21.1 KB at 99 records (218 B/entry), so it caps out around **299 records**; at the observed growth rate, roughly eight months out.

### Why the grant and the verb are one decision, not two

`shared` has no list verb **because the manifest already enumerates every legal shared key.** Listing is redundant when the grant is the list. Widen the grant to a prefix and that stops being true — the app can no longer know what exists. A prefix grant shipped without a list verb would force every app into exactly the self-maintained index that ADR-0041 exists to make safe, and would cap that index at 64 KiB. Shipping them together instead *removes* the index, and with it the lost-update race, for this class of app.

## Decision

### 1. Prefix grants, expressed as their own manifest fields

`DataCapabilitySchema` gains two fields alongside the existing literal arrays:

```ts
sharedReadPrefixes:  z.array(z.string().min(1)).default([]),
sharedWritePrefixes: z.array(z.string().min(1)).default([]),
```

A key is authorized if it matches a literal grant **or** `key.startsWith(p)` for some granted prefix `p`.

Separate fields rather than a sigil inside the existing arrays (`"record:*"`). Three reasons: `*` is a legal character in a key today, so a sigil silently reinterprets any existing key containing one; a separate field needs no escaping rule; and it hands decision 4 its distinct classifier path for free. The field *is* the category.

Prefixes are validated like keys — non-empty, ≤ 256 bytes, no control characters. `min(1)` is load-bearing: an empty prefix would grant the whole scope.

### 2. Prefix only. No pattern language

`startsWith`, nothing else. No globs, no regex, no interior wildcards, no suffix matching. Natural-key layouts (`record:<id>`) are prefix-shaped by construction, which is the case in front of us; a pattern language is unbounded review surface (a reviewer must decide what `record:*-*:v?` covers) bought for a need nobody has demonstrated. Revisit only against a real app that a prefix cannot express.

### 3. A list verb on `shared`, returning keys and versions, never values

`GET /_api/data/shared?prefix=<p>` → `{ keys: [{ key, version, updatedAt }], nextCursor? }`.

- **The prefix is required, and must be covered by a `sharedReadPrefixes` grant.** Listing never reveals keys outside the caller's grants, and there is no way to ask for "everything". A literal `sharedRead` grant does not confer listing — literal grants already tell you what exists.
- **Keys, not values** — mirroring `listUserKeys`. This is a size decision as much as a shape one: 300 records at the measured median would be a 12 MB response. The app lists, then fetches what it needs.
- **Keyset-paginated on `key`, with a page cap**, so the response is bounded independently of how many keys match. Learning from `TODO.md`'s collection-drain cursor entry: the cursor is composite-safe from the start, because `key` is unique within `(appId, env, userOid IS NULL)`.

`version` rides along so a caller can list and then CAS without a second round trip per key.

### 4. Prefix grants are their own approval category: separate delta path, elevated, risk `low`

Literal shared-key grants are classified today as baseline and `low` — `approval.ts` pushes each added item with `isElevated: false`, meaning they apply without admin approval. Prefix grants get:

- **their own delta paths** — `data.sharedWritePrefixes[+record:]`, distinct from `data.sharedWrite[+record:abc]`, so a reviewer never has to notice that one array element means "one key" and another means "unboundedly many";
- **`elevated: true`** — a human sees the grant once, because a prefix is unbounded in the number of keys it covers and the app author decides at runtime what lands inside it;
- **`risk: "low"`** — the same category as the literal grant, because it is not meaningfully more dangerous: `shared` is app-scoped and world-readable *within the app* by definition, and both forms are bounded by the same visibility gate. Low risk sorts it appropriately in the review queue rather than ranking it above work that matters more.

The literal arrays keep their current baseline treatment, unchanged.

### 5. Enumeration is the widening, and it is bounded by the prefix

The honest cost: today an app user can read any shared key **whose name they can guess**; with a list verb they can read any shared key **whose prefix the app was granted**. That is guessing-vs-enumeration, not private-vs-public — `shared` is documented as "any visitor reads everything" (design §3.3), and a grant of read has always meant every user of the app.

It is nonetheless a real change, which is what decision 4's elevated tier is for. Two properties keep it contained: listing requires a read-prefix grant, so an app with only literal grants gains nothing; and the prefix bounds the blast radius to the namespace the owner approved, rather than the whole scope.

### 6. No new database privilege

`listShared` is a `SELECT key, version, "updatedAt" FROM app_data WHERE "appId" = $1 AND env = $2 AND "userOid" IS NULL AND key LIKE $3` (prefix as an escaped `LIKE` pattern, or `starts_with`). `helix_edge` already holds `SELECT` on `app_data` — it is how `getShared` works — so this adds no grant and does not move the role split. Recorded explicitly because "requires no privilege change" is a property worth being able to check later without re-deriving it.

### 7. Telemetry ships with it

The list verb is a new route and the prefix check is a new decision point that can deny a request, so per the standing expectation both are instrumented in the same change: a `ROUTE_*`/`SPAN_*` constant in `packages/shared/src/telemetry.ts`, the span from the edge's `spanRoute` helper, a counter dimensioned on `appId` (never `userOid`), and the deny path distinguishable from the empty-result path. The span records `url.path` and the match count — never the prefix's matched keys.

> **Amendment (2026-09-03, review finding 1):** the span records **`http.route` and the match count, not `url.path`**. Four of the data routes carry an app-chosen *key* as the path's last segment, and this ADR's own prefixes exist so those keys are invented at runtime — a `url.path` attribute there is unbounded, attacker-choosable app data written into a retained telemetry backend (it fires even on a 404, so an unauthenticated prober chooses the strings). `http.route` + `helix.data.verb` identify the route without it; `spanRedaction.test.ts`'s planted-key case holds the line.

## Consequences

- **The pilot app's shape becomes natural.** Records become `record:<id>` under a `record:` prefix grant; creation is `If-None-Match: *` on the natural key, which is the cross-record dedup ADR-0041 identified as "a genuinely good fit" but could not enable; the app's index view is a list call. The self-maintained `shared/index` is deleted outright, and with it the lost-update race, the 299-record ceiling, and the record-plus-index multi-key write.
- **ADR-0041's mandatory CAS stops being a tax on the common path.** Its motivating example was the read-modify-write of a self-maintained index. Remove the index and the remaining shared writes are single-record, where `If-Match` is a cheap assertion rather than a retry loop.
- **The 64 KiB cap stays, and stays the next thing to watch.** The measured worst case is 52.8 KB. Two independent mitigations exist before the cap has to move: bring the largest field back within its intended budget (one prose field measured at ~3× its stated length and 26.8% of every record — worth ~7 KB of median size), and, if that is not enough, split a record across `record:<id>:core` and `:detail`, which prefix grants make expressible.
- **Splitting reintroduces a torn-write window, and the ordering rule is the mitigation.** Write the piece that stands alone first. Where an app already generates a record in two phases — a core document, then an enrichment pass that fills in a nullable section — the residue is not a corruption mode but a state the app already creates deliberately and already renders. Apps without that property should keep one record per key.
- **A `shared` DELETE is now more obviously wanted, and is still blocked.** `AppData.version` carries an explicit warning that the counter is per row, so delete-and-recreate restarts at 1 and a stale `If-Match: "1"` can match a value it never read (ABA) — "acceptable while DELETE is user-scope-only; revisit … before any shared delete verb lands." Prefix grants make a growing shared namespace, which makes reclaiming keys a real need. That is the next ADR in this line, and it needs a row-birth nonce folded into the ETag.
- **A write-prefix grant is unbounded row creation, so it is born bounded (review finding 3).** Before prefixes, the literal `sharedWrite` array capped the set of rows an app could ever hold — a flood could overwrite N keys, never mint new ones. `sharedWritePrefixes` + `If-None-Match: *` creates a row per call, nothing can delete them yet (previous consequence), and an unset `writesPerDay` is unlimited — so the schema **requires `writesPerDay` alongside `sharedWritePrefixes`**, making the grant and its bound one approval decision. Read prefixes are exempt (they cannot create rows; listing is page-capped). A per-app shared-row cap on the create path is the stronger deferred version (`TODO.md`).
- **Listing is a read primitive with no read budget.** `writesPerDay`/`bytesPerDay` bound writes; the anonymous per-IP limiter covers public apps without a session. A signed-in caller polling the list verb is bounded only by the page cap. Same shape as the authenticated-412-flood item already on the list; not made materially worse here, but now has a second call site.

### Amendments

- **(2026-09-03, review finding 1)** — decision 7's span records `http.route` + the match count, not `url.path`; see the note on decision 7.
- **(2026-09-03, review finding 3)** — `DataCapabilitySchema` requires `writesPerDay` when `sharedWritePrefixes` is non-empty; see the consequence above.
- **(2026-09-03, ADR-0043)** — decision 1's prefix validation ("validated like keys — non-empty, ≤ 256 bytes, no control characters") is superseded: keys, prefixes, collection names, and literal grants are **printable ASCII** (`0x20`–`0x7E`, 1–256 chars, no edge spaces), one shared rule in `isValidDataKey`. The blocklist passed Cf format characters (bidi controls, zero-width spaces) — i.e. it passed exactly the strings that can make an approval diff lie. See [ADR-0043](0043-app-data-identifiers-printable-ascii.md).
- **(2026-09-03, review findings 2 and 5)** — two latent approval-loop bugs this ADR's first real elevated data grant surfaced, both fixed with regression tests: `snapshotConflicts` compared key-order-sensitive `JSON.stringify` across a jsonb-reordered stored snapshot vs a zod-ordered re-derivation (every data-area approve auto-bounced), and its order-normalizing successor still compared key *sets*, so requests filed before a schema field exists bounced after the deploy that added it — the stored side is now normalized through the schema. Separately, `applyDeltas`' greedy array-path regex let a prefix containing `[-` hijack the parse so its *removal* silently no-op'd; the field is now anchored against the closed field-name set, and an unrecognized array field throws instead of no-oping.

### Explicit non-goals

- **A pattern language** (decision 2).
- **Multi-key atomicity / a batch write verb.** N keys landing all-or-nothing needs a new request shape, a cap on the batch rather than the value, and `writesPerDay` semantics for a compound write. Ordering guidance (write the standalone piece first, repair idempotently) remains the answer, as it was in ADR-0041.
- **Raising `MAX_VALUE_BYTES`.** Not required by the measurements, and it worsens the filed collection-export allocation issue. If it is ever revisited, that item becomes a precondition rather than a follow-up.
- **A `shared` DELETE verb** — see the consequence above; blocked on the ABA problem, not on this decision.
- **Conditional reads (`304`).** ADR-0041 scoped the `ETag` to a concurrency token; `list` returning `version` does not change that.
- **Listing `collection` scope.** Its unreadability is the security property (ADR-0015) and nothing here touches it.
