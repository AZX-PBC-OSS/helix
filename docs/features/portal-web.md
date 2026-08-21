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
- `src/modals/` — create-app + deploy dialogs, the confirm dialog, and the onboarding
  `HelpModal`; `src/components/` — shared UI (`primitives.tsx`, `charts.tsx`, `Icon.tsx`);
  `src/api/` — the typed client + query/mutation hooks; `src/auth/` — browser sign-in;
  `src/lib/` — `deployment.ts` (runtime topology) and `download.ts` (client-generated files).

### Routes (all real, all wired)

- **Apps** (`/`, `AppsListPage`) — the one presentation of the registry: a dense table
  (`components/AppsTable.tsx`) over `GET /api/v1/apps`, plus create, under a band handing the
  agent skill straight over (see [Onboarding](#onboarding-srcmodalshelpmodaltsx)). A **Mine / Everyone's**
  control drives `?scope=`; every column (owner, live version, last deploy) comes
  from the list endpoint's own projection, so the page costs a fixed number of queries at any row
  count, and spend joins `GET /api/v1/gateway/usage`'s `byApp` by slug.

  Scope is a **filter, not a gate.** Any signed-in principal may read `scope=all` — a deployment
  serves one trusted org (ADR-0028/ADR-0023), and "whose app is this, and who do I ask about it"
  is a question the portal should answer. Read-scoping as *authorization* is still v1 RBAC's job
  (ADR-0007); nothing here narrows what a caller may read.

  This replaced a 3-up card grid plus a separate admin-only table at `/admin/registry`. Both
  rendered the same unscoped `GET /api/v1/apps`, so they showed identical rows under two names —
  and the card grid fetched `GET /versions` per card to fill in its sparkline and counters, while
  the table, having no version rows to consult, reported an app with a build awaiting promote as
  never deployed. The projection fixed both. `/admin/registry` now redirects to `/?scope=all`.
- **App detail** (`/apps/:slug`, `AppDetailPage`) with tabs:
  - **Overview** — metadata, live + preview versions, deploy/rollback actions.
  - **Versions** — history with promote/rollback (the live version lifecycle).
  - **Capabilities** — a manifest editor against `GET`/`PUT /api/v1/apps/:slug/manifest` (LLM
    models + budget, data flags/lists, external origins, fetch-proxy origins, MCP grants — see
    [capabilities-and-manifests.md](./capabilities-and-manifests.md)).
  - **Usage** — per-app metering off `GET /api/v1/apps/:slug/usage`.
  - **Data** — the owner's drain for write-only collections (`DataTab`): a collection picker with
    row counts off `GET /api/v1/apps/:slug/collections`, the newest 200 rows, per-row raw-JSON
    detail, single-item erasure, and CSV/JSON download. Columns are **derived** from the rows —
    collected items have no declared schema — via the shared `deriveCollectionColumns`. Defaults to
    the `prod` tier and states how many rows the filter is holding back. See
    [app-data-gateway.md](./app-data-gateway.md).
  - **Access** — visibility switcher (`POST /apps/:slug/visibility`): the SSO-gated modes (→ internal /
    group) apply immediately, going public opens a confirm-with-reason approval request, and
    `password` mode defers to the shared-password card (`PasswordAccessCard`). The `group` row is
    the one that stays actionable while it is already current, because its action is "edit which
    groups" — `GroupPicker` (a Mantine `MultiSelect` over `GET /api/v1/directory/groups`, defaulting
    to the caller's own claim-derived groups from `/directory/my-groups`, capped at
    `MAX_VISIBILITY_GROUPS`) plus an add-by-id field for a group search can't reach. Where the
    deployment has no Graph grant the search control is hidden and the id field carries a banner
    naming the missing permission — the gate is unaffected either way (ADR-0040). Plus
    archive/unarchive and the one preview surface — the **Access (RBAC)** card carrying
    `<PreviewBadge milestone="v1" />` (per-app owner/editor/viewer roles are a v1 feature; today
    `ownsApp` gates app-scoped mutations and any read returning per-subject data, and every action
    is attributed in the audit trail). The app-scoped **Secrets** card (`SecretsCard`) lives under
    _Capabilities_, next to the origins it is bound to.
  - **Dev mode** — registers the foreign origins a dev token may be used from and mints the scoped
    bearer for the `env=dev` partition (`DevModeTab`; the token is shown once). Says so plainly
    when the deployment has no dev gateway.
- **Usage** (`/usage`, `UsagePage`) — platform-wide metering off `GET /api/v1/gateway/usage`.
- **Admin** (`src/pages/admin/`):
  - **Approvals** (`/admin/approvals`) — the capability-approval queue off `GET /api/v1/approvals`
    with approve / deny / request-changes mutations (deny + request-changes require a note). A
    decision that lost a race to another admin comes back `409` and is reported as _"someone else
    already denied this request"_ rather than as a failure; every decision mutation invalidates
    `onSettled`, so the queue refetches on conflict too and the row shows the decision that landed.
    Withdraw exists on the API (the requester's verb) but has no UI yet.
  - **Audit Log** (`/admin/audit`) — `GET /api/v1/gateway/audit` over `gateway_calls`.
  - **Platform** (`/admin/platform`) — system metering off `GET /api/v1/gateway/usage`.
  - **Secrets** (`/admin/secrets`) — global connection secrets, full CRUD + per-app grants off
    `GET /api/v1/secrets` (see [secrets-and-connections.md](./secrets-and-connections.md)).
  - **Violations** (`/admin/violations`) — CSP violation reports off `GET /api/v1/csp/violations`,
    each a one-click origin-grant request (`useGrantOrigin`).
- **Creating vs deploying** — two jobs, each on the screen its object lives on. **Create app**
  (`CreateAppModal` over the shared `AppCreateForm`, `openCreate` on `DeployContext`) is the sole
  creation surface and lives on **Apps**, in the page header and in the empty state; it
  navigates to the new app's page on success. **Deploy** (`src/modals/DeployModal.tsx`) is opened
  only from an app — its detail header — and takes the slug it ships into, so `openDeploy(slug)`
  has no untargeted form and the modal has no app picker. Inside is a two-item `Accordion`, not a
  tab strip of equals: **Upload a build** is open, and **Deploy from the command line** starts
  collapsed. Which one is open follows from who is standing there — a developer using `helix`
  deploys from a terminal without opening the portal at all, so whoever reaches this modal is
  overwhelmingly the one who can't: no checkout, no terminal, an app built in a browser. The CLI
  block is kept as a reference rather than a rival path, and its closed row carries the subtitle
  "For developers using the helix CLI" so everyone else can skip it without opening anything
  (back when it was a tab of equal weight, one of them asked us where their "app directory"
  was). The accordion is `multiple`, so opening the CLI doesn't collapse the dropzone; once a
  version lands the accordion is replaced outright by the upload receipt, since that screen has
  nothing left to choose. CSP lint warnings render inline on that receipt
  (see [registry-and-deploys.md](./registry-and-deploys.md)).

  Creation must stay reachable **independent of how many apps exist**: it once lived only in the
  deploy picker's `nothingFoundMessage`, so a single registered app hid the only path to a second
  one. That guarantee now rests on the unconditional Apps-page button, and `apps-list.test.tsx`
  holds the line. Visibility at create is `internal` only, and the form no longer **asks** — a
  control whose every other row is locked reads as a choice it isn't, so it states what the app
  will be and points at the Access tab. Two constants in `AppCreateForm.tsx` govern this:
  `UNAVAILABLE_AT_CREATE` (which modes are locked — `password`/`public` are deferred and
  additionally gated on deployment policy; `group` is locked not on a missing check but on a
  per-deployment one, since a tenant only emits security-group claims once an operator applies
  [`entra-group-claims-rollout.md`](../runbooks/entra-group-claims-rollout.md), and until then a
  `group` app created here would lock out its own creator on its first request — the Access tab
  offers it because there the app already exists and the change is one click to undo) and
  `SHOW_VISIBILITY_AT_CREATE`, the render switch, flipped back on when a second mode unlocks.

- **Bundle salvage** (`src/deploy/`, [ADR-0038](../adr/0038-bundle-salvage-in-the-portal-spa.md)) —
  the deploy modal's upload section accepts a dropped **build folder** as well as a zip — each
  with its own click-to-choose link under the dropzone, since drag-and-drop doesn't reach
  everyone — because
  non-technical users told to "zip the contents of `dist/`" send the whole project, the folder
  wrapped in itself, or a random directory. `archive.ts` (the one `fflate`-aware module) reads
  the drop — listing a zip's central directory without inflating a byte, so a `node_modules`
  upload is refused before it can OOM the tab — and the pure planner in
  `@azx-pbc/shared/bundlePlan` decides the real build root, drops junk/secrets, and resolves each
  HTML file's local references. A **canonical** upload ships untouched with no gate; anything else
  raises `FixBundleFlow.tsx`, which states the assumption (which folder is the build), lists the
  files that will ship, offers the ranked alternate roots, and shouts about dropped secrets and
  broken references — then rebuilds the canonical zip client-side and uploads it. The offline
  scope from the app manifest pins (or safely nests under) the granted prefix rather than
  stripping it. `UploadStep.tsx` drives the sub-flow; what it did is sent as a client-asserted
  `deployReport` and shown as a quiet **salvaged** badge on the Versions tab.

`src/api/queries.ts` / `mutations.ts` are TanStack Query hooks over a bearer-injecting client
(`client.ts`), every response validated through a `@azx-pbc/shared` zod schema.

### Onboarding (`src/modals/HelpModal.tsx`)

A **How to develop** button — in the sidebar footer, and on the Apps page's handoff band — opens a
modal summarising the platform for a newcomer — what a Helix app is, the four steps from empty account to live app, and a tab pair for
the two ways to build (browser builder via the dev gateway, or the `helix` CLI). Its **Copy** /
**Download** buttons hand out `packages/deploy-skill/SKILL.md`, rendered with this deployment's
hostnames, for a coding agent to load.

`lib/skill.ts` (`useRenderedSkill`) does that rendering for both surfaces, and owns the rule that
matters: the skill is `null` — and every button offering it disabled — until `GET /api/v1/config`
lands, because a skill with a `{{PLACEHOLDER}}` host in it is worse for an agent than no skill.
The band on **Apps** replaced four stat cards counting apps by state; the skill is re-copied
every time someone starts an app or a fresh agent session, so it earns a permanent place there
where a first-run-only nudge would not. Open state for the modal lives on `modals/HelpContext.tsx`.

The modal is the summary and `SKILL.md` is the reference — keep long-form content in the skill so
the two can't tell different stories. The skill is imported with Vite's `?raw` (bundled, not
fetched, because a static-asset miss returns `index.html` here). Full write-up:
[onboarding.md](./onboarding.md).

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
  off. The lone survivor is per-app RBAC — the **Access (RBAC)** card on the Access tab
  (`AccessTab.tsx`; the tab was renamed from Settings).
- **Dashboards show tokens and cost.** `gateway_calls` stores token/request counts **and** a frozen,
  as-charged `costMicroUsd` priced at write time from a code-resident rate table (ADR-0021); the SPA
  recomputes `costUsd` from that same table for display — the dollar figure is derived from a real
  per-call frozen cost, not fabricated. Token-denominated budgets stay the enforcement unit.
- **CORS is scoped, not opened.** `clientBasedCORS` keying off the SPA client id keeps the cross-
  origin token grant pinned to the one public browser client.
- **Mantine is a house preference** — the theme here is the project's styling reference.

## Planned / not yet built

- **Per-app RBAC** (owner / editor / viewer) — the only `PreviewBadge` left (`milestone="v1"`).
  v0 authz was deliberately flat (authenticated == authorized, ADR-0007). The server side is no
  longer flat for **writes**: an `ownsApp` owner-or-admin gate guards the app-scoped mutating and
  secret routes (issue #9). Two things remain — reads are still authenticated-only, and the SPA
  still *renders* mutate controls for apps the actor doesn't own, so the 403 is the boundary rather
  than the UI. Actions are attributed in the audit trail, but attribution is not authorization.
- **No Playwright/E2E suite yet** — there are colocated `*.test.tsx` (apps-list, settings-tab,
  versions-tab, secrets-admin) running under a dedicated **jsdom Vitest project** (root
  `vitest.config.ts` splits the node suite from the portal-web jsdom suite, which carries the React
  plugin + Mantine shims in `src/test/setup.ts`). A browser-driven E2E layer is the future addition.
