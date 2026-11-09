# 0055. Helix app kit: a shared package, presets and one check command for hosted apps

**Status:** Proposed (2026-11-09; from the Franklin team, for review by the Helix owners).

**Related:** ADR [0032](0032-cli-naming-and-distribution.md) (public npm, trusted publishing — the precedent for a second published package), [0051](0051-repo-backed-apps-ci-push-github-oidc.md) (CI pushes the bundle; the deploy gate and its attestation), [0052](0052-evergreen-agent-skill-and-npx-cli.md) (docs are the reference; `/apps/` page URLs are stable), [0041](0041-app-data-write-concurrency.md) (compare-and-swap writes and the 412 retry the runtime wraps), [0035](0035-offline-capability-platform-service-worker.md) (the offline grant behind the redirect rule). **Design:** [`docs/design/helix-app-kit.md`](../design/helix-app-kit.md) (package layout, check stages, template tree, release path, scope).

## Context

Every Helix app is built from scratch against the same platform surface. The
code each app needs first is the same code the last app wrote: a client for the
`/_api/*` gateway, the `window.helix` types, a root redirect into the app's
directory with a guard against redirecting forever, and the tool configuration
that keeps the build honest.

This is not hypothetical. Two real apps built outside this repo — Franklin field
and ListGen — each carry their own copy of the gateway client, the
`window.helix` types, the root redirect with its loop guard, and the tool
configs. Inside this repo, three examples (`examples/asana-report`,
`examples/github-report`, `examples/oauth-demo`) each hand-write a
`src/helix.d.ts` with near-identical ambient declarations. When the gateway
changes, every copy has to be found and updated by hand, and nothing shows where
a copy was missed.

The decision to fix this with a shared kit was made by the Franklin team outside
this repository. This ADR records it here so the Helix maintainers can review it
in the normal place. Nothing described below exists yet; the package, the
template and the command are all proposed.

## Decision

1. **One published package, `@azx-pbc/helix-app`, at `packages/helix-app`.** It
   is published to public npm the way the CLI already is (ADR-0032): trusted
   publishing, no long-lived token, released from its own tag. Releases are cut
   with Changesets, so a consumer can see what changed before bumping. The
   package holds three things:

   - **The runtime.** A gateway client with typed methods for `me`, `llm`,
     `data`, `fetch` and `jobs`. The `data` client does compare-and-swap
     writes (ADR-0041) with bounded retries on 412. It exports the
     `window.helix` types, so the examples stop hand-writing `helix.d.ts`. It
     exports a `SessionExpiredError`, and it maps the gateway's error statuses —
     401, 403, 429, and the `connection_required` error — to states an app can
     show the user instead of making each app re-derive them. It ships TanStack
     Query defaults that match the gateway's caching and error behaviour.
   - **Presets.** A tsconfig base, an ESLint preset carrying the limits below,
     Prettier, knip defaults, and Vitest presets — unit (jsdom) and browser
     (Playwright) — split by filename: `*.browser.test.*` runs in a browser,
     everything else runs in jsdom. The lint preset ships a self-test that
     proves each rule fires on a fixture, so a silent rule regression fails a
     test instead of quietly stopping linting.
   - **Build tools.** A `build` command; a `check-dist` command that inspects
     the output, including the redirect-loop guard (a root `index.html` that
     redirects to the app directory must not be served for a URL that already
     resolves there); a CSP smoke test that loads the built app against the
     real policy; a Vite dev relay that forwards `/_api/*` to the dev gateway
     and adds the `authorization` header server-side, keeping the dev token out
     of the bundle; and a Vite plugin that ships workers and worklets as
     same-origin files, which the platform's CSP requires.

2. **One command, `helix-app check`.** It runs, in order: types, lint, format,
   knip, unit tests, browser tests, build, and output checks. It prints what
   failed and how to fix it. An app's CI (and an author's pre-push habit) is one
   line.

3. **A template, `npm create @azx-pbc/helix-app`.** It scaffolds an app with
   `src/platform/` as the only directory that names `/_api` — every gateway call
   goes through the kit's client, and the lint rules below enforce it — and
   around it `domain/`, `screens/<feature>/`, `components/`, and `routes/`. The
   template ships a short `AGENTS.md` (under about 150 lines): a map of the
   tree, the check command, and what to do when a limit is hit. It also ships a
   GitHub Actions workflow that runs `helix-app check`, and the deploy of
   ADR-0051 is gated on that workflow.

4. **Limits, enforced as lint errors.** Line counts exclude blank lines and
   comments. The limits:

   - 400 lines per source file;
   - 1,000 lines per test file;
   - about 80 lines per function (tests are exempt);
   - cyclomatic complexity 15 and cognitive complexity 15;
   - nesting depth 4;
   - 4 function parameters;
   - 15 modules per folder;
   - no import cycles;
   - `/_api` and vendor telemetry SDK names only under `src/platform/`;
   - every lint suppression comment carries a reason.

   The limits are advisory in the docs and errors in the lint preset. An app
   that hits one restructures or suppresses with a reason; the `AGENTS.md`
   tells an agent which of the two to try first.

5. **A default stack, named by the template and not required by the check.**
   The template scaffolds React 19, Mantine, TanStack Router (file-based, hash
   history under `/app/index.html`), TanStack Query, zod at the boundaries, and
   Tabler icons. It ships no global state store; when an app needs one, the
   documented choice is Redux Toolkit without RTK Query or redux-persist — the
   gateway client and the platform cache take those jobs. Offline storage is
   later work through a kit module: Dexie or an in-memory store behind one
   interface, an outbox of commands, and sync against app data that re-runs a
   command after a 412.

   The check stays stack-neutral. It lint-checks what the preset loads and
   checks output by shape, not by framework, so Helix keeps hosting any static
   app, including one that uses none of the default stack.

6. **Updates are agent-followable.** Every breaking release of the kit ships a
   codemod for the mechanical parts and an `UPGRADE.md` written so an agent can
   follow it. Renovate opens the bump in each app's repository; the app's CI
   runs `helix-app check` on the bump PR.

## Consequences

- **Helix maintains a second published package.** The CLI is the first; the kit
  is the second, and it is consumed by far more code than the CLI is. Its
  public surface becomes a compatibility promise to apps that outlive it.
- **Gateway changes must update the kit in the same PR.** The kit wraps
  `/_api/*`; a gateway change that lands without a matching kit change breaks
  every app on the next bump instead of one app now. This is the same-PR rule
  the edge applies to its own contracts, extended to a package the edge does
  not import.
- **The redirect-loop guard moves from app code into the kit.** Each app writes
  the root redirect; the kit's `check-dist` proves it cannot loop. Today no
  check does this, and the failure mode (a redirect served for a URL that
  already resolves into the app directory) is documented in
  [`apps/docs/src/apps/serving-and-csp.md`](../../apps/docs/src/apps/serving-and-csp.md).
  Moving the guard into the kit is only an improvement for apps built from the
  template; hand-built apps keep today's position.
- **Open question, not decided here: a deploy-time check.** Whether Helix runs
  `helix-app check` itself when a deploy arrives — instead of trusting the CI
  attestation ADR-0051 already records — is left open. Running it costs build
  capacity and adds a rejection path at the deploy endpoint; trusting the
  attestation assumes the app's CI was not bypassed. This ADR records neither
  choice.

## Rejected

- **A framework that owns build, routing and UI** (a Helix-branded Next). It
  would make the platform a hosting target for one framework's output and tie
  every app to its release cycle. Helix hosts static files; the kit keeps it
  that way by staying stack-neutral where it can and template-only where it
  cannot.
- **Guidance files alone** — a better `AGENTS.md` and docs, no package. The two
  real apps already show the outcome: guidance is read once and copied once,
  and the copies drift. The failure this ADR fixes is drift, and only shared
  code fixes drift.
- **A template with no shared package.** The template would stamp out fresh
  copies of the gateway client and types at creation time. Every app would
  start correct and drift from its first gateway change. The package is the
  part that keeps working after the scaffold is a week old.
