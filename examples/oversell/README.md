# oversell

A **public** AZX app (no login) that demonstrates **ADR-0041: compare-and-swap
app-data writes** — preconditions mandatory on `shared` — and **ADR-0042:
prefix grants + the list verb** on `shared` app-data. The failure ADR-0041
makes visible is the classic lost update: two tabs read "1 widget left", both
buy, and last-write-wins sells the same widget twice. Here every purchase is
read → `ETag` → modify → `If-Match`, and the loser gets a loud `412`, re-reads,
and sees an empty shelf.

```
tab A  GET stock → 200 etag "1" {count: 1}
tab B  GET stock → 200 etag "1" {count: 1}
tab A  PUT stock (if-match: "1") {count: 0} → 200 etag "2"   ✓ wins
tab B  PUT stock (if-match: "1") {count: 0} → 412 conflict   ✗ told, not clobbered
       └─ error.details.currentVersion: "2"  (in-band recovery)
```

The ADR-0042 half is the **waitlist**: a set of shared records that grows at
runtime, which literal key grants cannot express (creating a record would mean
editing the manifest and redeploying). Each join writes `record:<id>` under a
`record:` **prefix grant**, created with `If-None-Match: *` on the natural key
— create-if-absent is cross-record dedup for free — and the index view is one
`GET /_api/data/shared?prefix=record:` call. No self-maintained `record-index`
key: that index is a 64 KiB-capped value with a lost-update race on every
record creation, and the list verb deletes the need for it.

## What it demonstrates

- **The canonical write loop** (`updateShared`, copied from the deploy skill):
  read → modify → `If-Match` → bounded retry on `412`. Every write the app
  makes goes through it — a precondition-less shared PUT is refused.
- **The ETag made visible.** The shelf shows the version chip alongside the
  count, and the exchange log prints every request/response with its headers.
- **Deterministic probes** — one click each, no second tab or lucky timing:
  - *Lose a race on purpose*: write, then re-write with the stale precondition
    → `412 conflict`, and the response's disclosed `currentVersion` → one retry
    lands `200`.
  - *Write with no precondition* → `428 precondition_required` (the error names
    the fix).
  - *Claim the same key twice*: `If-None-Match: *` is create-if-absent — the
    second claim `412`s with the winner's version.
  - *The `If-Match: *` escape hatch* → `428` (it asserts nothing, so it is
    refused like no header).
- **Prefix grants & the list verb (ADR-0042)**, one click each:
  - *Update a record with no read*: the list carries each key's `version`, so
    list → `If-Match` the listed version needs no per-key GET.
  - *List a prefix you were never granted* → `403` — enumeration is bounded by
    the grant, and the deny is recorded in the audit ledger (`forbidden`).
  - *List with no prefix at all* → `400` — there is no list-everything form.
  - *Read a key outside the grant* → `403` — `startsWith` is exact; `record:`
    grants a namespace, not a fuzzy match.
- **The two-tab story**: restock to 1, buy in two tabs — one wins, the other
  retries into "sold out" instead of overselling.
- **The ledger half** (portal-side, not in-app): each `412` records a
  `conflict` row in the app's Usage tab and never counts against
  `writesPerDay` — contention is visible without becoming a quota outage.

## Grant the data capability

After `helix create --visibility public`, set the manifest (use the portal API,
like `waitlist`). The prefix arrays are the ADR-0042 half — note they are
**approval-gated** (one prefix element covers unboundedly many keys), so the
first save opens an admin request:

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/oversell/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{"data":{
        "sharedRead":["stock","scratch"],
        "sharedWrite":["stock","scratch"],
        "sharedReadPrefixes":["record:"],
        "sharedWritePrefixes":["record:"],
        "writesPerDay":10000
      }}}'
```

`stock` is the shelf; `scratch` is the probes' sandbox. Both are world-readable
*and* world-writable by design — it's a demo of the concurrency contract, not
of confidentiality (that's `waitlist`'s job). `record:` is the waitlist's
namespace: the app invents the ids at runtime, which is exactly what a prefix
grant is for.

## Build & deploy

```bash
cd examples/oversell
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
helix create --display-name "Last Widget Co." --visibility public
# grant the data capability (see above)
helix deploy --promote
```

Then open `https://oversell.local.helix.azxlabs.io:8080` — no sign-in. Restock,
buy, and press the probes; watch the exchange log narrate every `200`, `412`,
and `428`.
