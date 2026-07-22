# github-stars

An AZX app that fetches the **public GitHub API directly from the browser** —
the deliberate counterpoint to [`chatbot`](../chatbot), which routes everything
through the gateway. Calling a third party straight from app code is exactly
what the platform's static Content-Security-Policy blocks, so this app is the
canonical way to kick the tires on the **CSP violation → origin-grant →
approval → CSP-widen** loop (`docs/design/approvals.md` §6.2).

```
fetch https://api.github.com ──blocked by connect-src 'self'──▶ browser
   │  POST report-uri /_csp-report                                    │
   ▼                                                                  │
edge csp_reports (INSERT-only) ──▶ portal Violations screen ──"request this origin"──▶ ApprovalRequest
                                                                                            │ admin approves
   app fetch now succeeds  ◀── edge widens connect-src ◀── projection ◀── capabilities.externalOrigins +origin
```

## What it demonstrates

- **The CSP is real containment.** Out of the box, `connect-src 'self'` refuses
  the call to `api.github.com`. No app code change can lift it — only an approved
  `externalOrigins` grant can, and that lives in the control plane.
- **Silent breakage becomes a guided flow.** The blocked fetch auto-POSTs a
  violation to the edge's `report-uri` (`/_csp-report`) — no app code needed —
  which surfaces on the portal **Violations** screen as a one-click *“request
  this origin.”*
- **Approval widens the policy, not the code.** An admin approves the request →
  `capabilities.externalOrigins` gains `https://api.github.com` → the edge
  rebuilds this app's CSP from the registry projection within ~1 min. The same
  button then works with **no redeploy**.
- **The auth session, too.** It reads `/_api/me` to show who the gateway sees,
  exercising the M3 session on a (non-public) app host.

GitHub's API is a good demo target: well-known, no key for public repos, and it
sends `Access-Control-Allow-Origin: *`, so once the CSP allows the origin the
browser fetch just works (no CORS wall behind it).

## Deploy

```bash
export AZX_TOKEN="$PORTAL_DEV_TOKEN"        # same value the portal was started with
cd examples/github-stars
node --import tsx ../../packages/cli/src/bin.ts create --display-name "GitHub Stars"
node --import tsx ../../packages/cli/src/bin.ts deploy --promote
```

(Substitute `azx` for the `node … bin.ts` invocation once the CLI is on your
PATH — see [`packages/cli/README.md`](../../packages/cli/README.md).) The deploy
endpoint's courtesy CSP lint will **warn** about `api.github.com` — that warning
is the whole point of this app; it's non-blocking.

## Walk the approval loop

1. Open the app at `https://github-stars.local.helix.azxlabs.io:8080` and sign in. Click
   **Fetch stars** → it reports *blocked* (the CSP refused `api.github.com`).
2. In the portal (`pnpm dev:web`, `:5173`), open **Violations** → the blocked
   origin is listed → click **Request this origin**.
3. Open **Approvals**, approve the `externalOrigins[+https://api.github.com]`
   request (locally `PORTAL_ALLOW_SELF_APPROVE=true` lets one operator do both).
4. Wait ~1 min for the projection, reload the app, click **Fetch stars** again →
   the star count loads. No code change, no redeploy.

To skip the UI and grant the origin directly through the manifest write-gate
(it still opens an approval request for the elevated origin delta):

```bash
curl -fsS -X POST "http://localhost:3001/api/v1/apps/github-stars/access/origin" \
  -H "authorization: Bearer $AZX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"origin":"https://api.github.com"}'
```

## Rebuild

```bash
cd examples/github-stars
pnpm install --ignore-workspace
pnpm build      # regenerate dist/ (committed to git)
```
