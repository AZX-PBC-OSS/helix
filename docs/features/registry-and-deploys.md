# Registry & deploys

**What it is.** The control plane (`apps/portal` — azx-portal) owns the registry and the deploy
pipeline under `/api/v1`. It is the only writer of the Postgres schema (Prisma 7 + pg driver
adapter); the edge reads a cached projection. Reads are open; mutations take a bearer token
(see [authentication.md](./authentication.md)). Deploys land as **`preview`** versions —
promotion to live is a separate, explicit step (architecture §5.1).

## How it works

### App CRUD (`apps/portal/src/routes/apps.ts`)

```
POST   /api/v1/apps                  create (slug, displayName, visibility, optional capabilities)
GET    /api/v1/apps                  list (open)
GET    /api/v1/apps/:slug            get (open)
POST   /api/v1/apps/:slug/archive    freeze → edge serves 410 + Clear-Site-Data (idempotent)
POST   /api/v1/apps/:slug/unarchive  restore (idempotent)
GET/PUT /api/v1/apps/:slug/manifest  capability grants (see capabilities-and-manifests.md)
```

Slugs are DNS labels (`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`); visibility defaults to `private`.
Every mutation writes an `audit_events` row (`app.create`, `app.archive`, `version.promote`, …).

### Version lifecycle (`apps/portal/src/routes/versions.ts`)

```
POST   /api/v1/apps/:slug/versions                       upload a zip → preview version + CSP warnings
GET    /api/v1/apps/:slug/versions                       list, newest-first
POST   /api/v1/apps/:slug/versions/:number/promote       flip the live pointer
POST   /api/v1/apps/:slug/rollback                        {toNumber?} → revert (defaults to prev live)
```

Versions are immutable and keyed `(appId, number)` with a per-app monotonic 1-based number.
Status is `preview | live | archived`. **Promote** and **rollback** flip the live pointer
atomically in `apps/portal/src/deploy/pointer.ts`: the current live version is archived, the
target is marked `live`, and `app.currentVersionId` is updated in one transaction. Both are
idempotent; promote refuses an archived version (use rollback). The edge sees the flip via the
LISTEN/NOTIFY projection (see [edge-serving.md](./edge-serving.md)).

### Deploy = validate → upload → preview

`POST .../versions` takes a multipart zip and runs (`apps/portal/src/deploy/`):

- **`validate.ts`** — streams the zip, counting **real decompressed bytes** (never trusts zip
  headers). Rejects path traversal (zip-slip), symlinks, non-regular files, and non-static MIME
  types (`mime.ts`).
- **`limits.ts`** — caps: 25 MB/file, 100 MB total, 5,000 entries, 200:1 compression ratio
  (decompression-bomb defense), 512 KB buffered for the lint.
- **`upload.ts`** — streams assets to Blob at `apps/<appId>/<number>/…`, allocates the next
  version number, inserts a `preview` row.
- **`csp-lint.ts`** — a shallow, **non-blocking** advisory: scans HTML/JS for external origins
  not on the platform CDN allowlist and warns if `index.html` is missing. Warnings (file +
  origin + hint) ride back in the `UploadVersionResponse` (`packages/shared/src/api.ts`); the
  upload still succeeds.

### Usage read-side (`apps/portal/src/routes/usage.ts`)

The portal reads the edge-written `gateway_calls` ledger for per-app and platform rollups
(`packages/shared/src/usage.ts`: `UsageSummary`, `GatewayCall`, `PlatformUsage`). The portal SPA
renders these (still partly mock — see [portal-web.md](./portal-web.md)).

## Schema (Prisma — `apps/portal/prisma/schema.prisma`)

- **`apps`** — slug, displayName, `visibilityMode` + `visibilityGroupId`, `currentVersionId`
  (1:1 → live version), `capabilities` JSON, `archivedAt`.
- **`versions`** — `(appId, number)` unique, `blobPrefix`, `status`.
- **`sessions`** — edge-owned session state (portal owns the migration); see
  [authentication.md](./authentication.md).
- **`audit_events`** — append-only `{appId?, actor, action, metadata}`.
- **`gateway_calls`**, **`app_data`**, **`app_collection_items`** — gateway tables (see the
  gateway docs). Migrations live under `apps/portal/prisma/migrations/`.

## Planned / not yet built

- **Approval workflows** for above-baseline capability grants (architecture §6.3) — the portal
  SPA shows a `PREVIEW · M4` approvals queue; the API/policy is not built.
- **Per-app RBAC** — today any authenticated portal principal may mutate (v0).
- **Manifest versioning** history beyond the current full-replace PUT.
