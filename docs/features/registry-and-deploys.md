# Registry & deploys

> **Related ADRs:** [ADR-0018](../adr/0018-deploy-model-immutable-versions.md) (immutable versions, preview→live) · [ADR-0017](../adr/0017-registry-listen-notify-projection.md) (LISTEN/NOTIFY projection) · [ADR-0021](../adr/0021-metering-ledger.md) (metering ledger) · [ADR-0016](../adr/0016-capability-manifest-approval-classifier.md) (approval classifier) · [ADR-0026](../adr/0026-hosted-build-isolation-prerequisites.md) (hosted-build isolation).

**What it is.** The control plane (`apps/portal` — azx-portal) owns the registry and the deploy
pipeline under `/api/v1`. It is the only writer of the Postgres schema (Prisma 7 + pg driver
adapter); the edge reads a cached projection. All `/api/v1` routes — reads and mutations
alike — require a bearer token (only `/health` and the auth-config bootstrap stay public);
see [authentication.md](./authentication.md). Deploys land as **`preview`** versions —
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
POST   /api/v1/apps/:slug/visibility set gate mode (→public is elevated → approval; →password refused)
POST   /api/v1/apps/:slug/access/origin       grant a CSP/proxy origin (routes through the write-gate)
POST/GET /api/v1/apps/:slug/access/password   mint/rotate/read the shared passphrase
```

Capability/visibility/origin mutations route through one write-gate (`applyCapabilityChange`):
a reduction in privilege commits immediately; an above-baseline delta (bigger budgets, non-curated
models, any MCP/external origin, visibility→public) opens an `ApprovalRequest` instead of applying
(see [docs/design/approvals.md](../design/approvals.md)). Enabling `password` is refused here — it
needs a minted credential, so it has its own `/access/password` routes.

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
renders these for real (see [portal-web.md](./portal-web.md)). The ledger carries tokens, request
counts, outcome, capability, model, user, app and timestamp, **plus a frozen, as-charged
`costMicroUsd`** priced at write time from a code-resident rate table (ADR-0021) — so a later rate
change never rewrites history. The portal recomputes `costUsd` for dashboards from the same rate
table. The ledger deliberately records **no** latency or error detail (it is a metering + budget
primitive, not an observability sink).

## Schema (Prisma — `apps/portal/prisma/schema.prisma`)

- **`apps`** — slug, displayName, `visibilityMode` + `visibilityGroupId`, `currentVersionId`
  (1:1 → live version), `capabilities` JSON, `archivedAt`.
- **`versions`** — `(appId, number)` unique, `blobPrefix`, `status`.
- **`sessions`** — edge-owned session state (portal owns the migration); see
  [authentication.md](./authentication.md).
- **`audit_events`** — append-only `{appId?, actor, action, metadata}`.
- **`gateway_calls`**, **`app_data`**, **`app_collection_items`** — gateway tables (see the
  gateway docs). Migrations live under `apps/portal/prisma/migrations/`.

## Design notes (why)

- **Immutable versions, a pointer flip for the cutover.** A version is write-once: its bytes live
  at a content-addressed Blob prefix and never change. Going live is not a re-upload but a single
  transactional move of `app.currentVersionId` (`deploy/pointer.ts`). That makes promote and
  rollback the *same* cheap, atomic, instantly-reversible operation, and it is why HTML is served
  `no-cache` — the pointer flip must be visible on the next request.
- **Preview-then-promote.** A deploy lands as `preview` and serves nowhere until an explicit
  promote. The upload (untrusted zip handling, CSP lint) and the cutover (a privileged pointer
  move) are deliberately separate steps, so a bad build is inspected before it can take traffic.
- **The edge reads a projection, not the registry.** The portal owns every write; the edge holds
  an in-memory cache refreshed over LISTEN/NOTIFY (see [edge-serving.md](./edge-serving.md)). The
  data path therefore does not depend on the portal being up — the control plane can be down for a
  deploy and apps keep serving the last-projected pointers.
- **Decompression-bomb defense counts real bytes.** `validate.ts` never trusts a zip's declared
  sizes; it streams and counts decompressed output against the `limits.ts` caps, so a 200:1 ratio
  or a header-lied size is caught mid-stream, not after a disk fills.

## Planned / not yet built

- **Per-app RBAC** — `App.ownerId` is recorded at create, but per-app owner/editor/viewer roles
  are not yet enforced. v0 authz is deliberately flat (authenticated == authorized, ADR-0007): any
  authenticated portal principal may mutate **any** app and manage **any** app's secrets — the app-
  scoped mutating + secret routes perform **no `ownsApp` check**. That flatness is a deliberate v0
  choice for the single-operator pilot, but the missing ownership check is a live BOLA/IDOR to close
  before M5 (issue #9), not a benign placeholder — the roles UI surface is separately marked with a
  `PreviewBadge` in the portal SPA.
- **Manifest versioning** history beyond the current full-replace PUT.

> Approval workflows for above-baseline capability/CSP/visibility changes are **built**, not
> planned — `/api/v1/approvals` with approve/deny/needs_changes/withdraw, the typed-diff
> classifier in `@azx-pbc/shared`, and apply-on-approve. See
> [docs/design/approvals.md](../design/approvals.md).
