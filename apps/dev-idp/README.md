# @azx-pbc/dev-idp

The **local development OIDC issuer** (project plan §3, Entra row): a thin
wrapper around [`oidc-provider`](https://github.com/panva/node-oidc-provider)
with fixture users and the two platform clients. The platform speaks generic
OIDC; in dev, this is the IdP. **Never deployed** — production uses a real
Entra app registration with the same configuration surface (issuer URL,
client id/secret, audience).

## Run

```bash
pnpm dev:idp        # issuer http://localhost:3002
```

It runs **inside the workspace container**, not as a compose service, on
purpose: an OIDC issuer is a single string enforced by every client, and only
`localhost` + devcontainer port forwarding makes `http://localhost:3002` read
identically from the host browser (authorize redirects) and from in-container
back-channel calls (edge, portal, CLI, tests).

## Fixtures

| User              | Groups                       |
| ----------------- | ---------------------------- |
| `alice@azx.dev`   | `eng-team`, `platform-admin` |
| `bob@azx.dev`     | `eng-team`                   |
| `mallory@azx.dev` | _none_ (group-denial tests)  |

Clients: `azx-cli` (public; device-code + refresh), `helix-edge`
(confidential; code + PKCE + nonce; secret `edge-dev-secret`, override via
`IDP_EDGE_CLIENT_SECRET`; redirect URIs via `IDP_EDGE_REDIRECT_URIS`) and
`azx-portal-web` (public SPA; code + PKCE; redirect URIs via
`IDP_WEB_REDIRECT_URIS`).

The two redirect-URI vars are comma-separated and default to the base stack's
ports (`:8080` for the edge, `:5173`/`:3001` for the SPA). A second local stack
sets them from its own ports — see `scripts/stack-env.mjs`; without them every
login on that stack fails `redirect_uri` validation. `IDP_PORT` moves the
listener, and the issuer follows the bound port.

Behavior notes:

- `groups`/`email`/`name` are in the **ID token itself**
  (`conformIdTokenClaims: false`) — Entra parity; the edge never calls
  userinfo.
- Access tokens are **JWTs with `aud: urn:helix:portal`** (resource
  indicators), so the portal validates them statelessly over JWKS.
- Consent is auto-granted; the only page is a fixture-user picker. On any
  `/interaction/:uid` URL, `?user=alice@azx.dev` completes login
  non-interactively — the deterministic hook for integration tests and curl.
- State is in-memory: restart loses sessions and device codes; the signing
  key rotates per boot (consumers re-fetch JWKS on unknown `kid`).

## In tests

```ts
import { startDevIdp, runDeviceFlow, runAuthCodeFlow } from "@azx-pbc/dev-idp";
const idp = await startDevIdp(); // ephemeral port, parallel-safe
```

`src/testing.ts` also exports `TestHttpSession` (a minimal cookie jar /
redirect follower) and `approveDeviceFlow` for driving the built-in device
pages.
