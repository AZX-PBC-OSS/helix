# Portal SPA (`portal-web`)

> **Related ADRs:** [ADR-0007](../adr/0007-portal-authz-v0.md) (portal authz v0) · [ADR-0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) (bearer JWT over JWKS) · [ADR-0016](../adr/0016-capability-manifest-approval-classifier.md) (approval classifier) · [ADR-0021](../adr/0021-metering-ledger.md) (metering ledger).

**What it is.** The owner-facing portal UI (`apps/portal-web`) — a Vite + **React 19** +
**Mantine** + TanStack Query + React Router single-page app, pulled forward from v1. **Every
screen is real and wired to the live `/api/v1/*` API** — apps, versions, capabilities, usage,
approvals, CSP violations, the global registry, secrets, and the audit log. The single remaining
`PreviewBadge` marks one not-yet-built sub-feature (per-app RBAC roles), milestone `v1`. Mantine
is a deliberate house choice (the project's reference styling lives in this package's theme); it
is also the one package on `moduleResolution: bundler` (the rest are nodenext).

## How it works

### Layout

- `src/App.tsx` — the router; `src/auth/AuthProvider.tsx` wraps it. `src/theme/theme.ts` — the
  custom Mantine theme (the reference for the project's styling); `src/components/Shell.tsx` — the
  app shell + nav.
- `src/pages/` — top-level routes (`AppsListPage`, `AppDetailPage`, `UsagePage`) and
  `src/pages/admin/` — the admin surfaces. `src/pages/tabs/` — the app-detail tabs.
- `src/modals/` — create-app + deploy dialogs and the confirm dialog; `src/components/` — shared
  UI (`primitives.tsx`, `charts.tsx`, `Icon.tsx`); `src/api/` — the typed client + query/mutation
  hooks; `src/auth/` — browser sign-in.

### Routes (all real, all wired)

- **My Apps** (`/`, `AppsListPage`) — `GET /api/v1/apps` grid + create.
- **App detail** (`/apps/:slug`, `AppDetailPage`) with tabs:
  - **Overview** — metadata, live + preview versions, deploy/rollback actions.
  - **Versions** — history with promote/rollback (the live version lifecycle).
  - **Capabilities** — a manifest editor against `GET`/`PUT /api/v1/apps/:slug/manifest` (LLM
    models + budget, data flags/lists, external origins, fetch-proxy origins, MCP grants — see
    [capabilities-and-manifests.md](./capabilities-and-manifests.md)).
  - **Usage** — per-app metering off `GET /api/v1/apps/:slug/usage`.
  - **Settings** — visibility switcher (`POST /apps/:slug/visibility`): reductions (→ private /
    group) apply immediately, going public opens a confirm-with-reason approval request, and
    `password` mode defers to the shared-password card (`PasswordAccessCard`). Plus
    archive/unarchive, the app-scoped **Secrets** card (`SecretsCard`), and the one preview
    surface — the **Access (RBAC)** card carrying `<PreviewBadge milestone="v1" />` (per-app
    owner/editor/viewer roles are a v1 feature; today any authenticated portal actor may mutate,
    and every action is attributed in the audit trail).
- **Usage** (`/usage`, `UsagePage`) — platform-wide metering off `GET /api/v1/gateway/usage`.
- **Admin** (`src/pages/admin/`):
  - **Approvals** (`/admin/approvals`) — the capability-approval queue off `GET /api/v1/approvals`
    with approve / deny / request-changes mutations (deny + request-changes require a note).
  - **Audit Log** (`/admin/audit`) — `GET /api/v1/gateway/audit` over `gateway_calls`.
  - **Platform** (`/admin/platform`) — system metering off `GET /api/v1/gateway/usage`.
  - **All Apps / Registry** (`/admin/registry`) — the full app list.
  - **Secrets** (`/admin/secrets`) — global connection secrets, full CRUD + per-app grants off
    `GET /api/v1/secrets` (see [secrets-and-connections.md](./secrets-and-connections.md)).
  - **Violations** (`/admin/violations`) — CSP violation reports off `GET /api/v1/csp/violations`,
    each a one-click origin-grant request (`useGrantOrigin`).
- **Deploy modal** — a drag-and-drop **zip upload** that renders the CSP lint warnings inline
  (see [registry-and-deploys.md](./registry-and-deploys.md)).

`src/api/queries.ts` / `mutations.ts` are TanStack Query hooks over a bearer-injecting client
(`client.ts`), every response validated through a `@azx-pbc/shared` zod schema.

### Browser sign-in (`src/auth/`)

Code + **PKCE** against the dev IdP's third public client `azx-portal-web` (`oidc.ts` over
`openid-client`; `CallbackPage` handles `/auth/callback`). The token is held **per-tab** in
sessionStorage (`tokenStore.ts`), surfaced through `AuthProvider`. Sign-in is now required for
every page: a full-page `RequireAuth` gate wraps the SPA and `RequireAdmin` gates `/admin/*` on the
`isAdmin` flag from `/me` (a 401 on `/me` purges the stale token and falls back to logged-out). The
IdP's `clientBasedCORS` is scoped to **this client only**, so the
token endpoint opens to the SPA without opening it to the world.

### Deployment configuration (`src/lib/deployment.ts`)

The SPA's **only** build-time configuration is the portal origin it is served from. Anything
deployment-specific — where apps are served, whether dev mode exists, the admin spend watch line —
comes from the public `GET /api/v1/config` at runtime, via `deploymentConfigQuery` →
`useDeployment()`:

| Field                   | Portal env var             | Absent means                                     |
| ----------------------- | -------------------------- | ------------------------------------------------ |
| `appPublicBase`         | `APP_PUBLIC_BASE`          | never absent (the portal refuses to boot in prod) |
| `devApiBase`            | `DEV_API_PUBLIC_BASE`      | dev mode isn't enabled here — `DevModeTab` says so |
| `platformMonthlyUsdCap` | `PLATFORM_MONTHLY_USD_CAP` | no spend ceiling shown on the admin Activity page  |

This is a **correctness** requirement, not a convenience one. `dist/` is baked into the portal
image, so the previous `import.meta.env.VITE_APP_PUBLIC_BASE` (never set by any Dockerfile, CI job,
or Bicep) meant every deployment displayed the dev domain `*.local.helix.azxlabs.io:8080`. Deriving
it from `window.location` instead was rejected: the port and scheme aren't recoverable (the edge is
:8080 in dev, 443 in prod), local dev serves the portal from `localhost` while apps are on
`local.helix.azxlabs.io`, and `portalExternal` doesn't require the portal to be a sibling of the
apps domain — its failure mode would be a silently wrong-but-plausible URL.

Where a full app object is in hand, prefer `hostFor(app)` / `urlFor(app)`, which use the `url` the
control plane computed (`AppSchema.url`, from `toApp()`); the base-composing `appHost`/`appUrl` are
for previews of apps that don't exist yet (create-app, the empty state). Every getter returns `null`
while the config is in flight or the value is absent, and callers **drop the affected text** rather
than render a guess. Call `useDeployment()` once per component — the returned functions are safe
inside a `.map()`, a hook call would not be.

### Serving + dev

The portal serves `portal-web/dist` statically when built (deep links fall back to index.html;
`/api` + `/health` stay JSON), and falls back to the old stopgap dashboard when it isn't built
(`apps/portal/src/routes/spa.ts` + `dashboard.ts`). In dev, `pnpm dev:web` (:5173) proxies `/api`
+ `/health` to :3001 — **no CORS anywhere**. `pnpm --filter @azx-pbc/portal-web build` makes the
portal serve it at :3001.

## Design notes (why)

- **Never silently fake.** Surfaces that aren't fully built ship as one honest `PreviewBadge`
  rather than a screen that pretends to work — and as those surfaces became real, the badges came
  off. The lone survivor is per-app RBAC (`SettingsTab.tsx`).
- **Dashboards show tokens and cost.** `gateway_calls` stores token/request counts **and** a frozen,
  as-charged `costMicroUsd` priced at write time from a code-resident rate table (ADR-0021); the SPA
  recomputes `costUsd` from that same table for display — the dollar figure is derived from a real
  per-call frozen cost, not fabricated. Token-denominated budgets stay the enforcement unit.
- **CORS is scoped, not opened.** `clientBasedCORS` keying off the SPA client id keeps the cross-
  origin token grant pinned to the one public browser client.
- **Mantine is a house preference** — the theme here is the project's styling reference.

## Planned / not yet built

- **Per-app RBAC** (owner / editor / viewer) — the only `PreviewBadge` left (`milestone="v1"`).
  v0 authz is deliberately flat (authenticated == authorized, ADR-0007): any authenticated portal
  actor may mutate **any** app and manage **any** app's secrets, with **no `ownsApp` check** on the
  app-scoped mutating + secret routes — a live BOLA/IDOR to close before M5 (issue #9), not a benign
  placeholder. Actions are attributed in the audit trail, but attribution is not authorization.
- **No Playwright/E2E suite yet** — there are colocated `*.test.tsx` (apps-list, settings-tab,
  versions-tab, secrets-admin) running under a dedicated **jsdom Vitest project** (root
  `vitest.config.ts` splits the node suite from the portal-web jsdom suite, which carries the React
  plugin + Mantine shims in `src/test/setup.ts`). A browser-driven E2E layer is the future addition.
