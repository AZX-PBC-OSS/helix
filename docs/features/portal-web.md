# Portal SPA (`portal-web`)

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
(`client.ts`), every response validated through a `@helix/shared` zod schema.

### Browser sign-in (`src/auth/`)

Code + **PKCE** against the dev IdP's third public client `azx-portal-web` (`oidc.ts` over
`openid-client`; `CallbackPage` handles `/auth/callback`). The token is held **per-tab** in
sessionStorage (`tokenStore.ts`), surfaced through `AuthProvider`. Reads work logged-out;
mutations gate on the token. The IdP's `clientBasedCORS` is scoped to **this client only**, so the
token endpoint opens to the SPA without opening it to the world.

### Serving + dev

The portal serves `portal-web/dist` statically when built (deep links fall back to index.html;
`/api` + `/health` stay JSON), and falls back to the old stopgap dashboard when it isn't built
(`apps/portal/src/routes/spa.ts` + `dashboard.ts`). In dev, `pnpm dev:web` (:5173) proxies `/api`
+ `/health` to :3001 — **no CORS anywhere**. `pnpm --filter @helix/portal-web build` makes the
portal serve it at :3001.

## Design notes (why)

- **Never silently fake.** Surfaces that aren't fully built ship as one honest `PreviewBadge`
  rather than a screen that pretends to work — and as those surfaces became real, the badges came
  off. The lone survivor is per-app RBAC (`SettingsTab.tsx`).
- **Dashboards show tokens, not dollars.** `gateway_calls` stores token counts and request counts,
  not cost — so the usage views report tokens and counts. No fabricated cost column.
- **CORS is scoped, not opened.** `clientBasedCORS` keying off the SPA client id keeps the cross-
  origin token grant pinned to the one public browser client.
- **Mantine is a house preference** — the theme here is the project's styling reference.

## Planned / not yet built

- **Per-app RBAC** (owner / editor / viewer) — the only `PreviewBadge` left (`milestone="v1"`).
  Today any authenticated portal actor may mutate; actions are attributed in the audit trail.
- **No Playwright/E2E suite yet** — there are colocated `*.test.tsx` (apps-list, settings-tab,
  versions-tab, secrets-admin) running under a dedicated **jsdom Vitest project** (root
  `vitest.config.ts` splits the node suite from the portal-web jsdom suite, which carries the React
  plugin + Mantine shims in `src/test/setup.ts`). A browser-driven E2E layer is the future addition.
