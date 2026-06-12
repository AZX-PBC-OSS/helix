# azx-edge

The data plane (architecture §3): stateless, terminates all `*.azx-labs.com` traffic. As of **M2** it serves deployed apps: host routing, a cached registry projection (Postgres LISTEN/NOTIFY), asset streaming from Blob with hand-rolled SharedKey signing, baseline CSP injection, and 404/410 (+ `Clear-Site-Data`) semantics.

**Hard rule: dependency-minimal.** Runtime deps are exactly `fastify`, `pg`, `undici`, `zod`, `@helix/shared`. Adding a package here requires justification at review time (project plan §6). No ORM, no Azure SDK — SQL is hand-written, blob reads are signed with `node:crypto`.

## Request flow (app hosts)

`<slug>.localtest.me` → registry projection (slug → live version's blob prefix) → `apps/<appId>/<n>/<path>` from Blob, streamed. HTML responses carry the §4.4 baseline CSP and `Cache-Control: no-cache` (pointer flips are immediately visible); other assets get `private, max-age=300` with ETag/304 revalidation. Misses that accept HTML fall back to `index.html` (SPA deep links). Unknown slug / no live version → 404; archived app → 410 + `Clear-Site-Data: "cache", "storage"`. Platform hosts (`localhost`, anything not `<slug>.<base domain>`) only answer `GET /health`.

## Configuration

| Env var                           | Default        | Meaning                                                            |
| --------------------------------- | -------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`                    | (required)     | Postgres for the registry projection (read-only queries)           |
| `AZURE_STORAGE_CONNECTION_STRING` | (required)     | Blob/Azurite for asset reads                                       |
| `BLOB_CONTAINER`                  | `app-bundles`  | Container the portal deploys into                                  |
| `EDGE_BASE_DOMAIN`                | `localtest.me` | Apps serve on `<slug>.<this>`                                      |
| `EDGE_DEV_ALLOW_UNAUTHENTICATED`  | unset          | **Dev only.** Without it app hosts 503 (fail-closed until M3 auth) |
| `EDGE_RECONCILE_INTERVAL_MS`      | `60000`        | Projection full-reload safety net                                  |
| `EDGE_PORT` / `PORT`              | `8080`         | Listen port                                                        |

## Dev workflow (in the dev container)

```bash
pnpm dev:portal     # :3001 — registry + deploy API
pnpm dev:edge       # :8080 — EDGE_DEV_ALLOW_UNAUTHENTICATED=true is set by the dev container

# Deploy + promote an example app (see packages/cli/README.md):
cd examples/hello-world
pnpm --filter @helix/cli azx -- deploy --promote   # or: azx deploy --promote

# *.localtest.me resolves to 127.0.0.1:
curl -i http://hello-world.localtest.me:8080/      # 200, CSP header, HTML
curl -i http://localhost:8080/health               # platform health JSON
```

Archive via the portal API to see the 410 path:

```bash
curl -X POST -H "Authorization: Bearer $PORTAL_DEV_TOKEN" \
  http://localhost:3001/api/v1/apps/hello-world/archive
curl -i http://hello-world.localtest.me:8080/      # 410 + Clear-Site-Data
```

## Tests

Unit tests use in-memory fakes (`src/test/fakes.ts`). Integration tests (`*.integration.test.ts`) run against the dev container's test Postgres (migrated — including the NOTIFY trigger — by the vitest global setup) and Azurite; they probe once and skip loudly if either is unreachable.
