# github-report

An AZX app that turns **repository activity into an AI-written report**, exercising the
platform's delegated OAuth connections (ADR-0031) against GitHub — a real vendor whose
GitHub **App** registration carries its fine-grained permissions on the app itself:

| Capability | Where |
| ---------- | ----- |
| **Delegated OAuth connections** (ADR-0031) | `window.helix.connect("github-readonly")` consents inside a click; provider-bound `/_api/fetch` calls get the *user's* access token injected server-side; the boot-time status read (`GET /_api/connections/:ref/status`) picks the panel |
| **LLM gateway** (`/_api/llm/chat`) | `gpt-5-nano` streams a markdown report from the activity digest — no key in the app |

The sibling [`asana-report`](../asana-report) additionally exercises shared app-data by
**saving** reports; this one deliberately doesn't — a report is generated, streamed, and
shown, and the manifest declares no `data` capability at all.

## How it fetches activity

Pick (or type) a repository and a timescale (7/14/30/90 days). The app fetches, in
parallel, the repo metadata, the issue list, the pull-request list, and the commit
window (`GET /repos/{owner}/{repo}/…`), then best-effort sections for deployments,
open Dependabot alerts, and discussions — a section the vendor won't serve degrades to
a skipped note instead of failing the report. GitHub's list endpoints paginate by page
number, so each section reads one page (100 records) and the digest says when the list
may be capped. A user access token sits under 5,000 req/hr, so no pacing is needed.

The digest is compact JSON the LLM summarizes into: Summary, Highlights, Code changes,
Issues & discussions, Risks & loose ends.

Because the provider's permissions live on the GitHub App (commit statuses, contents,
Dependabot alerts, discussions, deployments, issues, projects, pull requests — all
read-only), the provider requests **no scopes** at authorize time; consent shows the
app's configured permissions. Existing tokens keep the old permission set if the app's
permissions change later — GitHub App user tokens expire (8h) and refresh, which the
platform's renewal handles server-side.

## Prerequisites (dev instance)

The platform trio running, with helix-egress up (delegated calls and the LLM key both
ride it):

```bash
pnpm dev:edge     # :8080
pnpm dev:egress   # :8081
pnpm dev:portal   # :3001
pnpm dev:idp      # :3002
```

A `github-readonly` **connection provider** must exist in the portal — the import
document alongside this README (`github-readonly.provider.json`) is exactly that
configuration: ref `github-readonly`, kind `rest-delegated`, endpoints at
`github.com/login/oauth/authorize|access_token`, origin `https://api.github.com`, token
placement `header-bearer`, and no requested scopes (a GitHub App's fine-grained
permissions live on the app, so the provider requests none). Import it through the
provider form or the import API — the document carries no credentials; client ID and
secret are entered at apply time and sealed. The GitHub App must register the
platform callback `https://auth.local.helix.azxlabs.io:8080/connections/callback`.

## Deploy + set up capabilities

```bash
cd examples/github-report
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
node --import tsx ../../packages/cli/src/bin.ts create --display-name "GitHub Repo Report"
node --import tsx ../../packages/cli/src/bin.ts deploy --promote
```

Then grant the manifest (gpt-5-nano is curated — baseline; the provider-bound origin is
elevated, so the PUT opens an approval request — locally `PORTAL_ALLOW_SELF_APPROVE=true`
lets one operator approve it):

```bash
PENDING=$(curl -fsS -X PUT "http://localhost:3001/api/v1/apps/github-report/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{
    "capabilities": {
      "mcp": [],
      "externalOrigins": [],
      "llm": { "models": ["gpt-5-nano"], "dollarsPerDay": 1 },
      "fetch": {
        "shim": false,
        "origins": [{ "origin": "https://api.github.com", "provider": "github-readonly" }]
      },
      "shim": { "fetch": false, "connect": true }
    }
  }' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pending))")

curl -fsS -X POST "http://localhost:3001/api/v1/approvals/$PENDING/approve" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" -d '{}'
```

Wait ~1 minute for the edge's registry projection to refresh, then open
`https://github-report.local.helix.azxlabs.io:8080`, sign in through the dev IdP, and:

1. **Connect GitHub** — the app shows the CTA when no connection exists; the popup goes
   to GitHub's consent screen (showing the GitHub App's configured read-only
   permissions), the callback completes on the auth host, and the banner swaps to
   "connected" with repository suggestions loading in place.
2. Pick a repository and a timescale → **Generate report** — the report streams in.
3. That's it — nothing is stored; regenerate any time.

## Notes

- The report is only as fresh as the crawl: every generate re-fetches from GitHub.
- Repo suggestions come from `GET /user/repos` (first 100 by recency of push); typing
  any `owner/repo` the token can see works too.
- A GitHub App user token expires in 8 hours; a delegated call against an expired token
  renews it server-side before dispatch (the platform's renewal path) — the app never
  handles tokens.
