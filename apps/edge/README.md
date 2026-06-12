# azx-edge

The data plane (architecture §3): stateless, terminates all `*.azx-labs.com` traffic. As of **M3 (local half)** it serves deployed apps behind real authentication: host routing, a cached registry projection (Postgres LISTEN/NOTIFY), the §4.2/Appendix A OIDC login flow (central callback on `auth.<base>`, one-time handoff token, `__Host-session` cookies, server-side sessions in Postgres), `/_api/me`, group-based visibility checks, silent refresh, asset streaming from Blob with hand-rolled SharedKey signing, baseline CSP injection, and 404/410 (+ `Clear-Site-Data`) semantics.

**Hard rule: dependency-minimal.** Runtime deps are exactly `fastify`, `pg`, `undici`, `zod`, `jose`, `openid-client`, `@helix/shared` — the M3 additions are the two named in project plan §1. Adding a package here requires justification at review time (project plan §6). No ORM, no Azure SDK, no cookie library — SQL is hand-written, blob reads are signed with `node:crypto`, and cookie parsing is ~30 lines (`src/auth/cookies.ts`).

## Request flow (app hosts)

`<slug>.localtest.me` → registry projection (slug → live version + visibility) → **session gate** → `apps/<appId>/<n>/<path>` from Blob, streamed.

The gate (architecture §4.2, Appendix A): no `__Host-session` cookie → top-level navigations 302 to `auth.<base>/start?app=<slug>&rd=<path>`; fetches/subresources get 401 (`Sec-Fetch-Mode` primary, Accept sniff fallback). The auth host runs OIDC code+PKCE+nonce against the issuer, checks the app's visibility rule (group membership for `group` mode), writes a _pending_ session row, and hands off via `GET <slug>.<base>/_auth/complete?token=<30s, single-use, audience-bound JWS>`. Redemption burns the token atomically (an `UPDATE … WHERE "tokenHash" IS NULL`), mints a fresh host-scoped cookie, and lands on the original path. Sessions are server-side (revocation is real), hard-capped (8 h default), and silently re-authenticated via `prompt=none` after the refresh interval (1 h default) — group membership is re-snapshotted there. `POST /_auth/logout` (Origin-checked) deletes the row; `GET /_api/me` returns `{user: {id, displayName}}` and nothing more.

HTML responses carry the §4.4 baseline CSP and `Cache-Control: no-cache` (pointer flips are immediately visible); other assets get `private, max-age=300` with ETag/304 revalidation. Misses that accept HTML fall back to `index.html` (SPA deep links). Unknown slug / no live version → 404; archived app → 410 + `Clear-Site-Data: "cache", "storage"` (both answered before the gate). `/_auth/*` and `/_api/*` are platform namespaces — they never reach the blob store. Platform hosts (`localhost`, anything not `<slug>.<base domain>`) only answer `GET /health`; `auth.<base>` additionally answers `/start` and `/callback`.

## Configuration

| Env var                                           | Default                                  | Meaning                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                    | (required)                               | Postgres: registry projection (read) + sessions (read/write)                                                                               |
| `AZURE_STORAGE_CONNECTION_STRING`                 | (required)                               | Blob/Azurite for asset reads                                                                                                               |
| `BLOB_CONTAINER`                                  | `app-bundles`                            | Container the portal deploys into                                                                                                          |
| `EDGE_BASE_DOMAIN`                                | `localtest.me`                           | Apps serve on `<slug>.<this>`; auth on `auth.<this>`                                                                                       |
| `EDGE_OIDC_ISSUER`                                | unset                                    | OIDC issuer (dev: `http://localhost:3002`; later: Entra). All four auth vars set together, or none                                         |
| `EDGE_OIDC_CLIENT_ID` / `_CLIENT_SECRET`          | unset                                    | The edge's confidential client at the issuer                                                                                               |
| `EDGE_AUTH_SECRET`                                | unset                                    | base64, ≥32 bytes; HKDF-derived into handoff + flow-cookie keys                                                                            |
| `EDGE_OIDC_ALLOW_INSECURE`                        | unset                                    | Permit an `http://` issuer (local dev-idp only)                                                                                            |
| `EDGE_OIDC_GROUPS_CLAIM` / `EDGE_OIDC_SCOPES`     | `groups` / `openid profile email groups` | Claim + scopes for group visibility                                                                                                        |
| `EDGE_SESSION_TTL_MS` / `EDGE_SESSION_REFRESH_MS` | 8 h / 1 h                                | Hard session cap / silent-refresh due time                                                                                                 |
| `EDGE_TLS_CERT_FILE` / `EDGE_TLS_KEY_FILE`        | (required in dev)                        | Edge-terminated TLS (mkcert). **Required outside production** — the platform is HTTPS-only. Prod leaves them unset (ingress owns the cert) |
| `EDGE_PUBLIC_PORT`                                | listen port                              | Public port for built redirect/cookie URLs (prod: 443; the scheme is always https)                                                         |
| `EDGE_DEV_ALLOW_UNAUTHENTICATED`                  | unset                                    | **Dev only** (refused in production): skip the session gate. Does **not** relax TLS                                                        |
| `EDGE_RECONCILE_INTERVAL_MS`                      | `60000`                                  | Projection full-reload safety net                                                                                                          |
| `EDGE_PORT` / `PORT`                              | `8080`                                   | Listen port                                                                                                                                |

Two fail-closed stances. **Transport:** the platform is HTTPS-only — outside `NODE_ENV=production` the edge refuses to boot without `EDGE_TLS_*` (`__Host-` cookies need Secure; app crypto APIs need a secure context). **Auth:** with no auth block and no dev bypass, app hosts serve nothing (503); the bypass throws under production.

## Dev workflow (in the dev container)

```bash
pnpm dev:idp        # :3002 — local OIDC issuer (apps/dev-idp; fixture users)
pnpm dev:portal     # :3001 — registry + deploy API
pnpm dev:edge       # :8080 — https (mkcert) with the real login flow;
                    #         EDGE_DEV_ALLOW_UNAUTHENTICATED=true additionally
                    #         skips the gate (the dev container sets it)

# Deploy + promote an example app (see packages/cli/README.md):
cd examples/hello-world
pnpm --filter @helix/cli azx -- deploy --promote   # or: azx deploy --promote

# *.localtest.me resolves to 127.0.0.1 (note: https now):
curl -ik https://hello-world.localtest.me:8080/    # 302 → auth host (or 200 with the bypass)
curl -ik https://localhost:8080/health             # platform health JSON
```

To exercise the full login flow, unset the bypass for the edge process
(`EDGE_DEV_ALLOW_UNAUTHENTICATED= pnpm dev:edge`), open
`https://hello-world.localtest.me:8080/` in a browser, and pick a fixture user
(`alice@azx.dev` / `bob@azx.dev` / `mallory@azx.dev`) on the dev IdP page. The
mkcert CA lives at `.devcontainer/certs/caroot/rootCA.pem` — import it into the
host trust store to silence browser warnings (optional).

Archive via the portal API to see the 410 path:

```bash
curl -X POST -H "Authorization: Bearer $PORTAL_DEV_TOKEN" \
  http://localhost:3001/api/v1/apps/hello-world/archive
curl -ik https://hello-world.localtest.me:8080/    # 410 + Clear-Site-Data
```

## Tests

Unit tests use in-memory fakes (`src/test/fakes.ts`), including a fake IdP and session store; the **adversarial suite** for the handoff path (replay, audience confusion, open redirect, cookie tossing, state/nonce tampering, expired/alg-confused tokens, session fixation) is `src/auth/adversarial.test.ts` plus `src/auth/handoff.test.ts`. Integration tests (`*.integration.test.ts`) run against the dev container's test Postgres (migrated by the vitest global setup) and Azurite, and boot an **in-process dev-idp on an ephemeral port** for the full Appendix A flow — including the concurrent-redeem race and a real `prompt=none` silent refresh.
