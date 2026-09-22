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

- The edge reads the configured principal claim (`oid` by default) at login
  and refuses a token without a usable value; the portal verifier rejects an
  access token without one. New logins and new `POST /api/v1/apps` writes are
  already in oid space.
- Migration `20260922100000_owner_email_transitional_backfill` captured
  `ownerEmail` from any still-email-shaped `ownerId` where the display column
  was null (the reference install's three pre-column rows), so no owner goes
  unnamed when the id becomes opaque.
- Sessions minted before the deploy still authenticate, and they carry the
  old pairwise-sub `userOid` — which nothing *compares*, but which **is the
  `app.user_oid` RLS partition key** for user-scoped `app_data` (and the
  dev-tier partition key for `app_dev_token.developerOid`). A pre-deploy
  session therefore keeps **writing** user-scoped rows under the old id for
  up to its remaining TTL, and after that user's next login those rows are
  present-but-unreachable — silently, per user, with no sweep to recover
  them. This is why step 2 (drain) is load-bearing whenever the inventory
  shows user-scoped rows, not cosmetic housekeeping. On the two reference
  installs the inventory read zero, so there is nothing to strand; that zero
  is a property of *these installs at this moment*, not of the design.

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
- Confirm the inventory before you start: the four read-only queries are in
  the ADR's pre-implementation section, and a nonzero surprise is itself the
  finding — stop and report, don't act on it. In particular, **a nonzero
  user-scoped `app_data` count changes step 2 from optional to mandatory**:
  those rows are partition-keyed by the old id, and every user-scoped row
  written between the deploy and the last pre-deploy session's expiry strands
  (see the third bullet above). Quiesce user-scoped writes (or schedule the
  cutover in a write-free window) before the deploy if the count is nonzero,
  and re-read ADR-0048 decision 6 — at that point the straight-cutover
  conclusion no longer carries the decision by itself.

## Steps

### 1. Deploy — migrate job first, then the app revision

Migrations do not run on app boot: they land via the `<namePrefix>-migrate`
Container Apps Job (infra/azure/README.md, §"Every migration"). **Run the
migrate job before activating the new app revision** — the order is safe in
that direction only: the new columns are additive, so old code + new schema
is fine, but new code + old schema breaks the approvals surface (the new
portal selects `requestedOid` on every approval query). The job applies both
new migrations — the `ownerEmail` transitional backfill and the
`approval_requests.requestedOid` column.

```bash
az containerapp job update -g <rg> -n <namePrefix>-migrate --image <registry>/helix-portal:<tag>
az containerapp job start  -g <rg> -n <namePrefix>-migrate
az containerapp job execution list -g <rg> -n <namePrefix>-migrate \
  --query "[0].{name:name,status:properties.status,start:properties.startTime}"
```

Then deploy the new revision (edge + portal + egress as usual — egress is
unchanged but ships together). Owners who log in before step 3 will 403 on
their own apps; that is the fail-closed posture working, and step 3 clears it.

### 2. Let sessions drain — optional on a zero-row install

Sessions carry an 8 h TTL and the sweeper clears rows one day past expiry, so
within ~32 h of the deploy no live session holds an old-space `userOid` — and
no pre-deploy session can write another old-space `app_data` row. On a quiet
install you can shorten this to zero with the admin Sessions screen (or
`DELETE FROM sessions;` as the portal role) — every user simply logs in again;
pre-pilot that is a handful of people. **If the preflight inventory showed any
user-scoped `app_data` rows, this step is not optional** — see the preflight
note above.

Scope note: these are **app-user** sessions (the edge's). The portal itself
has no sessions to clear — it is stateless bearer tokens, and a CLI/SPA token
keeps working across the whole cutover because Entra access tokens have
carried `oid` all along; the new verifier simply started reading it. Clearing
sessions buys tidiness (everyone onto oid-space rows promptly, no old-space
metering attribution); skipping it costs nothing on an install with zero
user-scoped rows. This step is independent of step 3 — order doesn't matter.

### 3. Re-base the owner/requester ids — one UPDATE per pair

As the portal's database role, on the job channel (see "Running SQL against a
deployed install" below — this is a transaction, so it does not want the exec
channel), for each email→oid pair:

```sql
UPDATE apps SET "ownerId" = '<oid>' WHERE "ownerId" = '<email>';
-- Pending approval requests carry the same pre-re-base identity: fill their
-- requestedOid from the same pairs, which unfreezes them (a null requestedOid
-- fails closed on every decide and withdraw path until this runs).
UPDATE approval_requests SET "requestedOid" = '<oid>'
WHERE "requestedBy" = '<email>' AND "requestedOid" IS NULL;
```

Both are safe to re-run; idempotent once applied (the email matches zero
rows). Apps created **after** the deploy already store the oid and are
untouched. An unmapped owner fails closed and visibly — 403 on `ownsApp`, an
empty `scope=mine` — which is the checklist finding its own gaps.

### 4. Revoke the dev tokens

Revoke **every** non-revoked dev token and have the developers re-mint once:

```sql
UPDATE app_dev_token SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
```

Plainly stated: this is blanket revocation, not only the pre-cutover rows the
old `developerOid` values identify — a developer who re-minted in the drain
window holds a perfectly valid new-space token and is revoked anyway.
Over-revocation is the deliberate direction (the end state is uniform, and a
stale dev-tier partition key is worse than one re-mint), and scoping by shape
cannot work: pre-re-base `developerOid` can be email-shaped *or* a collapsed
`preferred_username`/`sub` value, so no WHERE clause cleanly separates the
two eras. Tell the developers: re-mint from the portal's Dev Mode tab. This
is the only user-visible disruption in the whole change (7 tokens across the
two live installs at inventory time).

### 5. Verify each owner's next login

For every owner on the checklist: sign in, confirm the app appears under
**Mine** and a mutating action (e.g. a settings save) succeeds. `helix whoami`
should print the oid that now sits in `ownerId`.

## Running SQL against a deployed install

The database is private-network only — no public endpoint, and on the reference
installs no gateway, bastion or jump box either, so there is no psql hop from a
workstation. Everything runs inside the VNet, and there are **two channels with
different shapes**. Pick by the task, not by habit:

| | a quick look | a change |
| --- | --- | --- |
| mechanism | `az containerapp exec` into the portal app | a throwaway `postgres:16` job in the VNet |
| round trip | seconds | a minute or two |
| SQL size | ~2 KB, whitespace-hostile | unlimited |
| transactions | no | yes — real psql, `ON_ERROR_STOP=1` |
| good for | the preflight inventory, verification | **steps 2-4 below** |

**Step 3 is a transactional, multi-statement write, so it belongs on the job
channel** — two UPDATEs per email→oid pair plus the dev-token revoke, which
wants to be all-or-nothing and wants readable row counts. Running it through
exec is possible but means base64'ing a program, fighting a 2 KB URL and
batching to stay inside a rate limit, none of which buys anything here.

If you do use the exec channel for a read, three edges present as something
else: `--command` is split on whitespace and quotes do not group (base64 the
program and run `node -e eval(Buffer.from('…','base64').toString())`); the
command rides a ~2 KB websocket URL and overflowing it returns a **404** that
reads as a wrong resource name; and the endpoint is documented as throttling
around five calls per ten minutes. Also `pg` resolves only via
`/app/node_modules/.pnpm/pg@*/node_modules/pg`.

On the job channel, the output is the part that surprises people: `az
containerapp job logs show` may return **nothing** for a short job, with no
error. The output is not lost — read it from the environment's Log Analytics
workspace, filtering on `ContainerJobName_s` and ordering by `_timestamp_d`
rather than `TimeGenerated`, which is stamped per batch and scrambles psql's
table output.

Runners for both live in the ops repo (`portal-query.sh`, `portal-sql.sh`,
`rebase-principals.sh`) — use them rather than re-deriving any of this.

**One-way doors.** After `UPDATE apps SET "ownerId" = '<oid>' WHERE "ownerId"
= '<email>'` runs, the email matches zero rows: a WRONG oid for an owner
leaves them locked out (visibly — 403, empty Mine) until corrected with
`UPDATE apps SET "ownerId" = '<right>' WHERE "ownerId" = '<wrong>'`. The
display email survives in `ownerEmail` regardless, so the UI stays readable
and the mapping is recoverable — but double-check the pairs against the
ops-repo list before running.

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

- No `app_data` backfill of any kind: **on the two reference installs** the
  inventory read zero rows, so there is nothing to strand — and a fresh
  install has none either. On any install whose inventory shows user-scoped
  rows, the no-backfill stance still holds *only after* the drain in step 2
  has stopped old-space writes; rows written under pre-deploy sessions before
  that drain are stranded by design (present, unreachable, unrecoverable —
  which is why the preflight makes the drain mandatory in that case).
- No edit to `gateway_calls` or `app_collection_items` history: the ledger
  keeps what was true at write time (`COUNT(DISTINCT "userOid")` rollups may
  double-count a user across the cutover — cosmetic, once).
- No registry-projection change: the edge still sees no owner field
  (ADR-0048 decision 4 — the `private` mode remains decoupled).
