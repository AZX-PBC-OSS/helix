# Runbook: Microsoft Entra ID registration (production auth)

How to point Helix at a real **Microsoft Entra ID** tenant for the M5 Azure
deploy, replacing the local dev OIDC issuer (`apps/dev-idp`).

**Why this is almost config-only.** Both `apps/edge` (app-user SSO) and
`apps/portal` (bearer-JWT API auth) speak generic OIDC, read
issuer/client/audience from environment variables, and use OIDC discovery — no
endpoints are hardcoded. The portal verifier already reads Entra's `roles` claim
(`apps/portal/src/auth/verifier.ts`). So production auth is mostly: create the
registrations below, then set the env vars. Two small code additions were needed
where the dev IdP had been doing Entra's job for us, and both already landed:

- **Certificate (`private_key_jwt`) client auth** for the edge, for tenants that
  block client secrets (`apps/edge/src/auth/oidc.ts`, `buildClientAuth`).
- **Requesting the portal API scope** from the SPA + CLI so the access token is
  audienced to the portal, not Microsoft Graph (`packages/shared` →
  `portalApiScope`). See [the audience gotcha](#the-token-audience-gotcha-read-this).

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
| Credentials | A **client secret** *or* a **certificate** (see below) → store in Key Vault, never in source |
| Token (ID) optional claims | Add `email`; ensure `name` + `preferred_username` are emitted |

**Client credential — secret or certificate.** The edge is the one confidential
client, so it authenticates itself at the token endpoint. Two supported forms:

- **Client secret** (simplest): _Certificates & secrets → New client secret_.
  Set `EDGE_OIDC_CLIENT_SECRET`.
- **Certificate / `private_key_jwt`** (use this if a tenant policy blocks client
  secrets — the "Client secrets are blocked by a tenant-wide policy" error):
  generate a keypair + self-signed cert, upload the **public cert** under
  _Certificates & secrets → Certificates → Upload certificate_, and give the
  edge the **private key + cert** via `EDGE_OIDC_CLIENT_PRIVATE_KEY` +
  `EDGE_OIDC_CLIENT_CERTIFICATE`. The edge signs the client assertion and sets
  the cert's `x5t` thumbprint so Entra matches the uploaded key
  (`apps/edge/src/auth/oidc.ts`, `buildClientAuth`). Set **exactly one** of the
  two forms — both together is a config error.

  Generate a throwaway cert with:

  ```bash
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -keyout edge-key.pem -out edge-cert.pem -days 365 -nodes \
    -subj "/CN=helix-edge"
  # Upload edge-cert.pem to Entra; feed both PEMs to the edge (see Part B).
  ```

  RSA keys work too (`-newkey rsa:2048`); the edge picks RS256/ES256 from the
  cert's key type automatically.

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

- Registering the redirect under the **SPA platform** makes Entra serve CORS on
  the token endpoint automatically (this replaces the dev-idp `clientBasedCORS`
  hack) and enforces PKCE.
- **Audience note:** Entra does **not** allow the dev value `urn:helix:portal`
  as an Application ID URI — it must be `api://<guid>` (or a verified custom
  domain). This is an env change only: `PORTAL_OIDC_AUDIENCE`.

**Expose an API → Add a scope.** This is the delegated permission the SPA and
CLI request so their tokens target the portal. Fill the form:

| Field | Value |
| --- | --- |
| Scope name | **`access`** → full scope is `api://<helix-portal-client-id>/access` |
| Who can consent? | **Admins and users** (pilot: lets users self-consent, nobody waits on an admin) |
| Admin consent display name | `Access the Helix portal API` |
| Admin consent description | `Allows the signed-in user to access the Helix portal API on their behalf.` |
| User consent display name | `Access the Helix portal` |
| User consent description | `Allows the app to access the Helix portal API on your behalf.` |
| State | **Enabled** |

#### The token-audience gotcha (read this)

The portal validates that every access token's `aud` equals `PORTAL_OIDC_AUDIENCE`
(`api://<helix-portal-client-id>`). **Entra sets a token's `aud` from the
resource scope the client requests.** A client that asks for only
`openid profile email` gets a token audienced to Microsoft Graph — which the
portal rejects. So the SPA and CLI must request `api://…/access`.

The dev IdP hid this: it used OIDC *resource indicators* to force every token's
audience to `urn:helix:portal` regardless of the requested scope. Entra does not.

**This is handled in code** — `portalApiScope(audience)` (`packages/shared`)
appends `/access` whenever the portal advertises an `api://` audience, and is a
no-op for the dev IdP's `urn:` audience. So you don't request it by hand; you
just have to know it's why the scope above must exist and why Reg 3 needs the API
permission below.

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
| API permissions | Delegated permission to `helix-portal`'s `access` scope (see below) |

**Add the API permission** (this is the Reg 3 half of the audience gotcha above):
_API permissions → Add a permission → **My APIs** → `helix-portal` → Delegated
permissions → check **`access`** → Add._ The CLI's access token then carries
`aud = api://<helix-portal-client-id>` and the user's `roles`.

**Admin consent is optional**, because the `access` scope is set to "Admins and
users" can consent. The "Grant admin consent for \<tenant\>" button is greyed out
unless you hold a directory admin role (Global / Application / Cloud Application
Admin) — that's expected, not a blocker. Without it, the user simply gets a
one-time browser consent prompt during `azx login` (device flow) and approves
"Access the Helix portal." Granting admin consent only pre-approves it tenant-wide
so nobody is ever prompted. A permission status of "Not granted for \<tenant\>"
is fine.

> **Exception:** if the tenant has disabled user consent org-wide, first login
> fails with `AADSTS65001` / an "approval required" screen — then an admin must
> grant consent. Otherwise user consent just works.

> **The SPA (Reg 2) does NOT need this pre-added.** It obtains the same `access`
> scope by *dynamic consent* at login (the user consents in the browser the first
> time). Only the CLI's device-code flow needs the permission configured ahead of
> time.

> Optional simplification: Reg 2 and Reg 3 can be merged into one registration
> with both an SPA redirect and public-client-flows enabled. Kept separate here
> for least-privilege clarity.

### Admin consent

Tenant admin consent for the API scope is **optional** (the scope is
user-consentable) — granting it once just spares users the individual consent
prompt. Requires a directory admin role; skip it if you don't have one (see Reg 3).
Conditional access / MFA are pure Entra policy and need no code
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
| `EDGE_OIDC_CLIENT_SECRET` | from Key Vault — **or** use the certificate pair below (set exactly one form) |
| `EDGE_OIDC_CLIENT_PRIVATE_KEY` | (cert auth) PKCS#8 private-key PEM, or base64-encoded PEM |
| `EDGE_OIDC_CLIENT_CERTIFICATE` | (cert auth) the matching X.509 cert PEM, or base64-encoded PEM |
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

## Local testing against real Entra

You can point a local edge/portal at the real tenant before the Azure deploy —
the best dress rehearsal. Keep `apps/dev-idp` as the default; this is opt-in.

**Add the local redirect URIs to the registrations** (alongside the prod ones —
Entra allows many per app):

| Registration | Platform | Local redirect URI(s) |
| --- | --- | --- |
| `helix-edge` | Web | `https://auth.localtest.me:8080/callback` |
| `helix-portal` | SPA | `http://localhost:5173/auth/callback` and `http://localhost:3001/auth/callback` |
| `azx-cli` | — | none (device code) |

- `auth.localtest.me` is **not** `localhost` to Entra, so it must be **https**
  (the dev mkcert wildcard cert already covers it). `http://localhost:*` is
  special-cased by Entra, so the portal SPA URIs need no TLS.

**Edge → Entra via the certificate**, without touching committed config: drop an
`apps/edge/.env.local` (gitignored via `.env.*`; loaded by `apps/edge/src/server.ts`,
where it **overrides** the devcontainer env). The cert lives in the gitignored
`.devcontainer/certs/`. Example:

```sh
# apps/edge/.env.local — repoints azx-edge at Entra; delete to fall back to dev-idp.
EDGE_OIDC_ISSUER=https://login.microsoftonline.com/<TENANT_ID>/v2.0
EDGE_OIDC_CLIENT_ID=<HELIX_EDGE_CLIENT_ID>
EDGE_OIDC_CLIENT_SECRET=          # empty: disables the dev secret so it doesn't collide with the cert
EDGE_OIDC_ALLOW_INSECURE=         # empty: Entra is https
EDGE_OIDC_CLIENT_PRIVATE_KEY=<base64 of .devcontainer/certs/entra-edge-key.pem>
EDGE_OIDC_CLIENT_CERTIFICATE=<base64 of .devcontainer/certs/entra-edge-cert.pem>
EDGE_OIDC_GROUPS_CLAIM=roles
EDGE_OIDC_SCOPES=openid profile email
```

Then **restart the `dev:edge` VS Code task** (`tsx watch` reloads on file save but
**not** on env change, so a task restart is required after editing `.env.local`).

**Portal + SPA → Entra:** point the portal's `PORTAL_OIDC_ISSUER` /
`PORTAL_OIDC_AUDIENCE` / `AZX_CLI_CLIENT_ID` / `AZX_WEB_CLIENT_ID` /
`PORTAL_ADMIN_GROUP_ID` at the Entra values (Part B). The SPA and CLI need **no**
local config of their own — they read everything from the portal's
`GET /api/v1/auth/config` at runtime.

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
