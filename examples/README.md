# Example apps

Reference apps you can deploy to the platform with the `helix` CLI. They're the
canonical answer to "what does a hosted AZX app look like?" — **static frontends
only**. All dynamic capability (LLM calls, app data, integrations) flows through
the edge gateway (`/_api/*`). The LLM proxy landed in M4; `chatbot` exercises it,
`waitlist` exercises the app-data gateway, `oversell` exercises its write-concurrency
contract (ADR-0041), `github-stars` exercises the CSP origin-grant approval loop,
`fetch-proxy` exercises the M4.5 fetch-proxy + secret-backed connections + transparent
shim, and `offline` exercises the offline capability (ADR-0035).

| App                              | What it shows                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`hello-world`](./hello-world)   | The smallest deployable bundle: HTML + CSS + a line of JS.                                            |
| [`notes`](./notes)               | A realistic self-contained SPA (localStorage), multiple asset types.                                  |
| [`chatbot`](./chatbot)           | Streams Claude through the gateway (`/_api/llm/chat`) — no key in the app, manifest-granted, metered. |
| [`waitlist`](./waitlist)         | A **public** contact harvester: write-only collections + owner-seeded shared read (`/_api/data/*`).   |
| [`oversell`](./oversell)         | Compare-and-swap shared writes (ADR-0041): ETags, mandatory preconditions, one-click 412/428 probes.  |
| [`github-stars`](./github-stars) | Fetches a public API **directly** — CSP-blocked until an admin approves the origin (the approval loop). |
| [`fetch-proxy`](./fetch-proxy)   | Reaches the GitHub API **through the fetch-proxy** — keyless, then secret-injected, then via the shim. |
| [`offline`](./offline)           | Cold-boots with no network via the platform's scope-confined service worker, and shows what the app still owns. |

Each app is a **standalone project** built with [Vite](https://vite.dev) — they
are deliberately *not* part of the pnpm workspace, since they model the
untrusted user apps the platform hosts rather than platform code. The built
`dist/` is **committed to git**, so the primary workflow — running `helix deploy`
on it — needs no build step at all. (`dist/` is normally git-ignored; a negation
rule in the root `.gitignore` re-includes `examples/**/dist/`.)

## Rebuild

Only needed when you change an app's source. Each app builds in isolation, so
run the build from inside its directory:

```bash
cd examples/hello-world
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/
```

Commit the regenerated `dist/` alongside your source changes. (`node_modules/`
and the local `pnpm-lock.yaml` are git-ignored.)

## Deploy

Deploying is a job for the `helix` CLI (`packages/cli`), independent of how an app
was built — see [`packages/cli/README.md`](../packages/cli/README.md) for the
full reference. The portal must be running (`pnpm dev:portal`, on `:3001`) with
Postgres + Azurite up (they are, in the dev container). Mutating routes need the
dev-token stub, which the CLI reads from `HELIX_TOKEN`.

With `helix` installed on your `PATH`, you'd run it from the app directory — it
reads `slug`, `portalUrl`, and `dir` from the app's `helix.json`:

```bash
export HELIX_TOKEN="$PORTAL_DEV_TOKEN"     # same value the portal was started with
cd examples/hello-world
helix create --display-name "Hello World"
helix deploy --promote                     # uploads a preview, then flips it live
helix versions
```

The CLI isn't published yet (M1), so to drive it from this repo, run its dev
entrypoint from the app directory instead of `helix`:

```bash
node --import tsx ../../packages/cli/src/bin.ts deploy --promote
```

`--promote` flips the live pointer in one step; omit it to promote later with
`helix promote <n>`.

## CSP note

The deploy endpoint runs a courtesy CSP lint and warns (non-blocking) about
external origins it would block at serve time. A handful of CDNs are
pre-allowed and produce **no** warning — `cdn.jsdelivr.net`, `unpkg.com`,
`esm.sh`, `cdn.tailwindcss.com`, and Google Fonts (see
`apps/portal/src/deploy/csp-lint.ts`). Most example apps are fully self-hosted,
so they deploy clean — the exception is `github-stars`, which intentionally
calls `api.github.com` to trigger that warning (and, at serve time, a real CSP
violation) so you can walk the origin-grant approval loop.
