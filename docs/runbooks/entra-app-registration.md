# Runbook: Microsoft Entra ID registration (production auth)

How to point Helix at a real **Microsoft Entra ID** tenant for the M5 Azure
deploy, replacing the local dev OIDC issuer (`apps/dev-idp`).

**Why this is config-only.** Both `apps/edge` (app-user SSO) and `apps/portal`
(bearer-JWT API auth) speak generic OIDC, read issuer/client/audience from
environment variables, and use OIDC discovery — no endpoints are hardcoded. The
portal verifier already reads Entra's `roles` claim
(`apps/portal/src/auth/verifier.ts`). So production auth is: create the
registrations below, then set the env vars. No code changes.

## Decisions baked into this runbook

- **Authorization via App Roles, not security groups.** App roles let us emit
  human-readable string values (e.g. `platform-admin`) in the `roles` claim —
  no GUIDs, no Microsoft Graph lookups, no >200-group claim overage, no Entra
  P1 license (when assigning individual users). Our config and stored
  identifiers stay readable, matching the dev-idp behavior.
- **Single-tenant.** Only the org's own users sign in. Issuer is the **v2**
  endpoint: `https://login.microsoftonline.com/{tenantId}/v2.0`.
- **Pilot apps use `private` or `password` visibility.** The only role plumbing
  M5 needs is one `platform-admin` role for portal admin gating. Per-app
  **group visibility** (`visibility: group`) is deferred until a real app needs
  it (see [Deferred](#deferred-until-needed)).

Substitute the real apex domain for `azx-labs.com` if it differs
(`docs/platform-architecture.md` §4.2).

---

## Part A — Three app registrations

Created in **Azure Portal → Microsoft Entra ID → App registrations**. They
mirror the three dev-idp clients in `apps/dev-idp/src/fixtures.ts`.

### Reg 1 — `helix-edge` (app-user SSO; confidential web client)

| Setting | Value |
| --- | --- |
| Supported account types | Single tenant |
| Platform | **Web** |
| Redirect URI | `https://auth.azx-labs.com/callback` (no port in prod) |
| Credentials | Create a **client secret** → store in Key Vault, never in source |
| Token (ID) optional claims | Add `email`; ensure `name` + `preferred_username` are emitted |

- PKCE is used by the edge automatically even though this client is
  confidential (`apps/edge/src/auth/oidc.ts`). Entra accepts it.
- The edge reads only the **ID token** and derives display name from
  `name → preferred_username → email`. `preferred_username` (the UPN) is always
  present in v2, so a missing `email` degrades gracefully.
- **No app roles needed for the pilot** — only add roles here later, when an app
  uses `visibility: group`.

### Reg 2 — `helix-portal` (portal SPA + the API its tokens target)

This single registration is both the SPA client and the protected API (its own
audience) — the simplest topology.

| Setting | Value |
| --- | --- |
| Supported account types | Single tenant |
| Platform | **Single-page application (SPA)** |
| Redirect URI | `https://portal.azx-labs.com/auth/callback` |
| Expose an API → Application ID URI | `api://<helix-portal-client-id>` |
| Expose an API → Scope | add e.g. `access` (admin consent or user consent) |

- Registering the redirect under the **SPA platform** makes Entra serve CORS on
  the token endpoint automatically (this replaces the dev-idp `clientBasedCORS`
  hack) and enforces PKCE.
- **Audience note:** Entra does **not** allow the dev value `urn:helix:portal`
  as an Application ID URI — it must be `api://<guid>` (or a verified custom
  domain). This is an env change only: `PORTAL_OIDC_AUDIENCE`.

**Define the admin role** (App roles → Create app role):

| Field | Value |
| --- | --- |
| Display name | Platform Admin |
| Allowed member types | Users/Groups |
| Value | **`platform-admin`** |
| Description | Helix platform administrators (approvals, secrets, admin pages) |

Then **Enterprise applications → helix-portal → Users and roles → Add user/role**
and assign yourself to **Platform Admin**. That is the entire groups/roles story
for M5. The `roles` claim is emitted in both ID and access tokens for this app,
so the portal sees `platform-admin` for assigned users.

> To reuse an existing org security group instead of listing individual users,
> assign the **group** to the role here — this requires an Entra ID **P1**
> license.

### Reg 3 — `azx-cli` (CLI device-code; public client)

| Setting | Value |
| --- | --- |
| Supported account types | Single tenant |
| Redirect URI | none |
| Authentication → Allow public client flows | **Yes** (enables device-code grant) |
| API permissions | Delegated permission to `helix-portal`'s `access` scope |

Grant **admin consent** for the API permission once. The CLI's access token then
carries `aud = api://<helix-portal-client-id>` and the user's `roles`.

> Optional simplification: Reg 2 and Reg 3 can be merged into one registration
> with both an SPA redirect and public-client-flows enabled. Kept separate here
> for least-privilege clarity.

### Admin consent

Grant tenant admin consent once for the API scope so users aren't individually
prompted. Conditional access / MFA are pure Entra policy and need no code
(`docs/platform-architecture.md` Appendix A, step 4).

---

## Part B — Environment wiring

Set these in the M5 ACA app configuration / Key Vault. **The dev
`docker-compose.yml` is not changed** — local dev keeps using `apps/dev-idp`.

> **Critical:** set `NODE_ENV=production` so the dev escape hatches hard-refuse
> at startup — `EDGE_OIDC_ALLOW_INSECURE` / `PORTAL_OIDC_ALLOW_INSECURE` and
> `PORTAL_DEV_TOKEN` all throw in production
> (`apps/portal/src/auth/verifier.ts`).

### Edge (`apps/edge/src/config.ts`)

| Var | Value |
| --- | --- |
| `EDGE_OIDC_ISSUER` | `https://login.microsoftonline.com/{tenantId}/v2.0` |
| `EDGE_OIDC_CLIENT_ID` | helix-edge client id (GUID) |
| `EDGE_OIDC_CLIENT_SECRET` | from Key Vault |
| `EDGE_OIDC_GROUPS_CLAIM` | **`roles`** (point the edge at the App Roles claim) |
| `EDGE_OIDC_SCOPES` | `openid profile email` (drop `groups`; roles ride the token automatically) |
| `EDGE_AUTH_SECRET` | fresh base64 ≥32 bytes (internal HKDF key, **not** an Entra secret) |
| `EDGE_OIDC_ALLOW_INSECURE` | unset |

Confirm the base-domain/port config produces the portless callback
`https://auth.azx-labs.com/callback` to match Reg 1 (`apps/edge/src/server.ts`,
`publicOrigin`).

### Portal (`apps/portal/src/plugins/auth.ts`)

| Var | Value |
| --- | --- |
| `PORTAL_OIDC_ISSUER` | `https://login.microsoftonline.com/{tenantId}/v2.0` |
| `PORTAL_OIDC_AUDIENCE` | `api://<helix-portal-client-id>` (replaces `urn:helix:portal`) |
| `AZX_CLI_CLIENT_ID` | azx-cli client id (GUID) |
| `AZX_WEB_CLIENT_ID` | helix-portal client id (GUID) |
| `PORTAL_ADMIN_GROUP_ID` | **`platform-admin`** (the app-role value) |
| `PORTAL_OIDC_ALLOW_INSECURE` / `PORTAL_DEV_TOKEN` | unset |

The portal advertises issuer + client ids to the CLI and SPA via
`GET /api/v1/auth/config`, so `packages/cli` and `apps/portal-web` need **no**
build-time config — they discover everything at runtime.

---

## Verification

1. **Discovery:** from the deploy environment,
   `curl https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration`
   returns a doc advertising `device_authorization_endpoint`, `token_endpoint`,
   and `jwks_uri`.
2. **App-user SSO (edge):** browse to a `private` pilot app → redirected to
   `auth.azx-labs.com` → Entra login (MFA per policy) → handoff → app loads with
   a `__Host-session` cookie. Confirm the display name resolves.
3. **Portal admin (web):** sign in at `portal.azx-labs.com`. A user assigned
   **Platform Admin** sees the approvals/secrets admin pages; an unassigned user
   does not (proves `roles` → `PORTAL_ADMIN_GROUP_ID` gating). A denied admin
   attempt logs `admin denied: …` with the principal + the expected role value.
4. **CLI:** `azx login` completes the device flow against Entra; `azx whoami`
   shows the identity; `azx deploy` succeeds (proves the access token `aud`
   matches `PORTAL_OIDC_AUDIENCE`).
5. **Escape hatches refuse:** the services boot with `NODE_ENV=production`, and
   setting any `*_ALLOW_INSECURE` / `PORTAL_DEV_TOKEN` would throw at startup.
6. **Local dev unaffected:** `pnpm dev:idp` plus the adversarial suite
   (`apps/edge/src/auth/adversarial.test.ts`) still pass — the dev issuer is
   untouched.

---

## Deferred (until needed)

- **Per-app group visibility (`visibility: group`).** When the first app needs
  it, define an app role per group on `helix-edge` and assign members, then
  store that role value as the app's `visibilityGroupId`. Decide
  App-Role-vs-security-group at that point, with a concrete need in hand.
- **Multi-tenant / IdP-agnostic customers** (`docs/platform-project-plan.md` §3).
- **Microsoft Graph group resolution** — not needed with App Roles.
