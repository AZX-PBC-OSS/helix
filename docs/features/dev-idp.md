# Local OIDC issuer (`dev-idp`)

> **Related ADRs:** [ADR-0004](../adr/0004-auth-model.md) (edge-terminated auth) · [ADR-0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) (portal/CLI JWT).

**What it is.** A local OpenID Connect issuer (`apps/dev-idp`) used in development and tests so
the whole auth surface — the edge's app-user flow, the portal's bearer-JWT verification, the
CLI's device flow, and the SPA's code+PKCE login — runs end-to-end without Entra. It is a thin
wrapper around the `oidc-provider` library with fixture users and clients. **Dev/test only —
never deployed.** Full notes: [`apps/dev-idp/README.md`](../../apps/dev-idp/README.md).

## How it works

- Runs in the workspace container via `pnpm dev:idp` on **:3002** — deliberately **not** a
  compose service, so its issuer URL `http://localhost:3002` reads identically from the host
  browser and from in-container back-channels.
- No state persistence; the signing key rotates per boot, so a restart clears all sessions.
- `src/server.ts` / `start.ts` boot it; `src/provider.ts` configures `oidc-provider`;
  `src/interactions.ts` renders the fixture-user picker; `src/fixtures.ts` holds the users and
  clients.

### Fixture users (`src/fixtures.ts`)

| User | Groups | For |
| --- | --- | --- |
| `alice@azx.dev` | `eng-team`, `platform-admin` | admin / happy path |
| `bob@azx.dev` | `eng-team` | regular user |
| `mallory@azx.dev` | _(none)_ | group-denial tests |

### Clients

- `azx-cli` (public) — device-code + refresh grants (the CLI).
- `helix-edge` (confidential) — code + PKCE + nonce; secret `edge-dev-secret`
  (`IDP_EDGE_CLIENT_SECRET`). The edge's app-user flow.
- `azx-portal-web` (public) — code + PKCE for the browser SPA; `clientBasedCORS` opens the token
  endpoint to it.

### Entra parity (group claims in the token)

The provider sets `conformIdTokenClaims: false`, so `groups` / `email` / `name` land **in the ID
token itself** (not behind a userinfo round-trip), matching how Entra delivers group claims — the
edge reads them straight off the token and never calls userinfo (`provider.ts`). Access tokens are
**JWTs** (`accessTokenFormat: "jwt"` via the resource-indicator feature) with `aud:` the portal
audience, so the portal verifies them statelessly over JWKS; `extraTokenClaims` copies
`email`/`name`/`groups` onto the access token for actor attribution. Consent is always auto-granted,
so the only interaction that ever renders is the login picker (`interactions.ts`).

### Testing exports

`startDevIdp()` (from `src/start.ts`, re-exported via `src/index.ts`) spins up an ephemeral
instance on a random port; `src/testing.ts` adds `runDeviceFlow()` / `runAuthCodeFlow()` to drive
the flows, `TestHttpSession` (a cookie-jar + redirect follower), `approveDeviceFlow()` to click
through the device page, and `decodeJwtPayload()`. These back the edge and CLI integration tests.

## Design notes (why)

- **One issuer, two read paths, same URL** — running in the workspace container (not as a compose
  service) means `http://localhost:3002` resolves identically from the host browser and from
  in-container back-channels, so no split-horizon DNS or per-environment issuer config.
- **Faithful to Entra where it matters** — group-claims-in-token and JWT access tokens are the two
  behaviors the rest of the platform depends on, so the dev IdP reproduces them exactly; the prod
  swap is then config-only.
- **CORS only for the SPA** — `clientBasedCORS` keys off `azx-portal-web` alone; the redirect-URI
  allowlist + PKCE stay the real boundary for that public browser client.

## Planned / not yet built

- Production swaps this for an **Entra** app registration (config-only — the M3 tail). The
  issuer/clients are the only things that change; the flows are identical.
