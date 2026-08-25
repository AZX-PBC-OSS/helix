# 0040. Group visibility: security groups, one admin-consented Graph permission, behind a directory seam

**Status:** Accepted _(recorded 2026-08-20; amended 2026-08-25 — decision 11)_
**Related:** ADR [0004](0004-auth-model.md) (the gate this feeds); ADR [0003](0003-dependency-minimal-edge.md) (why Graph stays out of the edge); ADR [0006](0006-secret-custody-seam.md) (the seam this copies); ADR [0007](0007-portal-authz-v0.md) (why the search endpoint is exposed as widely as it is); ADR [0027](0027-blob-auth-managed-identity.md) (the credential posture); ADR [0028](0028-deployment-model-customer-deployed.md) (why a customer tenant is the hard case); `docs/runbooks/entra-app-registration.md` ("Deferred (until needed)" — this closes it); `docs/reviews/2026-08-20-entra-group-permissions-probe.md` (the evidence)

## Context

Per-app **group visibility** has been half-built since M3 and inert since M5. The enforcement half is real: `Visibility` is a discriminated union carrying `{ mode: "group", groupId }` (`packages/shared/src/visibility.ts`), the columns exist, and `visibilityAllows` (`apps/edge/src/auth/validate.ts`) intersects the app's group against the session's group snapshot — checked at the OIDC callback, re-checked per request against the live registry entry, and re-snapshotted on silent refresh, so removal from a group bites within the session TTL. It has adversarial tests.

The identity half was never wired, and the runbook says so out loud: `docs/runbooks/entra-app-registration.md` defers the App-Role-vs-security-group decision "until a real app needs it." The consequence is worse than "not implemented." `infra/entra/main.bicep` declares **no app roles** on the edge registration and prod sets `EDGE_OIDC_GROUPS_CLAIM=roles`, so the claim is empty for every user: setting an app to `group` today denies **100%** of users, including its owner. Meanwhile the portal's Access tab already offers the mode with a free-text group-id box. The gate is fine; the pointing device is a footgun.

What exists in prod instead is install-level gating from the 2026-08-12 guest-access work: `appRoleAssignmentRequired` plus explicit `edgeAccessPrincipalIds` / `portalAccessPrincipalIds` per install. That controls who reaches an *install*, which is a different question from who reaches an *app*.

Demand is now real from two directions — internal, and a prospective customer deployment — so the deferral has run out.

Two prior constraints shaped every option below. The edge is deliberately dependency-minimal (ADR-0003), so it cannot grow a Microsoft Graph client. And under ADR-0028 the platform is deployed into a customer's own cloud against a tenant we do not control, so any permission we require is a permission somebody else's administrator has to be persuaded to grant — once, in a meeting, with a security team present.

Because that consent ask is the expensive and irreversible part, the decisions below were made against an empirical probe rather than the Graph documentation, which is loose about which permission covers which *query shape*. Four isolated app registrations, token `roles` claims asserted before any call, sixteen probes, full cleanup: `docs/reviews/2026-08-20-entra-group-permissions-probe.md`.

## Decision

### 1. Security groups, not App Roles, as the claim source

The edge registration gets `groupMembershipClaims: SecurityGroup`; the `groups` claim carries security-group **object GUIDs**; prod stops overriding `EDGE_OIDC_GROUPS_CLAIM` and returns to the code default of `groups`. Portal admin gating stays on App Roles in `roles` (`PORTAL_ADMIN_GROUP_ID` = `platform-admin`) — different registration, no collision.

App Roles were the incumbent and are rejected on their central premise. They emit readable strings and need no Graph at all, but **adding a group means editing an app registration**, which is an infrastructure deploy performed by a platform administrator. The entire point of group visibility is to leverage groups that somebody else already manages, so a design where the control plane cannot reference a group without an infra change does not solve the stated problem — it relocates it.

The cost accepted with that: GUIDs, not names. There is no "emit display name" option for cloud-only groups, so name resolution stops being polish and becomes a requirement (decision 3).

### 2. One admin-consented Graph permission: `GroupMember.Read.All`, application, portal-only

Not `Group.Read.All`, not `Directory.Read.All`, and no delegated scope.

The deciding probe: `GET /groups?$search="displayName:…"&$count=true` with `ConsistencyLevel: eventual` returns **200** under `GroupMember.Read.All`. That was the one result the design hinged on, and it holds. Across all sixteen probes `Group.Read.All` showed **zero** incremental capability, and its consent description additionally grants group *conversations*, which we will never call. Asking for more when less is demonstrably sufficient is indefensible in front of the administrator we are asking.

`$search` is required, not preferred. For one term the probe found **3** groups via `$search` and **2** via `startswith(displayName, …)`: the miss was a group whose name carries the term as its second word. A prefix filter does not merely offer worse UX — it *silently omits matching groups*, which in a picker is a correctness bug. The `ConsistencyLevel: eventual` header is mandatory (400 `Request_UnsupportedQuery` without it) and therefore belongs inside the package, never at a call site.

### 3. A `packages/directory` seam with two methods and no third

Modelled on `packages/secret-store` (ADR-0006): zero runtime dependencies, hand-rolled Graph v1.0 REST over global `fetch`, credential injected as a one-function `GetGraphToken` seam.

```
DirectoryProvider:
  searchGroups(query)  -> { id, displayName, securityEnabled }[]
  getGroups(ids[])     -> { id, displayName }[]
```

**It has no member-enumeration method, and that absence is the decision.** The probe found `GET /groups/{id}/members` returns **200** under `GroupMember.Read.All` — the grant permits reading who is in every group in the tenant. We never need it. Leaving it out of the interface makes our actual blast radius auditable by reading one file, and stops a later contributor reaching for `/members` because it happens to work.

Implementations: `EntraDirectory` (Graph), `StaticDirectory` (dev-idp fixtures and CI), and an **unavailable** variant that reports its own absence rather than throwing — see decision 8.

The provider lives in the **portal only**. The edge never calls Graph, never holds the credential, and is unchanged by this ADR beyond the set-intersection in decision 5.

### 4. The Graph credential is the portal's managed identity

Not a client secret, not a certificate. The portal already injects `DefaultAzureCredential` for Key Vault (`apps/portal/src/secrets/custody.ts`) and runs on Container Apps with a managed identity; a managed identity can hold Graph app-role assignments directly, so `GetGraphToken` is satisfied by a credential that already exists with nothing to rotate. Workload identity federation is the same seam elsewhere.

This is also forced, not merely preferred: the probe found the tenant's default app management policy **bans client secrets** (`Credential type not allowed as per assigned policy` — `passwordAddition` and `symmetricKeyAddition` restricted, `keyCredentials` unrestricted). A design assuming a client secret would not have deployed. Whether customer tenants apply the same restriction is unknown and no longer matters.

### 5. N groups per app, any-of, capped at 10 in code

`visibilityGroupId String?` becomes `visibilityGroupIds text[]`; `visibilityAllows` becomes a set intersection; the registry projection carries the array; `Visibility` becomes `{ mode: "group", groupIds }`.

Semantics are **any-of (OR)** — "engineering or product." All-of is a real but far rarer need and can arrive later as a distinct mode without breaking any-of.

Single-group was rejected because its only workaround for a cross-team app is asking a directory administrator to create a union group, which is the exact friction decision 1 exists to remove. Nested groups do not rescue it: membership **is** transitive (decision 9), so a parent group can express the union — but only once somebody creates that parent group.

The cap is **10, enforced in zod and nowhere else**. Because the storage is an array, moving it needs no migration, so the number is a policy guess that costs nothing to revise. Retrofitting N onto a scalar would instead be an expand/contract migration on a security-critical column with a live projection — a dance this repo has already done for the `private`→`internal` rename, over three releases, and the scar tissue is all over `visibility.ts`.

### 6. "Groups you're a member of" comes from the portal's own verified token

The picker defaults to the caller's groups and offers full-directory search behind it. That default view is served from the **groups claim on the portal registration's access token** — not from Microsoft Graph, and not from a delegated `User.Read` token.

`apps/portal/src/auth/verifier.ts` already reads a group claim into `Actor.groups` for admin gating. Adding `groupMembershipClaims: SecurityGroup` to the portal registration puts the caller's security-group GUIDs on a token the portal has already cryptographically verified. `GET /api/v1/directory/my-groups` then resolves those ids to names through the *same* app-only resolver the Access tab needs anyway — reuse, not new surface.

The rejected alternative was a second, delegated `User.Read` credential (probed and confirmed working: `POST /me/getMemberObjects` returns 200 under user consent alone, with no administrator involved — a genuinely attractive property). It is rejected because it requires the portal to hold or forward a **user access token**, which is new and durable credential surface on the control plane, in exchange for information a token the portal already verifies can carry for free. It also drags in the `/me/memberOf` null trap (see Consequences); the claim route deletes that failure class rather than defending against it.

The app-only permission is *not* replaceable this way: delegated `User.Read` 403s on both `/groups?$search=…` and `GET /groups`. Search is genuinely a tenant-wide read — the picker must find groups the owner is not in — so the two planes are complements, and we choose the one that costs no new credential.

### 7. Group names are resolved live and recorded in audit; never cached on the app row

The authorization value is the GUID array and nothing else. Display names are resolved on demand through the provider and cached client-side by TanStack Query. When Graph is unavailable or an id is stale, the UI renders `unknown group (GUID)`; the probe confirms both degradations are clean (`404 Request_ResourceNotFound` on `GET /groups/{id}`, `200` with an empty array from `getByIds`), never a hard error.

No name column on `App`. A second, staler copy of a name sitting beside a live authorization value invites exactly one bug — disagreeing about which is real — and the UI would show the wrong one.

**Audit entries are the exception, and are not a cache.** A visibility change records the group names as observed at write time, because that is a historical fact about what the operator believed they were selecting. Audit rows are immutable; that is the thing anyone actually wants six months later.

### 8. Absent consent degrades to free-text GUIDs, loudly and locally

`GroupMember.Read.All` may be ungranted — a customer tenant mid-negotiation, or a deployment whose administrator declines. The provider detects `403 Authorization_RequestDenied` and reports **unavailable**. The Access tab then falls back to today's free-text GUID entry with an explicit banner naming the missing permission. Group visibility keeps working end to end, because enforcement never depended on Graph; only the picker does.

The failure must not surface as a broken Access tab, and must not be silent.

### 9. Nesting expands, and the copy must say so

Membership in the claim is **transitive**: scoping an app to a parent group admits members of its children. The probe's purpose-built fixture confirmed `parent` absent from `memberOf` but present in both `transitiveMemberOf` and `getMemberObjects(securityEnabledOnly: true)`, identically under delegated and app-only tokens.

The Access tab currently promises "members of one directory group." That under-specifies in the direction that silently **over-admits**, and nested security groups are ordinary in real directories. The copy must say members *including members of nested groups*.

### 10. Claim overage is logged, not resolved

Above roughly 200 groups Entra replaces the claim with `_claim_names` / `_claim_sources` pointing at Graph. The current edge code reads no groups in that case and therefore **denies** — fail-closed, which is the right direction, but indistinguishable from a bug.

v1 does not resolve overage. The edge logs loudly and specifically when it sees `_claim_names`, so the condition is diagnosable rather than mysterious. Resolving it would put a Graph call on the sign-in hot path in the plane that is forbidden one (ADR-0003), so it is a separate decision with a different shape, deferred until a real user trips it.

### 11. Who may search is a deployment setting, defaulting to today's behaviour

_Amendment, 2026-08-25. Decisions 1–10 are unchanged; this narrows the surface the
last bullet of the Consequences describes._

`PORTAL_DIRECTORY_SEARCH` takes `everyone` | `admins` | `none`, resolved in
`apps/portal/src/policy/directoryPolicy.ts` and enforced on
`GET /api/v1/directory/groups`. `admins` reuses `actorIsAdmin` — the same
`PORTAL_ADMIN_GROUP_ID` definition that gates the approvals queue, not a second
one. **Unset means `everyone`**, which is exactly what this ADR shipped, so the
setting is opt-in and no deployment changes behaviour without an operator acting.
An unrecognised value falls to `admins` and warns at boot: a typo must not
silently widen a surface an operator was trying to narrow.

This exists because the consent ask and this surface are **different negotiations
with different people**. The Graph grant is settled once with a directory
administrator and decision 2 already makes it the narrowest one that works. This
one is ours, we chose it, and a customer who objects to it currently has no answer
short of declining the picker. A dial turns that objection into a config line.

Three properties are load-bearing:

- **It is a different axis from `PORTAL_DIRECTORY`**, which selects the *backend*.
  This selects *who may query it*. `PORTAL_DIRECTORY=off` still reports
  unavailable for everyone whatever the tier says. `none` is therefore not
  redundant with `off`: `off` also kills id→name resolution, where `none` keeps
  every name resolving and removes only discovery.
- **The tier gates search; the resolves are handled separately.** `my-groups` is
  never gated — it resolves the claim on the caller's own verified token and
  genuinely returns nothing new. `/apps/:slug/visibility/groups` needed a
  correction: a first pass excused it with the same argument, on the grounds that
  it resolves ids already carried by `GET /api/v1/apps/:slug`. **That was false,
  because the caller chooses the ids.** `POST /api/v1/apps` is authenticate-only
  and `VisibilityGroupIdsSchema` never validates a group id against the
  directory, so anyone could store ten arbitrary ids on an app of their own and
  read the names back with search refused — and since unresolvable ids are
  silently omitted, learn which of them exist. So on any deployment that sets a
  tier, that route additionally requires **owner-or-admin**
  (`ownsAppWhenSearchRestricted`), reusing `ownsApp`. It stays open under
  `everyone`, deliberately: the same route backs the apps-table badge's
  hover-to-name for every row, and gating it where nothing is restricted would
  pay a UX cost for no benefit. A restricted caller therefore keeps a working
  picker — own groups by name, their own apps' stored groups by name, add-by-id —
  and loses discovery of groups they are not in.
- **"You may not search" is not a `DirectoryUnavailableReason`, and must never be
  rendered as one.** Those values are deployment-level and name an operator's
  fix; this is per-caller and nothing is broken. Concretely, `GroupPicker` ORs
  `available: false` across all three queries into one banner reading "Group
  search is unavailable on this deployment" — a refusal routed through that shape
  would claim the directory is down while it is visibly naming groups on the same
  screen. Instead the server refuses with a plain `403`, and `/api/v1/me` carries
  a server-computed `canSearchDirectory` so the SPA never issues the request at
  all.
- **What the browser is told, precisely.** A caller who **may** search learns
  nothing about the posture. A caller who is **refused** additionally gets
  `searchRestriction: "admins" | "none"`. An earlier draft of this decision said
  the browser learns "the answer, never the tier", and that was too strong to
  implement honestly: with only a boolean the picker hard-coded "limited to
  platform admins", which is false under `none` — and false in the worst
  direction, since a platform admin refused by `none` is told the restriction is
  the role they hold, and goes off to audit a `PORTAL_ADMIN_GROUP_ID` that is
  correct. The reason discloses nothing a refused caller could not infer from the
  403 they would get by asking. The admin group id still never crosses.
- **`canSearchDirectory` is a tri-state in the SPA, and `isAdmin`/`canSearchDirectory`
  are defaulted on the wire.** Unknown (`/api/v1/me` errored — reachable on one
  500, since that query does not retry and `meLoading` covers only the in-flight
  half) must render no search box **and no explanation**, because every available
  sentence would be a guess about deployment policy. On the wire both booleans
  carry zod defaults so the published CLI keeps parsing older portals (ADR-0032 +
  ADR-0028): `canSearchDirectory` defaults to **true**, because a portal old
  enough to omit it has no tier enforcement and so behaves like `everyone`;
  `isAdmin` defaults to **false**, because silence is not a grant.

The refusal is checked **before** the rate limit, so a denied caller spends no
budget and costs no write, and it is logged rather than audited — with the limiter
deliberately not on that path, an audit row per refusal would be an unbounded
INSERT available to any authenticated principal.

**Not** gated on this: the add-by-id escape hatch. What the tier controls is
discovering group *names*; using a group *id* is unaffected, and removing the box
would leave a restricted caller unable to scope an app to any group they are not
personally in.

**Residual, stated plainly.** Even with the owner-or-admin gate, an operator can
still resolve arbitrary ids on their *own* apps — ten per request, against the
resolve limiter. That is a real name-and-existence oracle and it is not closed
here. It does not defeat the tier: there is no name→id direction, and Entra
object ids are not guessable, so it confirms ids the caller already holds rather
than discovering new ones. Closing it means validating stored group ids against
the directory, or per-app RBAC (ADR-0007) — a different decision either way.

## Consequences

- **`payload.groups ?? payload.roles` was a live landmine — closed.** `verifier.ts` used `??`, not a union. `groups` was absent, the fallback fired, and `roles` delivered `platform-admin`. The moment decision 6 added SecurityGroup claims to the portal registration, `groups` would have become present and truthy, the fallback would have stopped firing, and **admin gating would have broken in production** — approvals and every admin page locking out every admin — triggered by an Entra-side configuration change with no code deploy and no failing test. It was the single most dangerous item in this ADR and the least visible. `unionClaimArrays` (`apps/portal/src/auth/verifier.ts`) now concatenates both claims, with tests pinning it, and landed before the registration was touched.
- **Access-token size becomes a real bound.** Group GUIDs ride the access token (configure the Access-token variant, not only the ID token). Just under the ~200-group overage threshold that is roughly 7KB of extra `Authorization` header against Node's 16KB default — probably fine, a hard request rejection if not. Measure it; do not assume it.
- **The consent ask is narrower in wording than in fact, and we should not pretend otherwise.** "Read all group memberships" enumerates the membership of every group in the tenant — the organization's social graph. Against a thoughtful security reviewer that is arguably a *harder* sell than "Read all groups," which sounds like metadata. The honest pitch is not that the permission is small but that our usage is small and structurally constrained (decision 3), read app-only from the control plane, never from the plane that serves untrusted app code.
- **There is no bounded consent ask available.** Graph application permissions are tenant-wide by construction: administrative units scope *directory role* assignments, not app-permission grants, and resource-specific consent exists only for Teams resources. The probe found nothing to test. So a customer administrator who wants "read only these groups" cannot be accommodated at the permission layer, and decision 8 — degrade to free-text GUIDs — is the only answer we have for a refusal. That makes decision 8 a requirement, not a nicety.
- **The per-actor rate limit lives on its own table, not the shared one.** ADR-0040 asked for one without saying where it lives, and the obvious answer — `rate_counters`, which already has exactly the right three columns — is wrong. That table is shared with the edge, which keys the shared-password login throttle and the anonymous IP limiter in it, and migration `20260721215912` revoked the portal's writes to it. Granting them back would hand the control plane (or a portal RCE) the ability to zero the edge's brute-force protection, and Postgres cannot scope a grant by key prefix — RLS is deliberately off that hot path. So the portal got `portal_rate_counters`: same shape, its own grant, the two planes' abuse-control state disjoint. `role-split.integration.test.ts` asserts both directions.

- **Helix exposes tenant-wide group search to every authenticated portal principal _by default_.** Portal reads are still authenticated-only (ADR-0007; per-app RBAC is the outstanding `PreviewBadge`), and the picker cannot be gated behind `ownsApp` because it is needed at app-*create* time, before an app exists. This is a new information-disclosure surface the platform is adding to itself, distinct from anything Graph does. It ships restrictive: minimum query length of 3 characters (no bare-prefix directory dumps), a hard `$top` cap, per-actor rate limiting, and audit. Loosening later is easy; tightening after someone depends on it is not. **Amended 2026-08-25:** that posture is now the `everyone` tier and no longer the only one — decision 11 makes it `PORTAL_DIRECTORY_SEARCH`, still defaulting to `everyone`, so a deployment can narrow it to platform-admins or to nobody without losing the picker. The default is unchanged precisely because tightening it silently, on the next deploy of a working deployment, is the failure this ADR keeps warning about in the other direction.
- **Guests are excluded by construction, which is a win.** B2B guests are directory principals, so `internal` admits them — precisely the overreach that drove the 2026-08-12 guest-access work. Guests are rarely in security groups, so group visibility narrows to staff without any install-level assignment list. It is a better answer to that problem than the one currently deployed.
- **Graph can answer 200 with a payload of nulls, so any group-property read needs a check that fails loudly.** Under delegated `User.Read`, `/me/memberOf` returns the correct *number* of groups with every property including `displayName` and `securityEnabled` set to `null` — no error, no annotation. A picker built on it renders the right count of blank rows and reads as a UI defect rather than a consent one; worse, an entirely reasonable `filter(g => g.securityEnabled)` matches zero while looking correct in review. Decision 6 keeps us off that endpoint entirely, but the rule stands for any future property read: a null `displayName` is an error, not an empty string.
- **The edge is untouched.** No new dependency, no Graph, no credential, no new call on the sign-in path — only `visibilityAllows` widening from `includes` to a set intersection, inside the existing deny-by-default fall-through that a test in `validate.test.ts` already pins.
- **The `ApplicationGroup` escape hatch stays available but unpromised.** The "Groups assigned to the application" claim variant would kill overage outright and hand an administrator a curated candidate set. The probe confirmed group-to-service-principal assignment works in a tenant carrying Entra ID P2 (via M365 E5), but could not produce the *unlicensed* failure, so the licensing floor for a low-SKU customer tenant is **unverified rather than disproved**. It remains an operator option; it is not offered as a guarantee, and it is not the default because it reintroduces per-group administrator involvement.
- **Two dev-vs-prod shapes now differ on purpose.** dev-idp emits readable strings (`eng-team`); Entra emits GUIDs. The provider seam and the gate are both indifferent, but no test may assume a GUID shape, and `StaticDirectory` is what keeps local development and CI free of Graph.
- **The runbook's deferral is closed and must be rewritten.** `docs/runbooks/entra-app-registration.md` currently instructs the reader to define an app role per group and records "Microsoft Graph group resolution — not needed with App Roles." Both statements become wrong the moment this lands, and the runbook is the document an operator follows during a real deployment.
