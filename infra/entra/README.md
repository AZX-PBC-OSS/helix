# Helix Entra ID registrations — Bicep (reference)

The three OIDC clients (architecture §4.2) as Infrastructure-as-Code, via the
[Microsoft Graph Bicep extension](https://learn.microsoft.com/graph/templates/bicep/)
(GA 2025-07-29). This is the IaC counterpart of the manual
[`docs/runbooks/entra-app-registration.md`](../../docs/runbooks/entra-app-registration.md).

> **Status: reference, not yet wired into a pipeline.** The pilot tenant's three
> apps were created by hand. This module is "our best shot" for the **production
> deployment** (`azx.helix.azxlabs.io`), where reproducibility pays. It is intentionally a
> sibling of `../azure` (the Azure resources), not folded into it — Entra apps
> are tenant objects with a different lifecycle and scope than a resource group.

## What it declares

| Registration                                                                               | Bicep highlights                                                                                                               |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `*-edge`                                                                                   | web redirect URIs, `email` optional claim, **certificate** keyCredential (private_key_jwt — the tenant blocks secrets)         |
| `*-portal`                                                                                 | SPA redirect URIs, **`requestedAccessTokenVersion: 2`**, the `access` scope, the **`platform-admin`** app role, `email` claims |
| `*-cli`                                                                                    | `isFallbackPublicClient: true` (device code), delegated permission to the portal `access` scope                                |
| + service principals, an optional `platform-admin` role assignment, optional admin consent |

Its outputs (`edgeOidcClientId`, `portalOidcAudience`, `azxWebClientId`,
`azxCliClientId`) are exactly the params the `../azure` stack needs — deploy this
first, capture the outputs, pass them in.

## Why each non-obvious property is there

Every one of these is a gotcha we hit by hand (see the runbook for the war
stories):

- **`requestedAccessTokenVersion: 2`** — without it Entra issues v1 access tokens
  (`iss = sts.windows.net/…`) that the v2-pinned portal rejects with 401.
- **Audience = the bare client-id GUID** — a v2 access token's `aud` is the client
  id, not the `api://` URI, so `portalOidcAudience` output is `portalApp.appId`.
- **App role `platform-admin`** (not a security group) — human-readable `roles`
  claim, no GUIDs/Graph/overage.
- **Certificate, not secret** — `keyCredentials`, because the tenant policy blocks
  client secrets.

## Known warts (read before deploying)

1. **`identifierUris` can't self-reference `appId`.** Clients request
   `api://<portal-appId>/access`, which needs the portal's identifier URI set to
   `api://<appId>` — but Bicep can't reference a resource's own `appId` inline.
   After the first deploy, run once:
   `az ad app update --id <portalClientId> --identifier-uris api://<portalClientId>`
   (the portal UI does this automatically when you add a scope; Bicep doesn't).
2. **Deploy-principal permissions.** Creating these needs Graph app-management
   rights — e.g. the **Application Administrator** role (or
   `Application.ReadWrite.All`). The role assignment + admin consent need more
   (Privileged Role Admin / `AppRoleAssignment.ReadWrite.All`). A tenant locked
   down enough to block client secrets may resist this — verify first.
3. **No clean import of the hand-made pilot apps.** The extension keys
   `applications` on `uniqueName`, which portal-created apps don't have — a deploy
   would create duplicates, not adopt. So use this for a _fresh_ environment;
   don't point it at the existing pilot registrations.
4. **Federated identity credential** (the cleanest edge auth — no key material)
   is sketched in `main.bicep` but disabled: it needs an edge code change to
   present a managed-identity token as the OIDC `client_assertion`.

## Deploy (when the time comes)

```bash
cd infra/entra
az bicep build --file main.bicep            # compile check (needs the extension)
az deployment group create -g <rg> -f main.bicep -p main.bicepparam
# then the identifierUris one-liner (wart #1), then feed outputs to ../azure
```

The `<rg>` is incidental — the Graph objects are tenant-scoped; the resource
group just hosts the deployment record.
