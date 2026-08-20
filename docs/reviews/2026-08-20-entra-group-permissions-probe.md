# Findings: Graph permission scoping for Entra group visibility

**Probe date:** 2026-08-20
**Tenant:** the org's primary Entra directory (the one holding the `helix-*` registrations).
**Method:** four throwaway app registrations, each probed in isolation and its token claims
verified before any call was made:

1. `GroupMember.Read.All` — app-only, admin-consented. `roles` claim asserted to hold that alone.
2. `Group.Read.All` — app-only, admin-consented. Likewise.
3. `GroupMember.Read.All` + `User.Read.All` — app-only, to locate the Q3 denial (§1).
4. delegated `User.Read` — public client, device-code flow, **user consent only, never admin**
   (`consentType: Principal`). This is the user-plane probe (§3).

**Cleanup:** complete and verified. All four apps, their service principals, and all three
fixture groups deleted **and purged** from `directory/deletedItems`. Confirmed zero
`helix-probe` residue across applications, service principals, and groups (live and
soft-deleted); zero surviving Graph app-role grants; the delegated consent grant returns
`Request_ResourceNotFound`. The three real `helix-*` registrations were never touched.

Answers to the handoff's §4 Q1–Q3 are **tested**, as is the user-plane alternative in §3. Q5 is
**read** (nothing testable exists). Q4 and Q6 are mixed and marked inline.

> **Note on §2.** An earlier draft of the recommendation concluded that the "groups you're a
> member of" default view should be dropped. That was wrong — it treated an app-only limitation
> as a product limitation. §3 tests the user-plane path that keeps the feature at no additional
> admin consent.

---

## 1. Results matrix

Identical under both permissions — every cell, including the advanced-query shapes.

| Probe | `GroupMember.Read.All` | `Group.Read.All` |
| --- | --- | --- |
| Q1a `$search` + `$count` + `ConsistencyLevel` | **200** (3 hits) | **200** (3 hits) |
| Q1b `$search` w/o `ConsistencyLevel` | **400** `Request_UnsupportedQuery` | **400** `Request_UnsupportedQuery` |
| Q1c `startswith` filter | **200** (2 hits) | **200** (2 hits) |
| Q1d `securityEnabled eq true` + `$count` | **200** | **200** |
| Q1e `$search` + `securityEnabled` (the real query) | **200** (3 hits) | **200** (3 hits) |
| Q2a `getByIds` | **200** (2 objects) | **200** (2 objects) |
| Q2b `GET /groups/{id}` | **200** | **200** |
| Q2c bogus GUID | **404** `Request_ResourceNotFound` | **404** `Request_ResourceNotFound` |
| Q2c soft-deleted group, `GET` | **404** `Request_ResourceNotFound` | **404** `Request_ResourceNotFound` |
| Q2c soft-deleted group, `getByIds` | **200** `value: []` | **200** `value: []` |
| Q3 `/users/{id}/memberOf` | **403** `Authorization_RequestDenied` | **403** `Authorization_RequestDenied` |
| Q3 `/users/{id}/transitiveMemberOf` | **403** `Authorization_RequestDenied` | **403** `Authorization_RequestDenied` |
| Q3 `/users/{id}/getMemberObjects` | **403** `Authorization_RequestDenied` | **403** `Authorization_RequestDenied` |
| Q3 `GET /users/{id}` (added probe) | **403** `Authorization_RequestDenied` | **403** `Authorization_RequestDenied` |
| Q7 `/groups/{id}/members` | **200** | **200** |
| Q7 dynamic-group `groupTypes/any(...)` filter | **200** | **200** |

Verbatim, for the two that failed:

```
Q1b  400  Request_UnsupportedQuery
     "Request with $search query parameter only works through MSGraph with a
      special request header: 'ConsistencyLevel: eventual'"

Q3   403  Authorization_RequestDenied
     "Insufficient privileges to complete the operation."
```

### The combination probe

Because all four Q3 calls failed — *including a plain `GET /users/{id}`* — the denial was
clearly on reading the **user object**, not on traversing memberships. Confirmed by building a
third app with `GroupMember.Read.All` **+ `User.Read.All`**:

| Probe | `GroupMember.Read.All` + `User.Read.All` |
| --- | --- |
| `GET /users/{id}` | **200** |
| `/users/{id}/memberOf` | **200** |
| `/users/{id}/transitiveMemberOf` | **200** |
| `/users/{id}/getMemberObjects` | **200** |

---

## 2. Recommendation

**Ask for exactly one admin-consented permission — `GroupMember.Read.All` — and keep the
"groups you're a member of" default view by serving it from the signed-in user's own token
rather than the app-only one.**

The deciding probe is **Q1a: `$search` returned 200 under `GroupMember.Read.All`.** That was the
single result the whole errand hinged on, and it removes every argument for `Group.Read.All` —
which showed *zero* incremental capability across all sixteen probes. Ask for the narrower
permission, whose consent string is also the narrower sentence ("Read all group memberships" vs
"Read all groups").

The default view does **not** justify escalating that ask. App-only, it would cost
`User.Read.All` — read every user's full profile tenant-wide, a harder sell than either group
permission. But the app-only plane is the wrong plane for it: "which groups am *I* in" is a
first-person question, and a user can answer it about themselves with delegated **`User.Read`**,
which the user consents to for themselves and **no tenant admin ever sees** (tested — §3).

So the portal carries two credentials, split by whether the question is about the tenant or
about the person:

| Question | Plane | Call | Permission | Consent |
| --- | --- | --- | --- | --- |
| Search all security groups | app-only | `/groups?$search=…` | `GroupMember.Read.All` | admin |
| Resolve stored GUIDs → names | app-only | `getByIds` / `/groups/{id}` | `GroupMember.Read.All` | admin |
| "Groups you're a member of" | **user** | `POST /me/getMemberObjects` | **`User.Read`** | user |

The split tracks the data, not convenience: search genuinely *is* a tenant-wide read (the picker
must find groups the owner isn't in, so it can't be done on the owner's behalf), while the
default view genuinely isn't.

**One wrinkle that shapes the implementation.** Delegated `User.Read` returns your group
**ids only** — `/me/memberOf` answers 200 but with every property null except `id` (§3). So the
default view is a two-step: get the ids from the user plane, then resolve them to names through
the *same app-only resolver* the Access tab already needs for stored visibility values. That's
reuse, not extra surface. Use `getMemberObjects` with `securityEnabledOnly: true` rather than
`memberOf` — it does the security-group filtering server-side and correctly, which the null
`securityEnabled` on `memberOf` cannot.

Stale stored ids are safe to render: a deleted or bogus GUID is a clean `404` on
`GET /groups/{id}` and an empty array from `getByIds` — never a hard error. The Access tab can
show "unknown group (GUID)" without special-casing.

---

## 3. The user plane — delegated `User.Read` (tested)

Probed with a **public-client** app registration carrying only the delegated `User.Read` scope,
authenticated by device-code flow as a normal (non-admin) user. **No admin consent was ever
granted to this app** — the sign-in produced an ordinary user consent prompt. Token verified
before probing: `idtyp: user`, `scp: User.Read profile openid email`, `roles: null`.

| Probe | Result |
| --- | --- |
| `GET /me` | **200** |
| `GET /me/memberOf` | **200** — 18 objects, **`id` only** (see below) |
| `GET /me/transitiveMemberOf` | **200** — 18 objects, `id` only |
| `POST /me/getMemberObjects` (`securityEnabledOnly: true`) | **200** — 6 ids |

Negative controls — what `User.Read` correctly refuses:

| Probe | Result |
| --- | --- |
| `GET /users/{another-user}` | **403** `Authorization_RequestDenied` |
| `GET /users/{another-user}/memberOf` | **403** `Authorization_RequestDenied` |
| `GET /groups?$search=…` | **403** `Authorization_RequestDenied` |
| `GET /groups` (list all) | **403** `Authorization_RequestDenied` |

This is the ideal shape for the default view: the scope answers "what am I in" and grants
**nothing** else — no other user, no directory-wide group read. It cannot substitute for the
app-only permission (search and list both 403), so the two planes are complements, not
alternatives.

**The properties are withheld, and silently.** `/me/memberOf` returns 200 with 18 group objects
in which *every* property is `null` except `id` — `displayName`, `securityEnabled`,
`groupTypes`, `mailEnabled` all come back `null`, with or without `$select`. There is no error
and no warning; a naive implementation renders 18 blank rows. Reading group *properties*
delegated needs `GroupMember.Read.All`/`Group.Read.All`/`Directory.Read.All` — all of which
require admin consent, so there is no user-consent-only path to group names.

Consequence: take **ids** from the user plane and **names** from the app-only resolver. And
prefer `getMemberObjects(securityEnabledOnly: true)`, which returned a correctly filtered 6 of
18, over filtering `memberOf` on `securityEnabled` — that field is `null` here, so such a filter
silently matches **nothing**.

*Caveat:* for this account `memberOf` and `transitiveMemberOf` both returned 18, so this run
does not independently re-demonstrate nesting — the account has no nested memberships. The
transitivity finding rests on the purpose-built fixture in §4.

---

## 4. Q4 — Is the `groups` claim transitive? **Yes.** (tested, via proxy)

Fixture: a user in `helix-probe-child`, which is a member of `helix-probe-parent`.

| Call | Contains `child` | Contains `parent` |
| --- | --- | --- |
| `memberOf` | yes | **no** |
| `transitiveMemberOf` | yes | **yes** |
| `getMemberObjects` (`securityEnabledOnly: true`) | yes | **yes** |

Reproduced identically under a delegated token and under the app-only
`GroupMember.Read.All + User.Read.All` token (7 objects both times) — the two planes agree, so
this is a property of the directory, not of the permission.

Since `getMemberObjects` with `securityEnabledOnly: true` is the documented equivalent of what
the `SecurityGroup` claim carries, **nesting expands: scoping an app to `parent` admits members
of `child`.**

**Caveat on how far this is tested.** This is the documented proxy, not an observed ID token —
the edge registration still declares no app roles, and per the ground rules I did not touch it.
Strong evidence, one inference short of direct.

**Action:** the Access tab copy "members of one directory group" is wrong, or at least
under-specifies, in a direction that silently **over-admits**. Nested security groups are
common. The copy needs to say members *and members of nested groups*.

---

## 5. Q5 — Can the permission be scoped to a subset of the directory? **No.** (read, not tested)

There is nothing to probe: Graph application permissions are tenant-wide by construction.

- **Administrative units cannot scope Graph application permissions.** AUs scope *directory
  role* assignments, not app permission grants. `Group.Read.All` / `GroupMember.Read.All` grant
  across the whole tenant regardless of AU membership. `AdministrativeUnit.Read.All` reads AUs
  themselves — it does not confine another permission to one.
- **No resource-specific consent for groups outside Teams.** RSC exists for Teams/chat
  resources (`Chat.Read.WhereInstalled` and friends); there is no general
  security-group equivalent.
- Consequently the Q1–Q3 "does scoping break `$search`" sub-question is moot.

So the negotiation with a customer admin has no bounded-ask option at the permission layer. The
mitigations are all outside consent: pick the narrower permission (§2), be precise about blast
radius (§7), and note that the read is app-only from the control plane and never from the edge.

Sources: [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference),
[Group.Read.All](https://graphpermissions.merill.net/permission/Group.Read.All),
[limiting app access with administrative units](https://www.devjev.nl/posts/2026/limiting-app-registration-access-using-administrative-units/),
[scoping User.Read.All to a subset](https://learn.microsoft.com/en-us/answers/a/1361182).

---

## 6. Q6 — Does assigning a group to an enterprise app need P1? (half-tested)

**The tenant is licensed, and group assignment works.** Assigning a *group* (not a user) to a
throwaway app's service principal succeeded:

```
POST /servicePrincipals/{sp}/appRoleAssignedTo
  principalType : Group
  appRoleId     : 00000000-0000-0000-0000-000000000000   (default access)
  -> 201, assignment created
```

Licensing present (`subscribedSkus`): an **M365 E5** SKU, which carries **Entra ID P2** (⊃ P1).
The remaining SKUs on the tenant are irrelevant to this probe and are not recorded here.

**Untested half:** I cannot produce the unlicensed error from this tenant, because this tenant
is licensed. The `ApplicationGroup` claim variant is therefore *viable here*, but its licensing
floor for a customer deployment remains unverified — a customer on a bare/E1 tenant is the case
that matters and this probe cannot speak to it. Treat "needs P1" as unconfirmed rather than
disproved.

---

## 7. Q7 — Do the two permissions differ on anything else? **No.**

No endpoint separated them. Notably:

- `GET /groups/{id}/members` → **200 under both.** "Read all group memberships" does include
  reading member lists. Worth stating plainly in the ADR's blast-radius section: the narrower-
  *sounding* permission still enumerates who is in every group in the tenant.
- Dynamic-group filtering behaved identically; no difference in `groupTypes` handling.
- No endpoint found where `GroupMember.Read.All` succeeded and `Group.Read.All` failed.

---

## 8. Verbatim consent-dialog strings

Straight from the Graph service principal's `appRoles`. Role ids in the handoff doc were all
three **correct**.

| Permission | Role id | `displayName` | `description` |
| --- | --- | --- | --- |
| `GroupMember.Read.All` | `98830695-27a2-44f7-8c18-0c3ebc9698f6` | **Read all group memberships** | Allows the app to read memberships and basic group properties for all groups without a signed-in user. |
| `Group.Read.All` | `5b567255-7703-4780-807c-7be8301ae99b` | **Read all groups** | Allows the app to read group properties and memberships, and read conversations for all groups, without a signed-in user. |
| `Directory.Read.All` | `7ab1d382-f21e-4acd-a863-ba3e13f7da61` | **Read directory data** | Allows the app to read data in your organization's directory, such as users, groups and apps, without a signed-in user. |
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` | Read all users' full profiles | — (see §2 before asking for this) |

Note the asymmetry: `Group.Read.All`'s description also grants **group conversations**, which
we have no use for. `GroupMember.Read.All` is both narrower in fact and narrower in the sentence
the admin reads.

---

## 9. Surprises

**1. This tenant forbids client secrets.** `az ad app credential reset` failed with
`Credential type not allowed as per assigned policy`. The default app management policy
(`policies/defaultAppManagementPolicy`, tenant-wide, `isEnabled: true`) restricts
`passwordAddition` **and** `symmetricKeyAddition` for both applications and service principals,
with `keyCredentials: []` — i.e. **certificates are unrestricted, secrets are banned**. The
probe was rerun with self-signed certs.

This is a live design input, not probe trivia: **the portal's Graph credential cannot be a
client secret in this tenant.** The `packages/directory` credential seam should assume a
certificate or, better, a managed identity / workload-identity federation — which is the right
answer anyway and conveniently sidesteps the policy. Worth checking whether customer tenants
apply the same restriction before assuming a secret is available anywhere.

**2. `$search` is token-based, and that is exactly why we need it.** For the term `helix`,
`$search` returned **3** groups; `startswith(displayName,'helix')` returned **2**. The extra hit
was a group whose name has "helix" as its *second* word — a prefix filter structurally cannot
find it. That is concrete evidence for the handoff's §4 Q1 worry: the `startswith` fallback is not merely
worse UX, it silently *omits matching groups*. Since `$search` works under the narrow
permission, we never have to make that trade.

**3. The zero-GUID default-access role worked fine here.** Assigning a group with
`appRoleId = 00000000-...-0` succeeded via Graph against a throwaway SP, in contrast with the
earlier experience of that pattern failing on the portal registrations. The difference is the
target app, not the permission — so past failures on that path shouldn't be read as a general
"zero-GUID doesn't work".

**4. `Group.Read.All` was not broader in any observable way.** The handoff doc expected doc
looseness around `$search`/`$count` to bite. It didn't: both permissions were identical on all
sixteen probes, advanced queries included.

**5. Graph returns `200` with a payload of nulls rather than a `403`.** The nastiest result of
the whole probe. Under delegated `User.Read`, `GET /me/memberOf` succeeds, returns the right
*number* of groups, and sets every property — `displayName` included — to `null`. No error, no
`@odata` annotation, no hint that a permission is missing. A group picker built against it
renders the correct count of blank rows, and the bug looks like a UI defect rather than a
consent one. Worse, `securityEnabled` is `null` too, so an apparently reasonable
`filter(g => g.securityEnabled)` matches **zero** groups while looking perfectly correct in
review — and `getMemberObjects` proves 6 of those 18 really are security groups. Any code
reading group properties needs a null check that fails *loudly*, because Graph will not.

**6. Probe-hygiene note for whoever runs the next one.** Where a directory role is held *via a
group* rather than assigned directly, the obvious checks lie: `roleAssignments?$filter=principalId
eq {me}` returns **empty** and `/me/memberOf` shows no `directoryRole`, both of which read as "you
are not an admin". Only `/me/transitiveMemberOf` reveals the effective role. Check that before
concluding you lack the privilege to run this probe. Also: admin
consent needs ~30–60s to propagate, and an `az` token minted too early carries `roles: null`
while the grant is already visible server-side on the SP — clear the token cache and re-mint
rather than concluding the grant failed.

---

## 10. Open items for the ADR

- Access tab copy must cover nested groups (§4).
- Implement the default view across two planes — user-plane ids, app-plane names — rather than
  paying `User.Read.All` for it (§2, §3). Requires the portal to hold the user's access token,
  or to read group ids from the sign-in token instead.
- Blast-radius paragraph should state that member enumeration is included (§7).
- Confirm the certificate/secret policy question for customer tenants before designing the
  `packages/directory` credential seam (§9.1).
- Q6's licensing floor is unverified for a low-SKU customer tenant (§6).

No Helix code was changed; this was a research errand.
