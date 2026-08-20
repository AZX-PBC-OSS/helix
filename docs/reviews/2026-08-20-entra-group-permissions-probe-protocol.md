# Handoff: Graph permission scoping for Entra group visibility

**For:** a Claude session with `az` CLI access and a test Entra tenant.
**From:** the Helix repo design conversation on per-app Entra **group visibility**.
**Status:** disposable working doc. Delete it once the findings land in an ADR.

---

## 1. Why you're being asked

Helix apps can be scoped to a directory group (`visibility: group`). The
enforcement half is already built and tested — the edge reads a `groups` claim
out of the ID token and intersects it with the app's configured group(s)
(`apps/edge/src/auth/validate.ts`, `visibilityAllows`). What is **not** built is
the identity half: today an app owner types a raw group id into a free-text box,
and in the deployed tenant the claim is empty anyway because the edge
registration declares no app roles.

The decision has been made to drive this off **Entra security groups**, not App
Roles — the entire point is to leverage groups that someone else already
manages, without touching an app registration every time a group is needed.

That forces two things:

1. The `groups` claim will carry **GUIDs**, not names. So the portal needs to
   resolve ids → display names, or every screen and audit line is hex soup.
2. Owners need a **group picker** (Mantine `MultiSelect`, server-backed search),
   so the portal needs to *search* the directory by display name.

Both are Microsoft Graph calls, made **app-only from the portal** (the control
plane — never the edge, which is deliberately dependency-minimal). Which means
asking a tenant admin for an application permission with admin consent.

**That consent ask is the expensive, politically-loaded part** — especially for a
customer deployment in a tenant we don't control. We want to ask for the
smallest permission that actually works, once, with evidence.

### The one question that matters most

> Does application permission **`GroupMember.Read.All`** support everything we
> need, or do we have to ask for the broader **`Group.Read.All`**?

The Graph docs list both as acceptable for several of these endpoints, but the
docs are known to be loose about which permission covers which *query shape*
(advanced queries with `$search` and `$count` in particular). We want empirical
HTTP status codes, not doc archaeology.

Everything else in this doc is secondary. If you run out of time or goodwill,
answer §4 Q1–Q3 and stop.

---

## 2. Ground rules

- **Run this in the org's real tenant** — the primary Entra directory, the one
  holding the `helix-*` app registrations. That is deliberate, not sloppy: an
  empty test tenant has no groups to search, no nested groups to probe for
  transitivity (Q4), and no licence SKUs (Q6), so it would answer the interesting
  questions with false negatives. A tenant is the *directory*, not the
  subscription — a fresh one is free to create but is the wrong fixture here.
- **What that costs, and why it's acceptable.** Every probe is read-only except:
  one app registration + client secret per permission, and two throwaway groups.
  Admin consent on `Group.Read.All` does create a real standing grant in the
  directory — that is the notable one, and it is the same grant the platform will
  need for real once this ships. §6 removes all of it. Do the cleanup.
- **Do not point the probes at the `helix-edge`, `helix-portal`, or CLI
  registrations, or at their service principals.** Create your own throwaway app
  and assign nothing to the real ones. If a probe seems to need a real
  registration, stop and report that instead of touching it.
- **You need Global Administrator or Privileged Role Administrator** to grant
  admin consent. If you don't have it, stop and say so — the whole probe depends
  on it.
- **Create one throwaway app registration per permission**, so each is tested in
  isolation. Granting both to one app tells you nothing about which one did the
  work.
- **Clean up afterwards** (§6). Leaving a consented `Group.Read.All` service
  principal lying around is exactly the kind of thing this exercise exists to
  avoid.
- **Report raw output.** Status codes and error bodies, not summaries. A `403`
  with `Authorization_RequestDenied` and a `400` with `Request_UnsupportedQuery`
  mean completely different things to this design.

---

## 3. Setup

### 3.1 Confirm where you are

```bash
az login
az account show --query '{tenant:tenantId, name:name, user:user.name}' -o json
TENANT=$(az account show --query tenantId -o tsv)
```

### 3.2 Look up the permission GUIDs (do not trust the ones below)

```bash
GRAPH_APP_ID=00000003-0000-0000-c000-000000000000
az ad sp show --id $GRAPH_APP_ID \
  --query "appRoles[?value=='Group.Read.All' || value=='GroupMember.Read.All' || value=='Directory.Read.All'].{value:value,id:id,desc:displayName}" \
  -o table
```

For cross-check only — **verify against the command output, these are from
memory and may be wrong**:

| Permission | Believed role id |
| --- | --- |
| `Group.Read.All` | `5b567255-7703-4780-807c-7be8301ae99b` |
| `GroupMember.Read.All` | `98830695-27a2-44f7-8c18-0c3ebc9698f6` |
| `Directory.Read.All` | `7ab1d382-f21e-4acd-a863-ba3e13f7da61` |

**While you're here:** record the exact `displayName` and `description` strings
Graph returns for each role. That text is literally what a customer's tenant
admin will read in the consent dialog, and "Read all groups" vs "Read all group
memberships" is a materially different conversation. Paste them verbatim into
the report.

### 3.3 Create two isolated probe apps

Run this twice — once with `PERM=Group.Read.All`, once with
`PERM=GroupMember.Read.All`.

```bash
PERM=GroupMember.Read.All          # then repeat with Group.Read.All
NAME=helix-probe-$(echo $PERM | tr '[:upper:].' '[:lower:]-')

ROLE_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query "appRoles[?value=='$PERM'].id | [0]" -o tsv)

APP_ID=$(az ad app create --display-name "$NAME" --query appId -o tsv)
az ad sp create --id "$APP_ID"
SECRET=$(az ad app credential reset --id "$APP_ID" --append --query password -o tsv)

az ad app permission add --id "$APP_ID" \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions "$ROLE_ID=Role"
az ad app permission admin-consent --id "$APP_ID"
```

Consent propagation is not instant — give it 30–60s before the first call.

### 3.4 Get an app-only token and **prove which permission it carries**

```bash
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
  -d client_id="$APP_ID" -d client_secret="$SECRET" \
  -d scope=https://graph.microsoft.com/.default \
  -d grant_type=client_credentials | jq -r .access_token)

# Decode the roles claim — this is the check that the isolation actually held.
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | \
  awk '{ while (length($0) % 4) $0 = $0 "="; print }' | base64 -d | jq '.roles, .aud'
```

**If `roles` shows more than the one permission you granted, the isolation is
broken — stop and fix it before running any probe.** Report the claim contents.

### 3.5 Test fixtures (needed for Q4)

Create a nested group pair and put yourself in the child, so transitivity is
observable:

```bash
MY_OID=$(az ad signed-in-user show --query id -o tsv)

CHILD=$(az ad group create --display-name helix-probe-child \
  --mail-nickname helixprobechild --query id -o tsv)
PARENT=$(az ad group create --display-name helix-probe-parent \
  --mail-nickname helixprobeparent --query id -o tsv)

az ad group member add --group "$PARENT" --member-id "$CHILD"
az ad group member add --group "$CHILD"  --member-id "$MY_OID"
```

Note both ids — you need them for the id→name resolution probe too.

---

## 4. The questions

Run **every** probe under **both** tokens. For each, record: HTTP status, and on
failure the full JSON error body (`error.code` + `error.message`).

Use `-w '\n%{http_code}\n'` on curl so the status is always visible.

---

### Q1 — Can we **search groups by display name**? (blocks: the picker)

This is the single most important probe. The picker cannot ship without it.

**Q1a — advanced query (`$search`), the shape we'd actually use:**

```bash
curl -s -w '\n%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'ConsistencyLevel: eventual' \
  'https://graph.microsoft.com/v1.0/groups?$search="displayName:eng"&$count=true&$select=id,displayName,securityEnabled&$top=10'
```

**Q1b — same call with the `ConsistencyLevel` header removed.** Expected to fail;
we want to confirm the header is mandatory so we don't ship a version that works
in one tenant and 400s in another.

**Q1c — `startswith` filter, the fallback if `$search` is denied:**

```bash
curl -s -w '\n%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/groups?\$filter=startswith(displayName,'eng')&\$select=id,displayName&\$top=10"
```

**Q1d — can we restrict results to security groups server-side?** Group
visibility is meaningless for a distribution list, and showing them in the picker
is a footgun.

```bash
curl -s -w '\n%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" -H 'ConsistencyLevel: eventual' \
  'https://graph.microsoft.com/v1.0/groups?$filter=securityEnabled+eq+true&$count=true&$select=id,displayName&$top=10'
```

And the combination of Q1a + Q1d in one request, since that's the real query.

> **Why it matters:** if `GroupMember.Read.All` can't do `$search`, the picker
> either degrades to prefix-only matching (bad UX in a big directory — nobody
> knows their group's exact prefix) or we escalate the consent ask.

---

### Q2 — Can we **resolve ids → display names**? (blocks: readable UI + audit)

We store GUIDs as the authorization value. Every screen that shows an app's
visibility, and every audit line, needs names.

**Q2a — batch resolution, the shape we'd use:**

```bash
curl -s -w '\n%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  'https://graph.microsoft.com/v1.0/directoryObjects/getByIds' \
  -d "{\"ids\":[\"$CHILD\",\"$PARENT\"],\"types\":[\"group\"]}"
```

**Q2b — single-group read, the fallback:**

```bash
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/groups/$CHILD?\$select=id,displayName,securityEnabled"
```

**Q2c — what happens for a group id that doesn't exist**, and for one that exists
but was deleted (soft-deleted objects live for 30 days). We need to know whether
a stale stored id surfaces as a clean 404, an empty array, or a hard error —
because that determines whether the Access tab shows "unknown group (GUID)" or
crashes.

> **Why it matters:** `getByIds` has a reputation for wanting `Directory.Read.All`
> even when the narrower group permissions cover `GET /groups/{id}`. If it does,
> we take the N+1 single-reads instead (cached, low volume) rather than escalate.

---

### Q3 — Can we read **a specific user's group memberships**? (blocks: the picker's default view)

The plan is for the picker to default to "groups you're a member of" and offer
full search behind it — that's the anti-lockout affordance. The portal is
app-only, so it must query by the user's object id, not `/me`.

```bash
# direct memberships
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$MY_OID/memberOf?\$select=id,displayName&\$top=50"

# transitive memberships
curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$MY_OID/transitiveMemberOf?\$select=id,displayName&\$top=50"

# the id-only form — also the documented overage-resolution endpoint
curl -s -w '\n%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "https://graph.microsoft.com/v1.0/users/$MY_OID/getMemberObjects" \
  -d '{"securityEnabledOnly": true}'
```

Note whether reading `/users/{id}` at all needs `User.Read.All` on top — if the
memberships endpoints work but require a *second* permission, that changes the
consent ask and we may drop the default view rather than pay for it.

> **Why it matters twice:** `getMemberObjects` is also the endpoint Entra points
> at when a user exceeds the ~200-group claim limit and the token carries
> `_claim_names` instead of `groups`. Whether we can call it decides whether the
> overage path is ever fixable, and from which plane.

---

### Q4 — Is the `groups` claim **transitive**? (blocks: what we tell users the mode means)

If a user is in `helix-probe-child`, and `helix-probe-child` is a member of
`helix-probe-parent`, does scoping an app to **parent** admit that user?

Compare, for `$MY_OID`, using the three calls in Q3:

- Does `memberOf` contain `$PARENT`?
- Does `transitiveMemberOf` contain `$PARENT`?
- Does `getMemberObjects` (`securityEnabledOnly: true`) contain `$PARENT`?

`getMemberObjects` with `securityEnabledOnly: true` is the documented equivalent
of what the `SecurityGroup` claim carries, so **its answer is the one that
predicts real token behavior** — but report all three, because a disagreement
between them is itself a finding.

> **Why it matters:** this is a user-facing semantic. The Access tab copy
> currently promises "members of one directory group", and if nesting is expanded
> that sentence is wrong in a way that could silently over-admit. Nested security
> groups are extremely common in real directories.

---

### Q5 — Can the permission be **scoped to a subset of the directory**?

Research + verify, in that order. A tenant admin who balks at "read all groups"
may accept "read these groups". Specifically:

- Can an application permission like `Group.Read.All` be **scoped to an
  administrative unit** rather than tenant-wide? (I believe Entra has shipped or
  previewed something here; confirm current GA status, don't take my word.)
- Is there any resource-specific-consent equivalent for groups outside Teams?
- If scoping exists, does it survive the query shapes in Q1–Q3, or does a scoped
  permission break `$search`?

Report the current state with a doc link and, if it's available in the tenant, an
actual probe.

> **Why it matters:** this is the difference between "sign here for tenant-wide
> group read" and a bounded ask, in a negotiation with a customer's admin who has
> every reason to say no.

---

### Q6 — Does assigning a **group** to an enterprise app need Entra ID P1?

There's a third design option on the table — the `ApplicationGroup`
(`"Groups assigned to the application"`) claim variant, which emits only groups
assigned to the edge enterprise app. It kills the >200-group overage problem
outright and gives an admin-curated candidate set. It's not the default plan
(it reintroduces "an admin must touch config per group") but it's a live
operator option, and its whole viability hinges on licensing.

```bash
# What's actually licensed in this tenant?
az rest --method get --url 'https://graph.microsoft.com/v1.0/subscribedSkus' \
  --query 'value[].{sku:skuPartNumber, state:capabilityStatus}' -o table

# Try assigning a GROUP (not a user) to some app's SP and see whether it errors.
# Use a throwaway app's own SP as the target — not helix-edge.
```

Report: the tenant's SKUs, whether P1/P2 is present, and — if you can test it —
the exact error when a group assignment is attempted without a qualifying
licence.

---

### Q7 — Do the two permissions differ on **anything else we'd want later**?

Quick sweep, low priority, but cheap while you have both tokens:

- `GET /v1.0/groups/{id}/members?$select=id,displayName` — do we get member
  lists? (We don't need this today. Knowing whether the permission *grants* it
  matters for how we describe blast radius in the ADR.)
- `GET /v1.0/groups?$filter=groupTypes/any(c:c eq 'DynamicMembership')` — do
  dynamic groups behave differently?
- Any endpoint where `GroupMember.Read.All` succeeds and `Group.Read.All` fails
  (I don't expect one, but a surprise here is worth knowing).

---

## 5. What to report back

A markdown report with:

**1. The results matrix** — the load-bearing artifact:

| Probe | `GroupMember.Read.All` | `Group.Read.All` |
| --- | --- | --- |
| Q1a `$search` groups | | |
| Q1b `$search` w/o ConsistencyLevel | | |
| Q1c `startswith` filter | | |
| Q1d `securityEnabled` filter | | |
| Q2a `getByIds` | | |
| Q2b `GET /groups/{id}` | | |
| Q2c stale / deleted id | | |
| Q3 `memberOf` | | |
| Q3 `transitiveMemberOf` | | |
| Q3 `getMemberObjects` | | |
| Q7 `/groups/{id}/members` | | |

Cells: HTTP status. On any non-2xx, the `error.code` too.

**2. A recommendation, in one paragraph** — which permission we ask for, and the
single probe result that decides it.

**3. Answers to Q4, Q5, Q6** in prose, with doc links where you researched rather
than tested. **Mark clearly which claims are tested and which are read.** A
tested `403` is worth more than three paragraphs of documentation.

**4. The verbatim consent-dialog strings** for both permissions (from §3.2).

**5. Anything that surprised you.** Especially: an endpoint that worked when it
shouldn't have, a permission that turned out to be broader than its name, or a
tenant-specific setting that changed a result. Surprises here are exactly what we
can't discover from the repo.

Do not attempt to implement anything in the Helix codebase from that session —
this is a research errand, and the design conversation it feeds is still open.

---

## 6. Cleanup

```bash
# Probe apps (run for each APP_ID you created)
az ad app delete --id "$APP_ID"

# Fixture groups
az ad group delete --group "$PARENT"
az ad group delete --group "$CHILD"
```

Then confirm nothing consented survives:

```bash
az ad sp list --filter "startswith(displayName,'helix-probe')" \
  --query '[].{name:displayName, id:id}' -o table
```

Deleted app registrations sit in the soft-deleted bin for 30 days. **Purge them**
— this is the org's live directory, not a scratch tenant:

```bash
az rest --method get \
  --url 'https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.application?$select=id,displayName' \
  --query "value[?starts_with(displayName,'helix-probe')].{name:displayName,id:id}" -o table

# then, per id returned above:
az rest --method delete \
  --url "https://graph.microsoft.com/v1.0/directory/deletedItems/<object-id>"
```

Confirm the consent grant is gone too — the service principal deletion should
take its `oauth2PermissionGrants` / `appRoleAssignments` with it, but verify
rather than assume, since that standing grant is the one durable side effect of
this whole exercise.

---

## 7. Context you may want

Relevant files, if the session has the repo checked out:

- `packages/shared/src/visibility.ts` — the `Visibility` union; `group` carries a
  single `groupId` today (a move to N groups is under discussion).
- `apps/edge/src/auth/validate.ts` (`visibilityAllows`) — the enforcement point.
- `apps/edge/src/config.ts` (~line 469) — `EDGE_OIDC_GROUPS_CLAIM`, default
  `groups`, overridden to `roles` in the deployed stack.
- `infra/entra/main.bicep` — the three app registrations; note line ~107, "No app
  roles for the pilot", which is why `group` visibility is currently inert.
- `docs/runbooks/entra-app-registration.md` — the "Deferred (until needed)"
  section is precisely the decision this probe unblocks.
- `packages/secret-store/` — the intended template for a `packages/directory`:
  zero runtime dependencies, hand-rolled REST over global `fetch`, credential
  injected as a one-function seam.

Keep customer and client names out of anything written back into the repo — it's
headed for open source.
