# oversell

A **public** AZX app (no login) that demonstrates **ADR-0041: compare-and-swap
app-data writes** — preconditions mandatory on `shared`. The failure it makes
visible is the classic lost update: two tabs read "1 widget left", both buy,
and last-write-wins sells the same widget twice. Here every purchase is
read → `ETag` → modify → `If-Match`, and the loser gets a loud `412`, re-reads,
and sees an empty shelf.

```
tab A  GET stock → 200 etag "1" {count: 1}
tab B  GET stock → 200 etag "1" {count: 1}
tab A  PUT stock (if-match: "1") {count: 0} → 200 etag "2"   ✓ wins
tab B  PUT stock (if-match: "1") {count: 0} → 412 conflict   ✗ told, not clobbered
       └─ error.details.currentVersion: "2"  (in-band recovery)
```

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
- **The two-tab story**: restock to 1, buy in two tabs — one wins, the other
  retries into "sold out" instead of overselling.
- **The ledger half** (portal-side, not in-app): each `412` records a
  `conflict` row in the app's Usage tab and never counts against
  `writesPerDay` — contention is visible without becoming a quota outage.

## Grant the data capability

After `helix create --visibility public`, set the manifest (use the portal API,
like `waitlist`):

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/oversell/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{"data":{
        "sharedRead":["stock","scratch"],
        "sharedWrite":["stock","scratch"],
        "writesPerDay":10000
      }}}'
```

`stock` is the shelf; `scratch` is the probes' sandbox. Both are world-readable
*and* world-writable by design — it's a demo of the concurrency contract, not
of confidentiality (that's `waitlist`'s job).

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
