# fetch-proxy

An AZX app that reaches the GitHub API **through the platform fetch-proxy** —
the counterpoint to [`github-stars`](../github-stars), which calls it directly
and trips CSP. Four probes exercise the whole capability
(`docs/features/fetch-proxy.md`):

| # | Probe | Exercises |
| - | ----- | --------- |
| 1 | `fetch('/_api/fetch/https://api.github.com/rate_limit')` | the path-prefix proxy (§3.1) |
| 2 | `…/_api/fetch/…/user` (auth-only) | **server-side secret injection** (§5) |
| 3 | native `fetch('https://api.github.com/…')` | the **transparent shim** rewriting `fetch` (§3.2) |
| 4 | raw `XMLHttpRequest` to the absolute URL | the shim covering **XHR** (what axios uses) |

GitHub is the ideal target: a Personal Access Token is two clicks to create, the
API works **keyless (60 req/hr) and authenticated (5000)**, and the difference is
*observable* — so you can literally watch the injected token take effect (probe 1
jumps 60 → 5000; probe 2 flips 401 → your account).

## Deploy

```bash
cd examples/fetch-proxy
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
helix create --display-name "Fetch proxy"
helix deploy --promote
```

Make sure `pnpm dev:egress` is running (the mechanism plane, `:8081`) — without
it the proxy probes return `503`.

## 1 · Keyless proxy

Grant the proxied origin (portal **Capabilities → Fetch proxy → Add proxied
origin**, or the manifest write-gate directly):

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/fetch-proxy/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{"capabilities":{"fetch":{"origins":[{"origin":"https://api.github.com"}]}}}'
```

A proxied origin is an elevated grant, so this opens an approval request —
approve it in the portal **Approvals** screen (locally `PORTAL_ALLOW_SELF_APPROVE=true`
lets one operator do both). After ~1 min (projection refresh), reload the app:
**probe 1** shows `limit 60` and **probe 2** shows `401` (no token yet).

## 2 · Inject a secret (the payoff)

Create a [GitHub PAT](https://github.com/settings/tokens) — **no scopes needed**;
an unscoped token still authenticates you, which raises the rate limit and makes
`/user` work. Store it as a connection secret (portal **Capabilities →
Connection secrets**, or curl), then bind the origin to it:

```bash
# store the credential (write-only — never returned)
curl -fsS -X POST "http://localhost:3001/api/v1/apps/fetch-proxy/secrets" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{"name":"github","value":"ghp_YOURTOKEN","injection":{"kind":"header-bearer"}}'

# bind api.github.com → the `github` connection (re-opens an approval; approve it)
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/fetch-proxy/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{"capabilities":{"fetch":{"origins":[{"origin":"https://api.github.com","connection":"github"}]}}}'
```

Approve, wait for the projection, reload: **probe 1** now shows `limit 5000` and
**probe 2** shows `injected — authenticated as @you`. The PAT was never in the
bundle — `helix-egress` injected `Authorization: Bearer …` server-side; the app
sent nothing.

## 3 · The transparent shim (fetch + XHR)

Probes 3 and 4 call the **absolute** `https://api.github.com/…` URL with no proxy
path — CSP-blocked by default. Turn on the shim (portal **Capabilities → Fetch
proxy → Transparent shim**, or add `"shim": true` to the `fetch` block above),
reload, and both light up: the edge injects `/_helix/fetch-shim.js`, which
rewrites `fetch()` **and** `XMLHttpRequest.prototype.open` to the proxy — so the
unmodified GitHub calls (and any axios call) just work. Toggle it off and reload
→ they go back to CSP-BLOCKED. Zero app code changed either way.

## Rebuild

```bash
cd examples/fetch-proxy
pnpm install --ignore-workspace
pnpm build      # regenerate dist/ (committed to git)
```
