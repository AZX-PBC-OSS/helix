# Principal re-base cutover (ADR-0048)

Per-install operator procedure for the switch of the platform's canonical
principal identifier onto Entra's `oid` claim: deploy the code, let sessions
drain, rewrite each owner's `apps.ownerId` to their directory oid, revoke the
dev tokens, verify. The mechanism is a **straight cutover** — selected by the
prod inventory in [ADR-0048](../adr/0048-canonical-principal-oid.md)'s
amendment (zero user-scoped `app_data` rows on either install), so there is no
backfill machinery, no dual-read window, and no lazy migration anywhere in
these steps.

Run this **once per install** after deploying a build that contains the
ADR-0048 change (edge + portal ship together).

## What the deploy already did for you

- The edge reads `claims.oid` at login and refuses a token without it; the
  portal verifier rejects an access token without it. New logins and new
  `POST /api/v1/apps` writes are already in oid space.
- Migration `20260922100000_owner_email_transitional_backfill` captured
  `ownerEmail` from any still-email-shaped `ownerId` where the display column
  was null (the reference install's three pre-column rows), so no owner goes
  unnamed when the id becomes opaque.
- Sessions minted before the deploy still authenticate; they carry the old
  pairwise-sub `userOid`, which nothing compares — they age out naturally.

## Preconditions

- **An Entra issuer, or the principal-claim seam set on both planes.** The
  canonical principal id is read from one claim: `oid` by default, which Entra
  emits unconditionally. On a non-Entra issuer (Keycloak, Okta, dex, Google)
  set `EDGE_OIDC_PRINCIPAL_CLAIM` and `PORTAL_OIDC_PRINCIPAL_CLAIM` to the
  issuer's stable id claim — usually `sub`, gated behind the explicit
  `*_ALLOW_SUB_PRINCIPAL` flags (ADR-0048, as amended) — **to the same value
  on both services**. The email→oid pairs below then resolve against whatever
  that claim carries.
- **The email→oid pairs for every distinct `ownerId`** on the install. For the
  two live installs these are already resolved and recorded in the ops repo
  (the ADR amendment, finding 1). For any other install, collect them by
  having each owner run `helix whoami` (or hit `GET /api/v1/me`) **after** the
  deploy — the oid is echoed — or resolve them as operator-collected pairs.
- Confirm the inventory still reads ~zero if in doubt: the four read-only
  queries are in the ADR's pre-implementation section, and a nonzero surprise
  is itself the finding — stop and report, don't act on it.

## Steps

### 1. Deploy

Deploy the build containing the change (edge + portal + egress as usual —
egress is unchanged but ships together). Owners who log in before step 3 will
403 on their own apps; that is the fail-closed posture working, and step 3
clears it.

### 2. Let sessions drain

Sessions carry an 8 h TTL and the sweeper clears rows one day past expiry, so
within ~32 h of the deploy no live session holds an old-space `userOid`. On a
quiet install you can shorten this to zero with the admin Sessions screen (or
`DELETE FROM sessions;` as the portal role) — every user simply logs in again;
pre-pilot that is a handful of people.

### 3. Re-base `apps.ownerId` — one UPDATE per pair

As the portal's database role (the exec pattern below), for each
email→oid pair:

```sql
UPDATE apps SET "ownerId" = '<oid>' WHERE "ownerId" = '<email>';
```

Safe to re-run; idempotent once applied (the email matches zero rows). Apps
created **after** the deploy already store the oid and are untouched. An
unmapped owner fails closed and visibly — 403 on `ownsApp`, an empty
`scope=mine` — which is the checklist finding its own gaps.

### 4. Revoke the dev tokens

Pre-cutover `app_dev_token` rows carry an old-space `developerOid` (attribution
only — nothing compares it — but the honest state is a fresh mint):

```sql
UPDATE app_dev_token SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
```

Tell the developers: re-mint from the portal's Dev Mode tab. This is the only
user-visible disruption in the whole change (7 tokens across the two live
installs at inventory time).

### 5. Verify each owner's next login

For every owner on the checklist: sign in, confirm the app appears under
**Mine** and a mutating action (e.g. a settings save) succeeds. `helix whoami`
should print the oid that now sits in `ownerId`.

## Running SQL against a deployed install

The database is private-network only; there is no psql hop. Use the
established `az containerapp exec` pattern from `infra/azure/README.md`
(§"step 5" area) with the corrections ADR-0048's amendment records at its end:
the exec API splits `--command` on whitespace, the command rides a ~2 KB
websocket URL, and the endpoint throttles at roughly five calls per ten
minutes. What works: base64 the JS and run it as
`node -e eval(Buffer.from('…','base64').toString())`, one statement per call,
serialized with a pause between; `pg` is reachable only via its
`/app/node_modules/.pnpm/pg@*/node_modules/pg` path. The working runner lives
in the ops repo — use it rather than re-deriving the incantation.

## Local dev databases

A local dev database created before this change has `apps.ownerId` rows in
email space: after pulling the change, `ownsApp` fails closed for them until
they are re-created (or `db:reset`). Cheapest path:

```bash
pnpm --filter @azx-pbc/portal db:reset
```

Re-created apps store `findFixtureUser("<email>").oid` from the first `POST
/api/v1/apps` — e.g. alice's `6b9f4d31-8e2a-4c07-9b5d-111111111111` — which is
exactly the value the edge session now carries for the same login.

## What deliberately does NOT happen

- No `app_data` backfill of any kind: the inventory read zero rows on both
  installs, and a fresh install has none to strand.
- No edit to `gateway_calls` or `app_collection_items` history: the ledger
  keeps what was true at write time (`COUNT(DISTINCT "userOid")` rollups may
  double-count a user across the cutover — cosmetic, once).
- No registry-projection change: the edge still sees no owner field
  (ADR-0048 decision 4 — the `private` mode remains decoupled).
