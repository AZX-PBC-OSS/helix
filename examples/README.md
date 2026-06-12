# Example apps

Reference apps you can deploy to the platform with the `azx` CLI. They're the
canonical answer to "what does a hosted AZX app look like?" — **static frontends
only**. All dynamic capability (LLM calls, app data, integrations) flows through
the edge gateway (`/_api/*`), which lands in M2–M4; until then these apps are
purely client-side.

| App                            | What it shows                                                        |
| ------------------------------ | -------------------------------------------------------------------- |
| [`hello-world`](./hello-world) | The smallest deployable bundle: HTML + CSS + a line of JS.           |
| [`notes`](./notes)             | A realistic self-contained SPA (localStorage), multiple asset types. |

Each app is a **standalone project** built with [Vite](https://vite.dev) — they
are deliberately *not* part of the pnpm workspace, since they model the
untrusted user apps the platform hosts rather than platform code. The built
`dist/` is **committed to git**, so the primary workflow — running `azx deploy`
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

Deploying is a job for the `azx` CLI (`packages/cli`), independent of how an app
was built. The portal must be running (`pnpm dev:portal`, on `:3001`) with
Postgres + Azurite up (they are, in the dev container). Mutating routes need the
dev-token stub, which the CLI reads from `AZX_TOKEN`.

With `azx` installed on your `PATH`, you'd run it from the app directory — it
reads `slug`, `portalUrl`, and `dir` from the app's `azx.json`:

```bash
export AZX_TOKEN="$PORTAL_DEV_TOKEN"     # same value the portal was started with
cd examples/hello-world
azx create --display-name "Hello World"
azx deploy --promote                     # uploads a preview, then flips it live
azx versions
```

The CLI isn't published yet (M1), so to drive it from this repo, run its dev
entrypoint from the app directory instead of `azx`:

```bash
node --import tsx ../../packages/cli/src/bin.ts deploy --promote
```

`--promote` flips the live pointer in one step; omit it to promote later with
`azx promote <n>`.

## CSP note

The deploy endpoint runs a courtesy CSP lint and warns (non-blocking) about
external origins it would block at serve time. A handful of CDNs are
pre-allowed and produce **no** warning — `cdn.jsdelivr.net`, `unpkg.com`,
`esm.sh`, `cdn.tailwindcss.com`, and Google Fonts (see
`apps/portal/src/deploy/csp-lint.ts`). Both example apps are fully self-hosted,
so they deploy clean.
