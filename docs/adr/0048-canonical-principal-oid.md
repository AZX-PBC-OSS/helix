# ADR-0048 — Canonical principal identifier: the Entra `oid` claim, captured at source in both planes

**Status:** Accepted _(recorded 2026-09-21; implementation mechanics sequenced by the prod inventory in the final section)_
**Related:** ADR [0004](0004-auth-model.md) (the auth model the misnomer was born into); ADR [0015](0015-app-data-three-scope-model.md) (the user scope whose partition key is re-based here); ADR [0021](0021-metering-ledger.md) (the display half, already separated by capture-at-write); ADR [0007](0007-portal-authz-v0.md) (the RBAC future that consumes this); ADR [0040](0040-entra-group-visibility-directory-seam.md) (the Graph door this declines to reopen, and the groups snapshot the admin check will reuse); ADR [0028](0028-deployment-model-customer-deployed.md) (why a zero-tenant-ask decision matters); the `private`-visibility item in [`TODO.md`](../../TODO.md) (which this splits in half)

## Context

The platform identifies the same human through two different claims, and in production they never agree:

- The edge session's `oid` is the raw ID-token `sub` (`apps/edge/src/auth/oidc.ts`, `OidcIdentity.oid`) — a field that has claimed to be the directory object id since M3 and never was.
- The portal's `App.ownerId` is the actor's `sub` collapsed to `email ?? preferred_username ?? sub` (`apps/portal/src/auth/verifier.ts`).

Entra issues `sub` **pairwise per client id**: the same human is a different `sub` in the edge's app registration than in the portal's. The two values can never be compared, joined, or made to correspond in production. It only looks like they can against `apps/dev-idp`, which issues the same `sub` to every client — the worst available failure shape: green locally, owner locked out of their own app in prod. This mismatch is the blocker under the reserved `private` visibility mode, under per-app RBAC (ADR-0007's residual), and under ADR-0031 decision 12's `groups` dimension.

Three adjacent facts shape the decision:

1. **The display half is already separated.** ADR-0021's 2026-08-31 amendment captures `userName`/`userEmail` at write time on every ledger and collection row, and `App` carries `ownerName`/`ownerEmail` (migration `20260819214211`) with a comment saying those columns exist to survive an `ownerId` re-base. What remains wrong is purely the identity half.
2. **The identity half is load-bearing.** `session.user.oid` is not just a comparison key — it is the RLS partition key for user-scoped `app_data`, injected as the `app.user_oid` GUC (`apps/edge/src/db/partition.ts`; app-data design §3.1). Re-basing it strands stored rows behind a partition predicate that no longer matches: a user's notes and drafts silently vanish while the rows remain present and unreachable. That, not the `ownerId` rewrite, is the dominant cost — and it is proportional to stored user-scoped rows.
3. **The platform is pre-pilot.** The last M5 exit criterion (a real app end to end, TODO.md) is still open, so stored user data is at its lifetime minimum. The cost of this change grows with every real user and every stored row; the cost of deciding never shrinks.

## Decision

### 1. The canonical principal identifier is the Entra `oid` claim, read at source in both planes

The edge reads `claims.oid` from the ID token into `OidcIdentity.oid` — the field finally holds what its name has promised since M3. The portal reads `payload.oid` from the verified access token into a new `Actor.oid`, and `App.ownerId` stores it: `ownsApp` and `scope=mine` compare against `Actor.oid`, `POST /apps` stores it, and a missing `oid` fails closed on both, mirroring `ownsApp`'s null-`ownerId` posture. The dev-token actor (dev/CI only, refused in production) gets a fixed synthetic `oid`. `Actor.sub` stays the email-collapsed value it is today — it is the display/audit half (`AuditEvent.actor`), not the identity half, and this ADR keeps that split rather than repurposing it.

`oid` is the directory object id: stable for the life of the user object and **identical across every app registration in the tenant** — exactly the property pairwise `sub` lacks, and the whole bug. It is tenant-scoped: a B2B guest's `oid` is their object id *in this tenant*, which is the correct scope since one deployment serves exactly one tenant (ADR-0023; a future multi-org platform would need a `tid` qualifier, deferred with that decision).

### 2. The claim name is hardcoded `oid`, and a token without it fails the login

No config var, and no fallback to `sub`. A fallback would reintroduce the exact bug this ADR exists to kill, in the exact green-locally shape; a config var would let a deployment point the canonical id at something mutable or pairwise. Entra emits `oid` unconditionally in ID and access tokens — no claim configuration, scope, or consent is needed to receive it — so there is nothing legitimate to configure. Absence is a misconfiguration, and it fails closed at login with a specific, stable-`event` log line, the same diagnosability posture as the group-overage line in `oidc.ts`.

### 3. The alternatives are rejected

- **Email matching** — compare `session.userEmail` against the owner's email, case-insensitively. Cheapest (the columns already exist) and rejected on the doctrine this codebase has been building for a year: compare the id, never the label. An email is a mutable display value; an owner who changes it is locked out of their own app by an access-control key that silently rotted. The one legitimate use of an email join is transitional (decision 6).
- **Graph resolution** — resolve the subject to a person at read time. Blocked twice over: `GroupMember.Read.All` does not confer a `/users` read, and widening the grant is a new ADR rather than a new method (ADR-0040 decision 3); and a pairwise `sub` is not a directory object id, so even with `User.Read.All` it would not resolve. Capture-at-source is not a stopgap standing in for a resolver we might build later — it is the design, and it stays correct after this ADR lands.
- **A per-app principal allowlist as an identity dodge** — TODO's option (c), read as avoiding the shared identifier. It does not avoid it. An ACL is a set of principal ids that must be written in some identifier space the edge session can express: in portal-`sub` space the edge cannot match them (this bug, one layer down); in email space it is the first rejection wearing a schema; resolved through Graph it is the second. Every correct variant of (c) presupposes this ADR.

### 4. The identity work is decoupled from the `private` mode

This ADR decides the identity half only. The visibility enum stays reserved (`packages/shared/src/visibility.test.ts` keeps the reservation enforced), the registry projection gains no owner field, no admin-group id is mirrored into edge config, and no gate changes. Until a consumer lands, the cross-plane correlation is exercised by a pinned test (decision 7) rather than by production behaviour — which is the point: the expensive half is done while it is cheap, and the feature half is free to wait on product decisions without dragging the identity model with it.

### 5. When `private` lands, its shape is already chosen in outline

The mode's semantic is **"`private` means consult the app's ACL"**. On day one the ACL is *derived*, not stored: `{ownerId} ∪ admins`, where the owner half is an equality test against the projected `ownerId` and the admin half is a membership test of the session's re-checked `groups` snapshot against an admin group id mirrored into edge config (`PORTAL_ADMIN_GROUP_ID` is portal-only today). A *materialized* ACL column is added only when per-app RBAC needs non-derivable members (editors, viewers, co-owners).

Day-one behaviour of a derived and a materialized ACL is identical; the difference is portal-side machinery — a column, write paths to keep it in sync, and a real drift failure mode: an ownership transfer that leaves a stale ACL entry grants the ex-owner continued access, whereas the derived form cannot drift because its comparison key *is* the owner column. Deciding the framing now and the storage later costs nothing and fixes the semantics permanently; this is recorded so the `private`-mode change inherits a decision instead of reopening one.

### 6. The re-base mechanics are chosen by the prod inventory

The decision itself needs **no DDL**: every affected column (`apps.ownerId`, `sessions.userOid`, `app_data.userOid`, `app_dev_token.developerOid`) is TEXT, the RLS policies compare GUC to column whatever the value, and the display half already lives in separate columns. What the re-base strands, and what to do about each:

- **`app_data`, user-scoped rows — the real cost.** Straight cutover if the inventory (final section) shows ~zero, which is expected pre-pilot: deploy, let sessions drain (8 h TTL, 1-day sweep), verify each owner's next login. If the numbers are non-trivial, the mechanism is a **lazy per-app backfill piggybacked on login**: the post-cutover ID token carries both the pairwise `sub` and the `oid`, so the login path knows the mapping (a transitional field on the identity, deleted after convergence); the edge already holds DML on `app_data`; and the UPDATE runs inside the app partition the login is for — which is also the only scope sessions exist in. It hits the existing unique index, is self-pruning (matches zero rows once converged), and needs no new table. Rows belonging to users who never return stay stranded — indistinguishable from abandoned data, and accepted. A dual-read RLS policy edit (TODO's "accept either id, write the new one" window) is the last resort, engaged only for a large *active* user base: it is DDL on a security-critical policy, and nothing above needs it.
- **`apps.ownerId`** — a handful of rows; each must map before cutover or that owner fails closed (`ownsApp` 403, `scope=mine` empty). Pairs come from each owner's next portal login — `GET /api/v1/me` echoes the actor's `oid` alongside `sub`, additive on the wire — or from explicit operator-collected pairs.
- **`app_dev_token.developerOid`** — dev-only; existing tokens are invalidated and developers re-mint.
- **`gateway_calls` and `app_collection_items`** — nothing. The ledger is append-only and keeps its historical subjects by design (a ledger row records what was true at write time), and attribution there is the display half, already captured at write (ADR-0021 amendment). `COUNT(DISTINCT "userOid")` rollups double-count users who straddle the cutover — cosmetic, once.

Email may serve as a **transitional** join key (for example, session rows on either side of the cutover both carry `userEmail`). That is not the rejected email matching: it is one-shot, self-limiting, and never an access-control key — the label helps find the id once, then retires.

### 7. dev-idp grows the real shape, and the correlation becomes a pinned invariant

dev-idp gains a stable per-user `oid` claim (ID and access tokens — mandatory) and **pairwise `sub` per client** (required for honesty): until the same human presents different subs to the edge and portal clients locally, the production failure cannot be reproduced, only described. The regression test is the one this ADR exists for — the same fixture user's edge session `oid` and portal `ownerId` must be equal — asserted from both integration suites against a shared fixture constant, so the invariant is pinned without a new cross-package harness. Missing-`oid` fail-closed and the re-base itself (partition isolation before and after, backfill convergence) get adversarial coverage in the same change (project plan §6 — this is M3-auth-adjacent code).

### 8. What does not change

`AuditEvent.actor` (display half). The `/_api/me` `id` contract — its "stable, safe to key app data on" wording was always true per-user, because the edge's client id is stable and therefore so is its pairwise `sub` *for the edge*; the value's provenance changes and the guarantee strengthens. Portal admin gating (App Roles in `roles`, ADR-0040 decision 1 — orthogonal to principal ids). The attested instruction's `userOid` (an opaque id crossing the egress boundary; values change provenance, schema and semantics do not). The edge's groups snapshot and overage handling. Telemetry adds no new instrument: the one new denial (missing `oid`) is a login-path refusal that logs with a stable `event` name — the same class and posture as the group-overage line — and rides the existing auth-route span for its status code.

## Consequences

- **Deciding now was the cheap half, and it stays cheap only once.** Every real user and every stored user-scoped row after the pilot lands grows the backfill in decision 6; the inventory is expected to show ~zero precisely because it is being taken before the pilot. This ADR's timing is the load-bearing part of its cost estimate.
- **No tenant-side ask at all.** Unlike ADR-0040, `oid` requires no registration edit, no claim configuration, no consent meeting — it is unconditional in Entra tokens. A customer deployment (ADR-0028) receives this by deploying.
- **A mis-mapped owner fails closed and visibly** (403 on `ownsApp`, an empty `scope=mine`), never open — and the pre-pilot owner count makes verification a checklist, not a program. The inventory's owner list is that checklist.
- **dev-idp pairwise subs will surface latent assumptions.** Nothing in production code compares an edge `sub` to a portal `sub` — that absence *is* the bug — so only tests can break, and a test that assumed same-sub-across-clients was pinning the failure shape, not a contract.
- **The inventory's numbers are recorded with a date** and select the mechanism per decision 6; they land in this ADR as an amendment when run, and unblock the implementation.
- **Docs to rewrite when implementing:** the misnomer paragraph in `oidc.ts`, the `id` wording in `packages/shared/src/auth.ts`, app-data design §3.1, and the TODO item — which now tracks only the `private`-mode half and the re-base implementation, both citing this ADR.

## Pre-implementation prod inventory (the homework)

_Hand this section, plus the ADR, to whoever has prod access. It is self-contained and read-only._

**Context.** Helix runs on Azure Container Apps (three apps: edge, portal, egress) with Azure Database for PostgreSQL Flexible Server (`helix-prod-pg`). We are about to re-base the platform's principal identifier from what it is today (a pairwise OIDC `sub` on the edge, an email-collapsed `sub` in the portal) onto Entra's stable `oid` claim, per this ADR. The re-base strands any existing user-scoped `app_data` rows unless they are backfilled, so the **row counts below choose the migration mechanism** (ADR-0048 decision 6): near-zero → straight cutover; known smoke users → one-shot paired script; real scale → lazy login-time backfill. The platform has not yet served its pilot app, so the strong expectation is ~zero; **a nonzero surprise is itself the finding** — report it, do not act on it.

**Access.** The database is private-network only (`publicNetworkAccess: Disabled`), so there is no direct psql. Use the established exec pattern from `infra/azure/README.md` (its §"step 5" area): `az containerapp exec` into the **portal** container app — it holds `PORTAL_DATABASE_URL` and `pg` in its `node_modules` — and run Node one-liners under a pseudo-TTY. Something like:

```bash
script -q /dev/null az containerapp exec -g <rg> -n <portal-container-app> --command \
  "node -e \"const {Pool}=require('pg');const p=new Pool({connectionString:process.env.PORTAL_DATABASE_URL});p.query(process.argv[1]).then(r=>{console.log(JSON.stringify(r.rows,null,2));return p.end()}).catch(e=>{console.error(e.message);process.exit(1)})\" 'SELECT ...'" < /dev/null
```

Queries run as the portal's own database role, whose RLS posture on these tables is allow-all, so counts are complete. Nothing below writes; nothing touches secret material. The owner list does contain emails — keep the report internal.

**Queries, in order.**

```sql
-- 1. The re-base surface: user-scoped app_data rows, prod vs dev split.
--    (dev rows are keyed by developer tokens, which are being invalidated anyway;
--     prod rows are the ones that can strand.)
SELECT "env", count(*) AS rows, count(DISTINCT "userOid") AS users
FROM app_data WHERE "userOid" IS NOT NULL GROUP BY "env";

-- 2. Which prod apps hold those rows — smoke fixtures vs anything real.
SELECT a.slug, count(*) AS rows, count(DISTINCT d."userOid") AS users
FROM app_data d JOIN apps a ON a.id = d."appId"
WHERE d."userOid" IS NOT NULL AND d."env" = 'prod'
GROUP BY a.slug ORDER BY rows DESC;

-- 3. The owner checklist: every distinct ownerId must map to an oid before cutover,
--    or that owner fails closed. Plus dev tokens to invalidate.
SELECT slug, "visibilityMode", "ownerId", "ownerName", "ownerEmail" FROM apps ORDER BY slug;
SELECT count(*) AS dev_tokens FROM app_dev_token;

-- 4. Informational only — historical attribution, no re-base, no action.
SELECT count(*) FILTER (WHERE "userOid" IS NOT NULL) AS attributed_items FROM app_collection_items;
SELECT count(*) AS sessions, count(DISTINCT "userOid") AS recent_users FROM sessions;
```

**Interpretation.**

- Query 1, `env='prod'` rows **= 0** → straight cutover (decision 6): deploy, let sessions drain (≤ 8 h TTL + 1-day sweep), verify each owner's next login. Done.
- Prod rows **> 0 but every `userOid` traces to a known smoke user** (cross-reference query 2's app slugs) → one-shot script with explicit pairs, run as the portal role: one `UPDATE app_data SET "userOid" = $oid WHERE "userOid" = $old` per pair.
- Prod rows with **unknown users, or a scale where manual pairs are silly** → the lazy per-app backfill at login (decision 6); the stranded tail is accepted by design.
- A **large active user base** (query 4's `recent_users` wildly above the stored-row users) is the only shape that justifies the dual-read RLS policy edit — and pre-pilot it should not exist. If it does, stop and report before implementing anything.
- Query 3: report the full owner list with emails. Each owner's pair comes from their next `helix whoami` / portal login after the portal change deploys (`/api/v1/me` will echo `oid`), or from operator-collected pairs. An unmapped owner is locked out of their apps — visibly (403), not silently.

**Report back:** the four result sets, the date, and which mechanism the thresholds above select. The results go into this ADR as an amendment and unblock the implementation item in TODO.md.
