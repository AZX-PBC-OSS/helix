# Runbook: turning on Entra group claims + the Graph group permission

The **tenant-side** half of [ADR-0040](../adr/0040-entra-group-visibility-directory-seam.md).
Run this where you have `az` and a directory admin role. It is self-contained — you
should not need the repo open, only the resource group name.

**What you are changing, in one paragraph.** Per-app group visibility has been built
and inert since M3. The gate works; nothing ever put groups on a token for it to read.
This makes both registrations emit the caller's security-group GUIDs as a `groups`
claim, grants the portal's managed identity **one** Microsoft Graph permission
(`GroupMember.Read.All`) so a future picker can turn those GUIDs into names, and
re-points the edge at the `groups` claim instead of the empty `roles` one.

**What you are not changing.** Portal admin gating stays on the `platform-admin` App
Role in the `roles` claim — different registration, different claim, no collision.
No app changes visibility. No user gains or loses access to anything, because the
edge's group claim is empty today and setting an app to `group` visibility currently
denies everyone including its owner. The worst case here is that group visibility
stays as broken as it already is.

**Done when:** §1 through §7 are green and you have written the §6 number down.

---

## §0 — Setup and the one hard precondition

```bash
RG=<resource-group>              # e.g. helix-prod-rg
PREFIX=helix-prod                # namePrefix from infra/azure/main.bicepparam
az account show --query "{tenant:tenantId,sub:name}" -o table
```

A JWT decoder you will want three times:

```bash
jwtdec() { python3 -c "import base64,json,sys;p=sys.argv[1].split('.')[1];print(json.dumps(json.loads(base64.urlsafe_b64decode(p+'='*(-len(p)%4))),indent=2))" "$1"; }
```

### The precondition: the running portal image must union `groups` and `roles`

This is the only step in this document that can break production, and it breaks it
quietly. `apps/portal/src/auth/verifier.ts` used to read
`payload.groups ?? payload.roles` — a fallback, not a union. Today portal tokens carry
no `groups`, so the fallback fires and `roles` delivers `platform-admin`. **The moment
§2/§3 adds a groups claim to the portal registration, `groups` becomes truthy, `roles`
is discarded, and every platform admin loses the approvals queue and every admin
page** — caused by an Entra-side config change, with no deploy to correlate it against.

Commit `abb6912` replaced that with `unionClaimArrays`. Confirm the **deployed** image
has it — committed is not deployed:

```bash
az containerapp show -g "$RG" -n "$PREFIX-portal" \
  --query "properties.template.containers[0].image" -o tsv
```

Compare that tag against a build at or after `abb6912`. If you cannot establish it,
ask the running portal directly — this endpoint is public and needs no token:

```bash
curl -s "https://portal.<appsDomain>/health"   # liveness only; use it to confirm which revision answers
az containerapp revision list -g "$RG" -n "$PREFIX-portal" \
  --query "[?properties.active].{rev:name,image:properties.template.containers[0].image,created:properties.createdTime}" -o table
```

**If the portal image is older than `abb6912`: do the edge half only.** The edge
registration change (§2/§3, edge lines) is completely independent and safe — the edge
reads one configured claim name and has no union to get wrong. Deploy a current portal
image, then come back for the portal lines. Doing them out of order is the one
sequencing mistake this document exists to prevent.

---

## §1 — Discovery: are the registrations Bicep-mastered or hand-made?

This decides which of §2 and §3 you run, and it takes 30 seconds. `infra/entra/main.bicep`
declares the registrations, but the Graph Bicep extension keys `applications` on
`uniqueName`, which portal-created apps do not have. Point the stack at hand-made apps
and it creates **duplicates** rather than adopting them.

```bash
az rest --method GET \
  --url 'https://graph.microsoft.com/v1.0/applications?$select=id,appId,displayName,uniqueName,groupMembershipClaims&$top=999' \
  --query "value[?starts_with(displayName,'helix') || starts_with(displayName,'azx')].{name:displayName,appId:appId,objectId:id,uniqueName:uniqueName,groupClaims:groupMembershipClaims}" \
  -o table
```

> `uniqueName` is returned **only** when explicitly `$select`ed. Without it every row
> shows blank and you will conclude "hand-made" incorrectly. The `$select` above is
> not optional.

Read the result:

| What you see | Which world | Go to |
| --- | --- | --- |
| `uniqueName` populated, names like `helix-prod-edge` / `helix-prod-portal` / `helix-prod-cli` | **Bicep-mastered** | **§2 Path A** |
| `uniqueName` blank, names like `helix-edge` / `helix-portal` / `azx-cli` | **Hand-made** (the original pilot set) | **§3 Path B** |
| Both sets present | You have duplicates already — see the note below | — |

Cross-check with the deployment history; a Bicep-managed Entra stack leaves a record:

```bash
az deployment group list -g "$RG" \
  --query "[].{name:name,ts:properties.timestamp,state:properties.provisioningState}" -o table
az deployment group show -g "$RG" -n <the-entra-deployment> --query properties.outputs
```

**If both sets exist**, the question is which one the running platform actually uses.
That is settled by the containers, not by the directory:

```bash
az containerapp show -g "$RG" -n "$PREFIX-edge" \
  --query "properties.template.containers[0].env[?name=='EDGE_OIDC_CLIENT_ID'].value" -o tsv
az containerapp show -g "$RG" -n "$PREFIX-portal" \
  --query "properties.template.containers[0].env[?name=='PORTAL_OIDC_AUDIENCE'].value" -o tsv
```

Match those GUIDs to `appId` in the table above and apply the change to **those**
registrations only. Whichever set is unused is cleanup for another day; do not touch it
now, and do not delete anything in this session.

Capture the ids you need either way:

```bash
EDGE_OBJ=<objectId of the edge registration>       # the "id" column, NOT appId
PORTAL_OBJ=<objectId of the portal registration>
```

---

## §2 — Path A: the registrations are Bicep-mastered

Work from a clone of the repo at a commit containing this document.

```bash
cd infra/entra
az bicep build --file main.bicep     # compile check; pulls the microsoftGraphV1 extension
```

Get the portal identity, which the Graph grant hangs on:

```bash
export HELIX_PORTAL_IDENTITY_PRINCIPAL_ID=$(az identity show \
  -g "$RG" -n "$PREFIX-portal-id" --query principalId -o tsv)
echo "$HELIX_PORTAL_IDENTITY_PRINCIPAL_ID"     # must be non-empty
```

Export whatever else `main.bicepparam` reads (`HELIX_EDGE_CERT_BASE64`,
`HELIX_ADMIN_PRINCIPAL_ID`) **to the same values as the last deploy** — they are
`readEnvironmentVariable(..., '')`, so an unset var silently deploys as empty and can
drop a keyCredential or a role assignment you meant to keep.

Dry run first, and actually read it:

```bash
az deployment group what-if -g "$RG" -f main.bicep -p main.bicepparam
```

You are looking for **modify** on the two applications and **create** on one
`appRoleAssignedTo`. If you see **create** on the applications themselves, the
`namePrefix` does not match the live `uniqueName`s and you are about to make
duplicates — stop, fix `namePrefix`, re-run.

```bash
az deployment group create -g "$RG" -f main.bicep -p main.bicepparam
```

Then skip to §4.

> If the deploy fails on the `appRoleAssignedTo` with `Authorization_RequestDenied`,
> your deploy principal can manage apps but not consent. Application Administrator is
> not enough; you need **Privileged Role Administrator** or **Global Administrator**
> (or `AppRoleAssignment.ReadWrite.All`). Either escalate, or run just the grant from
> §3.3 under an account that has it — the two produce the identical object.

---

## §3 — Path B: the registrations are hand-made

Same end state, applied directly. `az rest` rather than `az ad app update --set`,
because `--set` on nested manifest properties has bitten us before and the PATCH body
is unambiguous. All three commands are idempotent.

### 3.1 The edge registration

```bash
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/$EDGE_OBJ" \
  --body '{"groupMembershipClaims":"SecurityGroup"}'
```

### 3.2 The portal registration

**Only if §0's precondition passed.**

```bash
az rest --method PATCH \
  --url "https://graph.microsoft.com/v1.0/applications/$PORTAL_OBJ" \
  --body '{"groupMembershipClaims":"SecurityGroup"}'
```

Read both back:

```bash
for O in "$EDGE_OBJ" "$PORTAL_OBJ"; do
  az rest --method GET \
    --url "https://graph.microsoft.com/v1.0/applications/$O?\$select=displayName,groupMembershipClaims" \
    --query "{name:displayName,claims:groupMembershipClaims}" -o tsv
done
```

### 3.3 `GroupMember.Read.All` for the portal's managed identity

The grantee is the **managed identity**, not any registration — it already exists, has
nothing to rotate, and sidesteps this tenant's policy banning client secrets.

```bash
GRAPH_SP=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
MI_SP=$(az identity show -g "$RG" -n "$PREFIX-portal-id" --query principalId -o tsv)
ROLE=98830695-27a2-44f7-8c18-0c3ebc9698f6      # GroupMember.Read.All (application)

az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$MI_SP/appRoleAssignments" \
  --body "{\"principalId\":\"$MI_SP\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$ROLE\"}"
```

**This POST is the admin consent.** There is no "Grant admin consent" button to press
afterwards, and there is nothing to press it on — a managed identity has no
API-permissions blade. Read it back:

```bash
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$MI_SP/appRoleAssignments" \
  --query "value[].{role:appRoleId,resource:resourceDisplayName,id:id}" -o table
```

Expect exactly one row with `98830695-…` against Microsoft Graph. A second POST returns
a duplicate-assignment error, which is a safe no-op.

> **Drift.** Path B leaves the tenant ahead of `infra/entra/main.bicep`, which now
> declares all three of these. That is a known, acceptable gap for hand-made apps
> (README wart #3) — worth an issue, not worth blocking on.

---

## §4 — Prove the grant works, before any code depends on it

`packages/directory` is the code that will make these calls in anger
(`EntraDirectory`, portal-only). This step checks the same credential path by hand,
using the real managed identity in the real container, **before** the portal has any
reason to try it — so a failure here is a tenant answer rather than a bug hunt
through the control plane. It is the cheapest possible de-risking of ADR-0040
decision 4 and worth the five minutes.

If the portal is already running this code, the same answer is available without
`exec`: `GET /api/v1/directory/groups?q=<term>` returns `available: false` with
`reason: "no-consent"` when the grant is missing, and the Access tab shows a banner
naming the permission. The probe below is still worth running first, because it
distinguishes "not propagated yet" from "not granted" — which the endpoint does not.

Allow **30–60 seconds** for the grant to propagate first. A token minted too early
carries `roles: null` while the assignment is already visible on the SP — re-mint,
don't re-grant.

```bash
az containerapp exec -g "$RG" -n "$PREFIX-portal" --command sh
```

Inside the container (`node:24-bookworm-slim`, so `node` is guaranteed present even if
`curl` is not) paste this, changing `eng` to a term that matches a real group:

```sh
node -e '
(async () => {
  const t = await (await fetch(
    `${process.env.IDENTITY_ENDPOINT}?resource=https://graph.microsoft.com&client_id=${process.env.AZURE_CLIENT_ID}&api-version=2019-08-01`,
    { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER } })).json();
  const claims = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64url"));
  console.log("roles on the MI token:", claims.roles);

  const r = await fetch(
    `https://graph.microsoft.com/v1.0/groups?$search="displayName:eng"&$count=true&$select=id,displayName,securityEnabled&$top=5`,
    { headers: { Authorization: `Bearer ${t.access_token}`, ConsistencyLevel: "eventual" } });
  console.log("search:", r.status, JSON.stringify(await r.json()).slice(0, 600));
})()'
```

**Expected:** `roles: [ "GroupMember.Read.All" ]` and `search: 200` with hits.

Three failures worth recognising rather than debugging blind:

| Symptom | Meaning |
| --- | --- |
| `roles: null` or `roles: undefined` | Grant not propagated yet, or applied to the wrong identity. Wait 60s and re-run before touching anything. |
| `403 Authorization_RequestDenied` | The grant is genuinely missing. Re-check §3.3's read-back. |
| `400 Request_UnsupportedQuery` | The `ConsistencyLevel: eventual` header was dropped. `$search` **requires** it. |

While you are in there, confirm the two degradations ADR-0040 decision 8 leans on —
a bogus GUID must be a clean `404`, and `getByIds` on it a `200` with an empty array,
never a hard error:

```sh
node -e '
(async () => {
  const t = await (await fetch(
    `${process.env.IDENTITY_ENDPOINT}?resource=https://graph.microsoft.com&client_id=${process.env.AZURE_CLIENT_ID}&api-version=2019-08-01`,
    { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER } })).json();
  const h = { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" };
  const bogus = "00000000-1111-2222-3333-444444444444";
  console.log("GET bogus:", (await fetch(`https://graph.microsoft.com/v1.0/groups/${bogus}`, { headers: h })).status);
  const g = await fetch("https://graph.microsoft.com/v1.0/directoryObjects/getByIds",
    { method: "POST", headers: h, body: JSON.stringify({ ids: [bogus], types: ["group"] }) });
  console.log("getByIds:", g.status, JSON.stringify(await g.json()));
})()'
```

Type `exit` to leave the container.

---

## §4b — Searching a real tenant from a developer machine

**The grant in §3.3 cannot help a local portal, and this is the trap that costs
an afternoon.** It is assigned to the portal container app's *user-assigned
managed identity*, and a managed identity's token endpoint exists only inside
Azure. A laptop or devcontainer cannot borrow it. So a developer who has pointed
their portal at real Entra for **auth** (via `apps/portal/.env.local`) still has
no Graph credential for **search** — and before `PORTAL_DIRECTORY` existed they
silently got the dev fixture groups instead: searching their real tenant returned
nothing, searching `eng` returned convincing fakes, and nothing said why.

The portal now names its backend at boot. Check that line first:

```
directory provider: dev fixtures (no AZURE_CLIENT_ID) — NOT your real directory; …
directory provider: Microsoft Graph (PORTAL_DIRECTORY=entra)
directory provider: Microsoft Graph (managed identity via AZURE_CLIENT_ID)
```

Three ways to get real results locally, cheapest first:

1. **Don't — use the deployed portal.** The identity holding the grant lives
   there. Nothing to create, and it exercises the real production path rather
   than an approximation of it. Best answer for *verifying* the feature.
2. **`az login` as yourself**, plus `PORTAL_DIRECTORY=entra`. No new credential,
   but note it yields a **delegated (user) token**: what you can read is your own
   directory rights, not the app role. A directory admin will usually get
   results; an ordinary user gets `403 Authorization_RequestDenied`, which shows
   up as the Access tab's banner. It does **not** validate the production path.
3. **A dev app registration with its own `GroupMember.Read.All` grant**, then
   `PORTAL_DIRECTORY=entra` plus `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
   `AZURE_CLIENT_CERTIFICATE_PATH`. Use a **certificate, not a secret** — this
   tenant's app management policy bans password credentials (`passwordAddition`
   restricted) while `keyCredentials` is unrestricted (probe §2). This mirrors
   production most closely and is also the only option that adds durable
   credential surface to a laptop; weigh that before choosing it.

Setting the `AZURE_*` variables above is safe for the rest of the portal: Blob
auth selects on `AZURE_STORAGE_BLOB_ENDPOINT` and Key Vault custody on
`AZURE_KEY_VAULT_URL`, so neither is disturbed by a Graph credential.

If Graph refuses, the endpoint says which problem you have rather than returning
an empty list — `reason: "no-credential"` (the portal cannot authenticate; your
problem) versus `reason: "no-consent"` (the grant is missing; a directory
administrator's problem). They are deliberately distinct because they send you to
different people.

---

## §5 — Verify the claims actually land, per token type

`groupMembershipClaims` is documented to cover both the ID token and the access token.
Confirm it rather than assume it — the two consumers read different tokens.

### Edge (ID token)

Sign in to any `internal` app at `https://<slug>.<appsDomain>`. The edge reads only the
ID token and never surfaces it, so read it from the edge's logs or from the auth-host
callback in browser devtools:

```bash
az containerapp logs show -g "$RG" -n "$PREFIX-edge" --tail 100 --follow
```

Simplest positive signal: `visibility: group` now works. Set a test app to a real group
GUID via the portal Access tab, sign in as a member (expect the app), and as a
non-member (expect denial). **Do this after §7**, since the edge is still reading
`roles` until then.

### Portal (access token) — the one that matters

`helix login` caches to `~/.config/helix/tokens.json`, keyed by portal origin
(`packages/cli/src/auth/tokenStore.ts`):

```bash
helix login
TOK=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.config/helix/tokens.json')));print(next(iter(d['byPortal'].values()))['tokens']['accessToken'])")
jwtdec "$TOK"
```

(That takes the first cached portal; if you have several, index `d['byPortal']` by the
origin you want.) In the decoded payload confirm **both**:

- `"groups": ["<guid>", …]` — present, and GUIDs
- `"roles": ["platform-admin"]` — **still present** for an admin account

Both together is the exact condition `unionClaimArrays` exists for. Then prove the
gate still holds by using it, not by reading it:

```bash
helix whoami          # should still report you
curl -s -H "Authorization: Bearer $TOK" https://portal.<appsDomain>/api/v1/me
```

`isAdmin: true` in that response is the real assertion. **If it flipped to `false`,
the portal image predates `abb6912`** — go straight to §9 and revert the portal
registration, then deploy a current image.

> **If `groups` shows up in the ID token but not the access token**, add an explicit
> optional claim to the portal registration and re-check:
> ```bash
> az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$PORTAL_OBJ" \
>   --body '{"optionalClaims":{"idToken":[{"name":"email","essential":false}],"accessToken":[{"name":"email","essential":false},{"name":"groups","essential":false}]}}'
> ```
> Note this PATCH **replaces** `optionalClaims` wholesale, so the `email` entries are
> repeated above deliberately — dropping them would quietly remove the email claim.
> Mirror it into `infra/entra/main.bicep` if you need it, and say so in the handback.

---

## §6 — Measure the access token, and write the number down

ADR-0040 flags this as a real unknown rather than a formality: group GUIDs ride the
`Authorization` header, and Node's default max header size is 16KB. Just under Entra's
~200-group overage threshold that is roughly 7KB of extra header — probably fine, a
hard request rejection if not.

```bash
echo -n "$TOK" | wc -c          # $TOK from §5
jwtdec "$TOK" | python3 -c "import json,sys;d=json.load(sys.stdin);print('groups in claim:', len(d.get('groups',[])))"
```

Record both numbers in the handback. Measure with **the most group-heavy account you
can find**, not your own, or the number means nothing. If the claim is replaced by
`_claim_names` / `_claim_sources`, that account has tripped the ~200-group overage:
v1 does not resolve it, the edge fails closed (denies), and you should note the account
so the eventual overage logging has a real reproduction.

---

## §7 — Point the edge at the `groups` claim

Only after §2/§3 succeeded on the **edge** registration. Until now the edge has been
reading `EDGE_OIDC_GROUPS_CLAIM=roles`, and with no app roles declared that claim is
empty for everyone.

First, check what changes behaviour. Any app already on `group` visibility holds an
App-Role-shaped string that will not match a GUID:

```sql
select slug, visibility_mode, visibility_group_id from apps where visibility_mode = 'group';
```

Expect zero rows — the mode denies everyone today, so nothing should be using it. Any
row you do find stays denied after this change and needs re-pointing at a real group
GUID; note it in the handback.

Then flip it. Via the repo (preferred — keeps the template and the tenant in step):

```bash
az deployment group create -g "$RG" -f infra/azure/main.bicep -p infra/azure/main.bicepparam
```

Or as a direct revision, if you want it isolated from everything else pending in that
template:

```bash
az containerapp update -g "$RG" -n "$PREFIX-edge" \
  --set-env-vars EDGE_OIDC_GROUPS_CLAIM=groups
```

Confirm the new revision is serving, then run the §5 edge check.

```bash
az containerapp show -g "$RG" -n "$PREFIX-edge" \
  --query "properties.template.containers[0].env[?name=='EDGE_OIDC_GROUPS_CLAIM'].value" -o tsv
```

> Local development is unaffected: `apps/dev-idp` emits readable strings (`eng-team`)
> and the edge code default is already `groups`. If you keep an `apps/edge/.env.local`
> for testing locally against real Entra, it carries `EDGE_OIDC_GROUPS_CLAIM=roles` and
> is gitignored — change it by hand or it will keep masking this.

---

## §8 — Hand back

Four facts unblock the code work (TODO.md item "Wire Entra group visibility"):

1. **Path A or Path B** — i.e. whether `infra/entra/main.bicep` is now the source of
   truth or is drifted from the tenant.
2. **The §6 numbers** — access token bytes and group count, and which account.
3. **Whether §4 returned 200** on `$search`, and whether the `optionalClaims`
   contingency in §5 was needed.
4. **Any row from §7's query** — an app stranded on a stale group value.

---

## §8.5 — Decide the search posture (optional, but decide it out loud)

Once the grant is live, `GET /api/v1/directory/groups` lets **every authenticated portal
principal** turn a three-letter term into group display names from anywhere in the tenant.
That is ADR-0040's shipped default and it is deliberate; it is also the thing a customer
security team is most likely to push back on, and it is entirely ours to change — nothing
here needs re-consenting.

`PORTAL_DIRECTORY_SEARCH` (ADR-0040 decision 11) takes:

| Value | Who may search | Everything else |
| --- | --- | --- |
| `everyone` | any signed-in principal | the default; unset means this |
| `admins` | holders of `PORTAL_ADMIN_GROUP_ID` | others keep own-groups + stored names + add-by-id |
| `none` | nobody | same as above, for everyone |

```bash
az containerapp update -g "$RG" -n "$PREFIX-portal" \
  --set-env-vars PORTAL_DIRECTORY_SEARCH=admins
```

Two things to know before you set it:

- It gates **search only**. Name resolution is never gated, so a restricted operator still
  sees their own groups and the app's stored groups *by name* and can still add any group
  by id. They lose discovery of groups they are not in, and nothing else.
- `admins` needs `PORTAL_ADMIN_GROUP_ID` set, or **nobody** qualifies and search is off for
  everyone. The portal names the resolved tier in its boot log (`directory provider: …;
  search: …`) — check it after the deploy rather than assuming.

Verify with two accounts:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://portal.<appsDomain>/api/v1/me" | jq .canSearchDirectory
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "https://portal.<appsDomain>/api/v1/directory/groups?q=eng"   # 200 admin, 403 non-admin
```

Rollback is `PORTAL_DIRECTORY_SEARCH=everyone` (or unsetting it) — no token churn, no
consent change.

---

## §9 — Rollback

Both changes are single calls with no data migration behind them, and nothing in the
platform reads the new claim until §7.

```bash
# Stop emitting the groups claim (per registration)
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$PORTAL_OBJ" \
  --body '{"groupMembershipClaims":"None"}'
az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$EDGE_OBJ" \
  --body '{"groupMembershipClaims":"None"}'

# Revoke the Graph permission
ASSIGN_ID=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$MI_SP/appRoleAssignments" \
  --query "value[?appRoleId=='98830695-27a2-44f7-8c18-0c3ebc9698f6'].id | [0]" -o tsv)
az rest --method DELETE \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$MI_SP/appRoleAssignments/$ASSIGN_ID"

# Put the edge back on the (empty) roles claim
az containerapp update -g "$RG" -n "$PREFIX-edge" --set-env-vars EDGE_OIDC_GROUPS_CLAIM=roles
```

Reverting the **portal** registration is the urgent one if admin gating breaks; it
takes effect on the next token, so sign out and back in rather than waiting.

---

## Background

- [ADR-0040](../adr/0040-entra-group-visibility-directory-seam.md) — the decisions and
  why each alternative lost.
- [`docs/reviews/2026-08-20-entra-group-permissions-probe.md`](../reviews/2026-08-20-entra-group-permissions-probe.md)
  — the sixteen-probe evidence base, including the verbatim consent strings and the
  `200`-with-null-properties trap.
- [`docs/runbooks/entra-app-registration.md`](entra-app-registration.md) — creating the
  registrations in the first place.
- [`infra/entra/README.md`](../../infra/entra/README.md) — the Bicep stack and its warts.
