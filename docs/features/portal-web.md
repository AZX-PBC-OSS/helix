# Portal SPA (`portal-web`)

**What it is.** The owner-facing portal UI (`apps/portal-web`) — a Vite + **React 19** +
**Mantine** + TanStack Query + React Router single-page app, pulled forward from v1. It is wired
to the live portal API for everything that exists today, and shows future surfaces as honest
mock screens behind a `PreviewBadge` (`PREVIEW · M4`) — never silently faked. It is the one
package on `moduleResolution: bundler` (the rest are nodenext).

## How it works

### Layout

- `src/App.tsx` — router + Mantine provider; `src/theme/theme.ts` — the custom theme (the
  reference for the project's Mantine styling).
- `src/pages/` — top-level routes; `src/modals/` — create-app + deploy dialogs;
  `src/components/` — shared UI; `src/api/` — the typed client + query/mutation hooks;
  `src/auth/` — browser sign-in; `src/preview/` — mock data for the M4 screens.

### Real, wired-to-the-API surfaces

- **Apps list** (`/`) — grid + create.
- **App detail** (`/apps/:slug`) with tabs:
  - **Overview** — metadata, live + preview versions, deploy/rollback actions.
  - **Versions** — history with promote/rollback (the live version lifecycle).
  - **Capabilities** — a **real** manifest editor against `GET`/`PUT /api/v1/apps/:slug/manifest`
    (LLM models + budget, data flags/lists, external origins, MCP grants — see
    [capabilities-and-manifests.md](./capabilities-and-manifests.md)).
  - **Settings** — visibility, archive/unarchive.
- **Deploy modal** — a drag-and-drop **zip upload** that renders the CSP lint warnings inline
  (see [registry-and-deploys.md](./registry-and-deploys.md)).

`src/api/queries.ts` / `mutations.ts` are TanStack Query hooks over a bearer-injecting client
(`client.ts`): apps, versions, manifest, me, health; createApp, uploadVersion, setManifest,
archive/unarchive.

### Browser sign-in (`src/auth/`)

Code + **PKCE** against the dev IdP's third public client `azx-portal-web` (`oidc.ts` over
`openid-client`; `CallbackPage` handles `/auth/callback`). The token is held **per-tab** in
sessionStorage (`tokenStore.ts`), surfaced through `AuthProvider`. Reads work logged-out;
mutations gate on the token. The IdP's `clientBasedCORS` opens the token endpoint to this client.

### Serving + dev

The portal serves `portal-web/dist` statically when built (deep links fall back to index.html;
`/api` + `/health` stay JSON), and falls back to the old stopgap dashboard when it isn't built
(`apps/portal/src/routes/spa.ts` + `dashboard.ts`). In dev, `pnpm dev:web` (:5173) proxies `/api`
+ `/health` to :3001 — **no CORS anywhere**. `pnpm --filter @helix/portal-web build` makes the
portal serve it at :3001.

## Planned / not yet built (the `PREVIEW · M4` screens)

These render with mock data from `src/preview/` and are clearly badged:

- **Usage** (per-app + platform) — metering dashboards; the ledger exists (`gateway_calls`) but
  the portal read API isn't fully wired into these views yet.
- **Approvals** — above-baseline capability approval queue (no backend policy yet).
- **Violations** — CSP violation reports (no reporting endpoint yet).
- **Audit** — audit-log search over `audit_events`.
- **Platform** — system metrics.

No Playwright/jsdom suite yet — it splits off "when the UI warrants it" (a jsdom Vitest project
is the planned split).
