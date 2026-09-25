# oauth-demo

An AZX app that exercises the platform's **delegated OAuth connections** end to
end (docs/features/fetch-proxy.md §Delegated providers, ADR-0031) against the
**fixture vendor** ([`apps/dev-oauth-vendor`](../../apps/dev-oauth-vendor) — the
local stand-in for a real OAuth provider like Asana). Two probes:

| # | Probe | Exercises |
| - | ----- | --------- |
| 1 | `window.helix.connect("demo-vendor")` | the consent-popup helper — consult → vendor authorize (PKCE S256) → callback on the auth host → sealed token save |
| 2 | `POST /_api/fetch/http://localhost:3003/api/echo` | the **delegated call** — egress resolves *your* connection and injects `Authorization: Bearer` server-side; before connecting the same call answers `403 connection_required` |

The vendor's API destination echoes which header the token arrived in, so the
injection is observable without the app ever holding a token.

## Prerequisites (dev container)

The platform trio plus the vendor and its TLS front. The vendor speaks plain
HTTP on `:3003`, but the consent entry points require `https` on the authorize
redirect — `dev:vendor-tls` fronts it with the mkcert wildcard cert on
`https://vendor.local.helix.azxlabs.io:3443` (same cert, same trust ceremony as
the app hosts):

```bash
pnpm dev:edge         # :8080 — needs EDGE_PORTAL_URL (compose now sets it)
pnpm dev:egress       # :8081 — needs EGRESS_ALLOW_PRIVATE + EGRESS_ALLOW_INSECURE_CONNECTION (compose now sets them)
pnpm dev:portal       # :3001
pnpm dev:idp          # :3002
pnpm dev:vendor       # :3003 — the fixture OAuth vendor
pnpm dev:vendor-tls   # :3443 — the https front for the vendor's authorize screen
```

## Deploy

```bash
cd examples/oauth-demo
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
node --import tsx ../../packages/cli/src/bin.ts create --display-name "OAuth demo"
node --import tsx ../../packages/cli/src/bin.ts deploy --promote
```

## 1 · Register the provider

The OAuth client lives in the vendor's registration; here the fixture accepts
any redirect URI with its default client (`dev-oauth-client`). Create the
provider row through the portal API (admin-gated; the client secret is sealed
on write and never returned):

```bash
curl -fsS -X POST "http://localhost:3001/api/v1/providers" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{
    "ref": "demo-vendor",
    "kind": "rest-delegated",
    "displayName": "Demo OAuth Vendor",
    "authorizeEndpoint": "https://vendor.local.helix.azxlabs.io:3443/authorize",
    "tokenEndpoint": "http://localhost:3003/token",
    "requestedScopes": ["read", "write"],
    "apiOrigins": ["http://localhost:3003"],
    "tokenPlacement": { "kind": "header-bearer" },
    "env": "prod",
    "clientId": "dev-oauth-client",
    "clientSecret": "dev-oauth-secret"
  }'
```

The authorize endpoint rides the TLS front (the redirect-hygiene bar); the
token exchange and the API destination ride the vendor's plain-http issuer —
exactly the split the integration tests use, relieved locally by
`EGRESS_ALLOW_PRIVATE` + `EGRESS_ALLOW_INSECURE_CONNECTION`.

## 2 · Bind the origin to the provider + grant the connect helper

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/oauth-demo/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{
    "capabilities": {
      "mcp": [],
      "externalOrigins": [],
      "fetch": {
        "shim": false,
        "origins": [{ "origin": "http://localhost:3003", "provider": "demo-vendor" }]
      },
      "shim": { "connect": true }
    }
  }'
```

A provider binding is an elevated grant, so this opens an approval request —
the PUT answers `{"pending": "<approval id>"}`; approve it (locally
`PORTAL_ALLOW_SELF_APPROVE=true` lets one operator do both, or use the
portal's **Approvals** screen):

```bash
PENDING=$(curl -fsS -X PUT "http://localhost:3001/api/v1/apps/oauth-demo/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{
    "capabilities": {
      "mcp": [],
      "externalOrigins": [],
      "fetch": {
        "shim": false,
        "origins": [{ "origin": "http://localhost:3003", "provider": "demo-vendor" }]
      },
      "shim": { "connect": true }
    }
  }' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pending))")

curl -fsS -X POST "http://localhost:3001/api/v1/approvals/$PENDING/approve" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" -d '{}'
```

Wait ~1 minute for the edge's registry projection to refresh, then open the
app and run the probes.

## 3 · The smoke test

Browse `https://oauth-demo.local.helix.azxlabs.io:8080`, sign in through the
dev IdP (any fixture user), then:

1. **Connect demo-vendor** — the popup travels: platform start route → the
   vendor's authorize screen (auto-approves) → the callback on the auth host
   completes the exchange through egress → the completion page posts the
   outcome back and closes. The probe shows `connected`.
2. **Call vendor API** — the echo reports the token arrived as
   `Authorization: Bearer`, masked: egress injected it from *your* sealed
   connection; the app sent nothing.

Watch the row exist: the portal's **My Connections** page (`/connections`)
shows the connection, and disconnecting there makes probe 2 read
`403 connection_required` again. The edge→egress trace for probe 2 is visible
in Jaeger (`http://localhost:27686`).

## Rebuild

```bash
cd examples/oauth-demo
pnpm install --ignore-workspace
pnpm build      # regenerate dist/ (committed to git)
```
