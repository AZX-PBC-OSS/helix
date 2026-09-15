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

Create all three in **Azure Portal → Microsoft Entra ID → App registrations**.
Substitute your apps domain for `apps.example.com` throughout.

## Registration 1: `helix-edge` (app-user sign-in)

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

## Registration 2: `helix-portal` (the portal, and the API its tokens call)

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

### The two token gotchas

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

### The admin role

Portal administration (approvals, secrets, admin pages) is gated on an app
role, not a group — no Entra P1 license needed for individual users.

1. *App roles → Create app role*: display name `Platform Admin`, allowed
   members **Users/Groups**, value **`platform-admin`**.
2. *Enterprise applications → helix-portal → Users and groups*: assign yourself
   to Platform Admin.

## Registration 3: `azx-cli` (the deploy CLI)

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
