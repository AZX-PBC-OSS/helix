# waitlist

A **public** AZX app (no login) that showcases the **app-data gateway** — the
second `/_api/*` capability after the LLM proxy (app-data design doc). It is the
canonical "contact harvester": visitors write their details into a *write-only*
collection that only the owner can read back.

```
visitor ──POST /_api/data/collections/signups──▶ edge ──INSERT-only──▶ app_collection_items
   (browser has NO read verb; edge DB role has NO SELECT)                       │
owner ──GET /api/v1/apps/waitlist/collections/signups──▶ portal ──SELECT──▶ ────┘
```

## What it demonstrates

- **Public visibility, no anon identity (§6).** The app serves to everyone with
  no session; gateway calls are attributed to `anon`. `user`-scope storage is
  unavailable to public apps — only `collection` and `shared` are.
- **Write-only collections (§3.2) — the security centerpiece.** The frontend can
  only `POST /_api/data/collections/signups`. There is **no** list/read/delete
  verb at the edge, and the edge's database role has `INSERT`-only on
  `app_collection_items`, so a compromised edge — or a malicious app — still
  **cannot enumerate** the list. The "Try to read the signup list" button proves
  it: the read is refused.
- **Owner-seeded shared read (§3.3).** An optional announcement banner the owner
  sets once (`shared/announcement`) and every visitor reads. A write grant never
  implies a read grant — and vice versa.
- **No secrets, no backend.** No DB credentials in the bundle; the edge enforces
  authz, partitioning, quotas, and metering.

## Grant the data capability

After `helix create --visibility public`, set the manifest (the CLI manifest
command is a later addition — use the portal API, like `chatbot`):

```bash
curl -fsS -X PUT "http://localhost:3001/api/v1/apps/waitlist/manifest" \
  -H "authorization: Bearer $HELIX_TOKEN" \
  -H "content-type: application/json" \
  -d '{"capabilities":{"data":{
        "collections":["signups"],
        "sharedRead":["announcement"],
        "sharedWrite":["announcement"],
        "writesPerDay":5000
      }}}'
```

`collections` is the write-only harvest. `sharedRead`/`sharedWrite` back the
owner-seeded banner — `sharedWrite` is the rare, dangerous knob (every visitor
could mutate shared state), so here it is used only by the owner at seed time.
`writesPerDay` caps abuse on the open append surface (§7).

## Build & deploy

```bash
cd examples/waitlist
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)

export HELIX_TOKEN="$PORTAL_DEV_TOKEN"
helix create --display-name "Waitlist" --visibility public
# grant the data capability (see above)
helix deploy --promote
```

The data capability comes up with the edge's auth stack (it is gated and
caller-scoped); no vendor key is required. Then open
`https://waitlist.local.helix.azxlabs.io:8080` — no sign-in — and submit.

### Seed the announcement (optional)

The shared banner is owner-seeded. From the app origin (public apps accept an
anonymous, same-origin write to a `sharedWrite` key):

```bash
curl -fsSk -X PUT "https://waitlist.local.helix.azxlabs.io:8080/_api/data/shared/announcement" \
  -H "origin: https://waitlist.local.helix.azxlabs.io:8080" \
  -H "content-type: application/json" \
  -d '"🚀 1,200 founders already joined — early access ships in March."'
```

### Drain the signups (owner)

Read what visitors submitted — a **portal** operation on the privileged role,
never reachable from the app:

```bash
curl -fsS "http://localhost:3001/api/v1/apps/waitlist/collections/signups" \
  -H "authorization: Bearer $HELIX_TOKEN"
# or export: …/collections/signups/export?format=csv
```
