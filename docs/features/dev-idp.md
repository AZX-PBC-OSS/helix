# Local OIDC issuer (`dev-idp`)

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
| `alice@azx.dev` | `eng-team`, `platform-admins` | admin / happy path |
| `bob@azx.dev` | `eng-team` | regular user |
| `mallory@azx.dev` | _(none)_ | group-denial tests |

### Clients

- `azx-cli` (public) — device-code + refresh grants (the CLI).
- `helix-edge` (confidential) — code + PKCE + nonce; secret `edge-dev-secret`
  (`IDP_EDGE_CLIENT_SECRET`). The edge's app-user flow.
- `azx-portal-web` (public) — code + PKCE for the browser SPA; `clientBasedCORS` opens the token
  endpoint to it.

### Entra parity

ID tokens embed `groups` / `email` / `name` directly (not via a userinfo round-trip), matching
how Entra delivers group claims; access tokens are JWTs with `aud: urn:helix:portal` (resource-
indicator semantics) so the portal can verify them statelessly over JWKS. The
non-interactive approval (`?user=alice@azx.dev` on the interaction page) makes integration tests
deterministic.

### Testing exports (`src/testing.ts`)

`startDevIdp()` spins up an ephemeral instance on a random port; `runDeviceFlow()` /
`runAuthCodeFlow()` drive the flows; `TestHttpSession` is a cookie-jar + redirect follower;
`approveDeviceFlow()` clicks through the device page. These back the edge and CLI integration
tests.

## Planned / not yet built

- Production swaps this for an **Entra** app registration (config-only — the M3 tail). The
  issuer/clients are the only things that change; the flows are identical.
