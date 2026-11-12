# Helix app kit — package design

This note is the implementation design behind
[ADR-0055](../adr/0055-helix-app-kit.md) (the decision and its context). The
package, template and command described here do not exist yet; this is the
intended shape. Read the ADR first for the why.

## Package layout

`@azx-pbc/helix-app` lives at `packages/helix-app` and is the repo's second
published package (the CLI is the first, ADR-0032).

```
packages/helix-app/
  src/
    runtime/        gateway client, window.helix types, error mapping,
                    SessionExpiredError, TanStack Query defaults
    presets/        tsconfig, lint (the limits), prettier, knip,
                    vitest unit (jsdom) and browser (Playwright)
    tools/          build, check-dist, csp smoke test, vite dev relay,
                    vite worker/worklet plugin
    check/          the helix-app check command: stages, output, fix hints
    codemods/       one directory per breaking release
  tests/            presets self-test (every lint rule fires on a fixture),
                    runtime tests against a fixture gateway
```

`src/runtime` is the only directory that names `/_api`. The lint preset enforces
the same rule in consumer apps, and the kit holds itself to it first.

## The check's stages, in order

`helix-app check` runs the stages in this order and stops a stage only when a
later stage cannot run without it (types before build). It always prints every
failure it found and how to fix it:

1. **types** — `tsc --noEmit` over the app's tsconfig.
2. **lint** — the kit's lint preset, including the limits (ADR-0055,
   decision 4).
3. **format** — Prettier check against the kit's Prettier preset.
4. **knip** — unused files, exports and dependencies against the kit's knip
   defaults.
5. **unit** — Vitest unit project (jsdom).
6. **browser** — Vitest browser project (Playwright), `*.browser.test.*` files
   only.
7. **build** — the kit's `build` command.
8. **output checks** — `check-dist`: the redirect-loop guard, the CSP smoke
   test, workers and worklets shipped as same-origin files, and no dev token in
   the bundle.

## The template tree

`npm create @azx-pbc/helix-app` scaffolds:

```
  src/
    platform/       the only place that names /_api; the kit client lives here
    domain/         app types and pure logic
    screens/<feature>/  one folder per screen feature
    components/     shared presentational pieces
    routes/         TanStack Router file-based routes (hash history,
                    mounted under /app/index.html)
  AGENTS.md         under ~150 lines: tree map, the check command,
                    what to do when a limit is hit
  .github/workflows/check.yml   runs helix-app check on push and PR
  .github/workflows/deploy.yml  the ADR-0051 deploy, gated on check.yml
```

The default stack is React 19, Mantine, TanStack Router, TanStack Query, zod at
the boundaries, Tabler icons, and no global store (Redux Toolkit without RTK
Query or redux-persist when an app needs one). The template names it; the check
does not require it.

## Release path

Releases are cut with Changesets. A PR that changes the package adds a changeset
describing the break; on merge, the release workflow publishes to npm under the
`cli-v*`-style trusted publishing the CLI already uses, on a `helix-app-v*` tag.
Every breaking release ships a codemod under `src/codemods/` and an
`UPGRADE.md` at the package root written so an agent can follow it. Renovate
opens the bump in each app's repository, and the app's own CI runs
`helix-app check` on the bump PR, so a breaking release is proven against every
consumer before it merges.

## Scope

- **v0.1** — the runtime (gateway client, `window.helix` types,
  `SessionExpiredError`, error mapping, TanStack Query defaults), the presets,
  the build tools, and `helix-app check`. The template.
- **v0.2** — a gateway-error states check: `check-dist` (or lint) fails when a
  screen handles fetch errors without using the kit's mapped states, so apps do
  not quietly re-derive 401/403/429 handling. A compare-and-swap check: fails
  when app code writes `shared` keys without the CAS client (ADR-0041 makes CAS
  mandatory there).
- **Later** — a capability-manifest check: the deploy manifest is checked
  against what the built app actually calls (connections referenced, `offline`
  scope versus the redirect target), so a grant is requested before the app
  ships, not after a 403.
- **Later** — the offline storage kit module: Dexie or an in-memory store behind
  one interface, an outbox of commands, and sync that re-runs a command after a
  412.
