# asana-report

An AZX app that turns **Asana project activity into an AI-written report**, exercising the
platform's three data capabilities at once:

| Capability | Where |
| ---------- | ----- |
| **Delegated OAuth connections** (ADR-0031) | `window.helix.connect("asana")` consents inside a click; provider-bound `/_api/fetch` calls get the *user's* access token injected server-side |
| **LLM gateway** (`/_api/llm/chat`) | `gpt-5-nano` streams a markdown report from the activity digest — no key in the app |
| **Shared app-data** (ADR-0042 prefix grants + the list verb) | reports land at `report:<ts>-<rand>` keys; `GET /_api/data/shared?prefix=report:` lists them |

**Reading reports requires no Asana connection** — anyone who passes the app's gate can list
and open them. Only *generating* needs the signed-in user's own connection, and when a
generation hits `connection_required` the app offers Connect and resumes automatically.

## How it fetches activity

One deliberate choice to know about: Asana's Events API retains events for only **24 hours**,
so it cannot honor an arbitrary time range. The app instead walks the project's tasks
(`GET /tasks?project=<gid>`, `tasks:read`) and reads each task's **stories** — comments and the
system feed (`marked_complete`, assignments, due-date changes — `stories:read`), filtered by
`created_at`. That covers real history. Rails: first 100 tasks, one 4-second-paced story fetch
per crawl (~130 req/min, under Asana's free-tier ceiling), 400 activity entries in the digest.

The digest is compact JSON the LLM summarizes into: Summary, Highlights, Who did what,
Timeline, Risks & loose ends.

## Prerequisites (dev container)

The platform trio, with helix-egress running (delegated calls and the LLM key both ride it):

```bash
pnpm dev:edge     # :8080
pnpm dev:egress   # :8081
pnpm dev:portal   # :3001
pnpm dev:idp      # :3002
```

An `asana` **connection provider** must exist in the portal (ref `asana`, kind
`rest-delegated`, authorize/token endpoints at `app.asana.com/-/oauth_authorize|oauth_token`,
origin `https://app.asana.com`, token placement `header-bearer`), and the Asana app must
register the platform callback `https://auth.local.helix.azxlabs.io:8080/connections/callback`
plus the scopes the provider requests.

## Deploy + set up capabilities

```bash
cd examples/asana-report
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
node --import tsx ../../packages/cli/src/bin.ts create --display-name "Asana Activity Report"
node --import tsx ../../packages/cli/src/bin.ts deploy --promote
```

Then grant the manifest (gpt-5-nano is curated — baseline; the provider-bound origin and the
two report-prefix grants are elevated, so the PUT opens an approval request — locally
`PORTAL_ALLOW_SELF_APPROVE=true` lets one operator approve it):

```bash
PENDING=$(curl -fsS -X PUT "http://localhost:3001/api/v1/apps/asana-report/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" \
  -d '{
    "capabilities": {
      "mcp": [],
      "externalOrigins": [],
      "llm": { "models": ["gpt-5-nano"], "dollarsPerDay": 1 },
      "data": {
        "sharedReadPrefixes": ["report:"],
        "sharedWritePrefixes": ["report:"],
        "writesPerDay": 100
      },
      "fetch": {
        "shim": false,
        "origins": [{ "origin": "https://app.asana.com", "provider": "asana" }]
      },
      "shim": { "fetch": false, "connect": true }
    }
  }' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pending))")

curl -fsS -X POST "http://localhost:3001/api/v1/approvals/$PENDING/approve" \
  -H "authorization: Bearer $HELIX_TOKEN" -H "content-type: application/json" -d '{}'
```

Wait ~1 minute for the edge's registry projection to refresh, then open
`https://asana-report.local.helix.azxlabs.io:8080`, sign in through the dev IdP, and:

1. **Connect Asana** (only if you'll generate) — the popup goes to Asana's consent screen and
   the callback completes on the auth host.
2. Pick a workspace, a project, and a date range → **Generate report** — the report streams
   in, then saves to shared storage.
3. **Reports** tab — list and open every saved report; no connection required.

## Notes

- Reports are append-only: the platform has no shared DELETE verb, so `report:` keys persist.
- The stored value (markdown report, ~a few KiB) sits well under the 64 KiB shared-value cap.
- Writes go through `If-None-Match: *` create-if-absent with a chronological key, so listing
  in key order is chronological and concurrent generates can't clobber each other (ADR-0041).
