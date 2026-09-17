---
title: Entra ID setup
---

# Microsoft Entra ID setup

Helix signs users in through OIDC. Locally it uses a bundled fake issuer; on a
real deployment it points at your own Microsoft Entra tenant. Both services
speak generic OIDC with discovery, so setup is creating three app
registrations and putting their ids in the deploy configuration.

Single-tenant only: your own users. The issuer is
`https://login.microsoftonline.com/{tenantId}/v2.0`.

There are two ways to create the registrations:

- **The Bicep module in `infra/entra`** — preferred for a new deployment. It
  creates all three registrations with every setting below already correct,
  and can also assign the admin role, consent the scopes, and grant the Graph
  permission the group picker needs. [Start here.](#the-automated-way)
- **By hand in the Azure Portal** — if you cannot run the module (it needs
  elevated Graph rights), or want to check what the module does and why. The
  result is identical. [Manual setup.](#the-manual-way)

Substitute your apps domain for `apps.example.com` throughout.

## The automated way

`infra/entra/main.bicep` declares the three registrations via the
[Microsoft Graph Bicep extension](https://learn.microsoft.com/graph/templates/bicep/):

| Registration | What it declares |
| --- | --- |
| `helix-edge` | Web redirect URI, `email` optional claim, certificate credential for `private_key_jwt`, security-group claims |
| `helix-portal` | SPA redirect URI, **v2 access tokens** (set here — the manual process's main gotcha), the `access` scope, the `platform-admin` and `user` app roles |
| `helix-cli` | Public client (device code flow), permission to request the portal's `access` scope |

It also optionally declares, from parameters:

- **The admin role assignment** — set `adminPrincipalId` to a user or group
  object id instead of assigning it in the portal.
- **Tenant-wide admin consent** for the sign-in and Graph scopes — set
  `grantAdminConsent=true`.
- **The `GroupMember.Read.All` Graph permission for the portal's managed
  identity** — what the per-app group picker uses to turn group ids into
  names. Set `portalIdentityPrincipalId` to the portal identity's principal id
  (a deployment output of the Azure stack, available only after it has
  deployed). Declaring the assignment **is** the admin consent; there is no
  separate approval step.
- **Sign-in restrictions** — `edgeAccessPrincipalIds` / `portalAccessPrincipalIds`
  limit who can sign in at all. Empty keeps the default open behaviour. See
  [Access control](/deploy/access-control) for the recommended group layout and
  what gating changes.

Deploy:

```bash
cd infra/entra
az bicep build --file main.bicep            # compile check
az deployment group create -g <rg> -f main.bicep -p main.bicepparam

# One known wart: the portal's identifier URI can't self-reference its client
# id in Bicep, so set it once by hand:
az ad app update --id <portalClientId> --identifier-uris "api://<portalClientId>"
```

The ordering with the Azure stack is **entra → azure → entra**: deploy this
first, pass the outputs (`edgeOidcClientId`, `portalOidcAudience`,
`azxWebClientId`, `azxCliClientId`) into the Azure stack's parameters, then
re-apply this module with `portalIdentityPrincipalId` set to grant the Graph
permission.

Before you rely on it, know:

- **Your deploy principal needs Graph rights.** Creating registrations needs
  Application Administrator; the consent and role assignments need Privileged
  Role Administrator (or `AppRoleAssignment.ReadWrite.All`). A locked-down
  tenant can resist this — verify first.
- **Conditional Access can block the Graph calls.** If your tenant requires a
  compliant device, every `az ad …` and Graph-Bicep step fails with
  `AADSTS53003` from an unenrolled machine — ARM calls are unaffected. Run
  the Entra work from a compliant host.
- **It does not adopt registrations that already exist.** A deployment against
  a tenant with hand-made apps creates duplicates. Use it for a fresh
  environment.
- **The `groups` claim on the portal registration requires a running portal
  image that unions the `groups` and `roles` claims** — applying it against an
  older portal image locks admins out of the approval queue. The sequencing is
  spelled out in
  [the group claims rollout doc](https://github.com/AZX-PBC-OSS/helix/blob/main/docs/runbooks/entra-group-claims-rollout.md).

The outputs feed the Azure stack parameters listed in
[the manual section](#what-the-deployment-consumes) — same values, captured
instead of typed.

### Re-applying this stack

The module is safe to re-apply — it adopts existing objects rather than
duplicating them, and leaves undeclared assignments and properties alone — but
three habits from the platform stack do not transfer:

- **what-if is blind here.** Every Graph resource comes back
  `ExtensibleResourceNotSupported` with `potentialChanges: null`, and the run
  still reports `Succeeded` — a clean-looking preview that tells you nothing.
  Run it as a compile check only; never reason about an apply from its output.
- **The elevated Graph role is needed every time, active at `az login`.** The
  consent grants and `appRoleAssignedTo` objects need Global Administrator or
  Privileged Role Administrator (or `AppRoleAssignment.ReadWrite.All`), and a
  role activated *after* signing in is invisible to the cached token — elevate
  first, then `az login`.
- **Pass the edge certificate on every apply.** `edgeCertificateBase64`
  defaults to empty, and empty renders `keyCredentials: []` — a re-apply
  without it strips the certificate off the edge registration and
  `private_key_jwt` sign-in breaks for every user until it is restored.

Two smaller ones:

- **Never hand-edit or hand-delete the portal's template-owned `user` role.**
  Entra refuses to remove an app role that is still enabled or still assigned,
  so a diverged role takes three writes in order — delete the assignment,
  PATCH it `isEnabled: false`, then PATCH it away. Leaving it to the template
  avoids the dance.
- **`az ad app permission admin-consent` is a no-op here.** It consents to
  `requiredResourceAccess`, which these registrations leave empty — the scopes
  are requested dynamically at authorize time. It reports success and grants
  nothing; `grantAdminConsent` in the module is the working path.

And when you verify access gating: **Global Administrators are exempt from
assignment-required**, so test a block with a plain account — `AADSTS50105`
("not assigned to a role for the application") is the expected error. A GA
signs in either way and will tell you the block does nothing.

## The manual way

Create all three in **Azure Portal → Microsoft Entra ID → App registrations**.

### Registration 1: `helix-edge` (app-user sign-in)

The edge is what app visitors sign in to.

| Setting | Value |
| --- | --- |
| Supported account types | Single tenant |
| Platform | Web |
| Redirect URI | `https://auth.apps.example.com/callback` |

**Credential — secret or certificate.** The edge is the only confidential
client. It needs one of:

- **Client secret** (simplest): *Certificates & secrets → New client secret*.
- **Certificate**, if your tenant blocks secrets ("Client secrets are blocked
  by a tenant-wide policy"). Generate a keypair, upload the public cert under
  *Certificates*, and feed both PEMs to the deployment:

  ```bash
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -keyout edge-key.pem -out edge-cert.pem -days 365 -nodes \
    -subj "/CN=helix-edge"
  ```

Set exactly one of the two. In the Bicep deploy the certificate is the form
used: `HELIX_EDGE_OIDC_PRIVATE_KEY` + `HELIX_EDGE_OIDC_CERTIFICATE` (base64 of
the PEMs) and no secret.

No other configuration is needed on this registration. Per-app group
visibility (restricting an app to an Entra group) is a separate later step —
it uses security groups, not app roles, and needs one Graph permission. See
[the group claims runbook](https://github.com/AZX-PBC-OSS/helix/blob/main/docs/runbooks/entra-group-claims-rollout.md).

### Registration 2: `helix-portal` (the portal, and the API its tokens call)

One registration serves as both the portal SPA client and the API the SPA and
CLI get tokens for.

| Setting | Value |
| --- | --- |
| Supported account types | Single tenant |
| Platform | Single-page application (SPA) |
| Redirect URI | `https://portal.apps.example.com/auth/callback` |
| Expose an API → Application ID URI | `api://<helix-portal client id>` |

Then add the scope the SPA and CLI request. Under *Expose an API → Add a
scope*: name it `access`, allow **Admins and users** to consent, and leave the
display text at something sensible. The full scope is
`api://<helix-portal client id>/access`.

#### The two token gotchas

Both of these break sign-in with confusing errors, and both are one-time fixes.

**1. Clients must request the API scope.** A token's audience comes from the
scope the client asks for. Ask only for `openid profile email` and the token
targets Microsoft Graph, which the portal rejects. The SPA and CLI request
`api://<helix-portal client id>/access` — this is handled in code, so there is
nothing to configure, but it is why the scope has to exist.

**2. Switch access tokens to v2, and set the audience to the bare GUID.** With
a custom API exposed, Entra issues v1-format access tokens by default, which
the portal rejects. Fix it on the registration's manifest — there is no UI
toggle:

```bash
az ad app update --id <helix-portal client id> \
  --set api.requestedAccessTokenVersion=2
```

A v2 access token's audience is the **bare client-id GUID**, not the `api://`
URI. That is why `PORTAL_OIDC_AUDIENCE` in the deploy configuration is the
GUID, while the *scope* stays `api://…/access`. Getting this wrong looks like a
successful login followed by a 401 on every API call.

#### The admin role

Portal administration (approvals, secrets, admin pages) is gated on an app
role, not a group — no Entra P1 license needed for individual users.

1. *App roles → Create app role*: display name `Platform Admin`, allowed
   members **Users/Groups**, value **`platform-admin`**.
2. *Enterprise applications → helix-portal → Users and groups*: assign yourself
   to Platform Admin.

Sign-in itself is open to the whole tenant unless you restrict it
(*Enterprise applications → Properties → Assignment required*). Who to let in
and the recommended group layout: [Access control](/deploy/access-control).

### Registration 3: `azx-cli` (the deploy CLI)

| Setting | Value |
| --- | --- |
| Supported account types | Single tenant |
| Platform | — (no redirect URI) |
| Allow public client flows | Yes |

Then add the API permission: *API permissions → Add a permission → My APIs →
helix-portal → Delegated permissions → `access`*. The CLI signs in with the
device code flow, so it needs no redirect URI.

Admin consent is optional — the scope allows user consent, so the first
`helix login` shows a one-time browser prompt. If the tenant has disabled user
consent, an admin must grant it.

## What the deployment consumes

These values map to the Bicep parameters in
[getting started](/deploy/getting-started#step-2-fill-in-the-parameters):

| Value | Parameter |
| --- | --- |
| helix-edge client id | `edgeOidcClientId` |
| helix-portal client id (bare GUID) | `portalOidcAudience` |
| `platform-admin` (the role value) | `portalAdminGroupId` |
| azx-cli client id | `azxCliClientId` |
| helix-portal client id | `azxWebClientId` |

## Check it worked

- `curl https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration`
  returns a discovery document.
- Signing in to the portal works, and a role-assigned user sees the admin pages
  while others don't.
- `helix login` completes the device flow, and `helix deploy` succeeds — which
  proves the token audience is right.
