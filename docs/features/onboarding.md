# Onboarding — the in-app guide and the agent skill

> **Related ADRs:** [ADR-0028](../adr/0028-deployment-model-customer-deployed.md) (single-tenant, customer-deployed — why hostnames can't be baked in) · [ADR-0020](../adr/0020-static-only-apps-v1.md) (static-only apps — the first thing anyone must be told) · [ADR-0032](../adr/0032-cli-naming-and-distribution.md) (CLI naming + distribution) · [ADR-0036](../adr/0036-deployment-capability-catalogue.md) (deployment capability catalogue — the instance endpoint that renders the skill and serves the values the docs site can't) · [ADR-0052](../adr/0052-evergreen-agent-skill-and-npx-cli.md) (evergreen skill, npx CLI — what the skill may contain).

The portal provides two guides for building an app:

- **How to develop**, a modal available from the sidebar and My Apps page.
- An agent **SKILL.md** from `packages/deploy-skill`, available to copy or download
  from either location. The rendered skill includes this deployment's hostnames and
  points at the public docs and `helix capabilities` for everything else.

These guides let app authors get started without reading the contributor docs.

## How it works

### The modal

`apps/portal-web/src/modals/HelpModal.tsx`, opened from a **How to develop** button in the
sidebar footer (`components/Shell.tsx`) or from the My Apps handoff band. Two entry points, so
the open state sits on `modals/HelpContext.tsx` — a provider mirroring `modals/DeployContext.tsx`,
mounted above `Shell` in `App.tsx`. The footer pairs the button with two outbound links —
**Source code** and **Report a bug** — to the platform's own upstream repo and its issue tracker,
hardcoded in `Shell.tsx` (see "No external links" below for why that's the one exception).

It covers, in order: what a Helix app is (static frontend, gateway, manifest), the copy/download
buttons, the four steps (create → grant capabilities → build → deploy & promote), then a tab pair
for the two ways to build — **in a browser builder** (the dev-gateway path, see
[dev-mode.md](./dev-mode.md)) and **on your machine** (the `helix` CLI, see [cli.md](./cli.md)) —
and finally the `examples/` apps to start from.

Written as JSX, not markdown: the SPA has no markdown renderer and doesn't need one.

### The skill

`packages/deploy-skill/SKILL.md` is a [Claude Agent Skills](https://code.claude.com/docs/en/skills)
document (YAML frontmatter + markdown) that drops into `.claude/skills/helix/SKILL.md` unmodified
and reads fine pasted into any other agent.

It is **short and evergreen** (ADR-0052). People download it once, so it holds only what stays
true across releases:

- the rules an agent breaks before it would think to look anything up: static frontend only,
  `connect-src 'self'`, compare-and-swap shared writes, no service worker, reserved paths, the web
  app manifest `crossorigin` trap, identity via `/_api/me`;
- this deployment's addresses;
- the npx deploy flow;
- a short checklist;
- pointers to the rest. `npx -y @azx-pbc/helix-cli@latest capabilities` gives live values
  (servable models, baselines, deploy caps, connections, providers, visibility modes, the dev
  gateway). The public docs at `azx-pbc-oss.github.io/helix/apps/*.md` give API detail.

The public docs (`apps/docs/src/apps/`) are the reference. Everything that used to be in the skill
(request shapes, the error table, the connect flow, offline build pitfalls) now lives there.

It ships as a **template** with three placeholders, `{{PORTAL_ORIGIN}}`, `{{APPS_HOST}}`, and
`{{DEV_API_BASE}}`, plus a `<!-- IF:DEV_API -->` block. The portal renders it at `GET /api/v1/skill`
(`renderSkill()`, `packages/deploy-skill/src/index.ts`), and the SPA and `helix skill` fetch that. A
deployment with no dev gateway drops the block entirely rather than handing out a base URL that will
never answer.

### Why values aren't in the skill

The skill used to state servable models, deploy caps, and the four approval baselines, each
substituted from the catalogue at render time. That was accurate on the day of download and stale
after the next operator change or release, with no way to tell everyone to re-download. These values
now come from `helix capabilities`, which reads `GET /api/v1/capabilities` live. The catalogue
remains the single source; the skill just stops copying it.

## Design notes (why)

- **The docs are the reference; the modal and the skill are summaries.** Copies of the developer
  story drift. Anything longer than a couple of lines belongs in `apps/docs/src/apps/`. The modal
  should be short enough that people read it. The skill holds only rules and pointers, and its tests
  reject model ids, budgets, size caps, a global install, a link to a docs page that doesn't exist,
  and growth past 200 lines.
- **A placeholder that reaches an agent is a bug, not a typo.** An agent acts on the file
  literally. `packages/deploy-skill/src/index.test.ts` asserts the rendered output has no
  leftover `{{`, so adding a token without wiring it fails the suite.
- **External links are product identity only.** The modal links nowhere outside the deployment
  except the sidebar's **Source code** / **Report a bug** pair, which points at the upstream repo.
  The skill links the public docs site. Both are hardcoded, like the CLI's npm package name,
  because they identify the product, not a deployment. Downloaded skills link docs pages by URL, so
  `apps/` docs pages must not be renamed or removed.
- **The CLI instructions carry this deployment's `portalUrl`.** The CLI cannot discover its
  portal — it falls back to `http://localhost:3001` (`packages/cli/src/config.ts`) — so a
  `helix.json` copied from here without it makes `helix login` dial a portal that was never
  there, with nothing in the error naming the cause. Both the modal's CLI tab and `SKILL.md`
  print it, in the file rather than as a `--portal-url` flag because the file persists across
  `create`/`deploy`/`promote`. It is printed **before** the command block for the same reason:
  `helix create` reads the slug out of that file. The Deploy modal's one-off reminder command
  uses the flag instead, since there may be no file there yet.
- **The CLI runs from npx at `@latest`** (ADR-0052), so nobody has to install or update it. The
  explicit `@latest` stops npx reusing a stale cached copy, and `-y` skips the prompt an agent can't
  answer. A global `npm i -g @azx-pbc/helix-cli` is mentioned as an option for people who prefer
  it. `npm i -g git+…` cannot resolve this package (workspace `catalog:` specifiers, no prepack
  step), so don't reintroduce it as a fallback.
- **The skill promises nothing unbuilt.** No `@azx-pbc/app-sdk`, no `helix dev`, no MCP transport
  — an agent told those exist will write code against them.

## Planned / not yet built

- **A codemod in the skill** — "rewrite my third-party `fetch` calls to `/_api/fetch/<url>`" is a
  find-and-replace the skill could carry, per [fetch-proxy design §3.1](../design/fetch-proxy.md).
- **Versioned docs.** The public docs track `main`, so a customer deployment running an older
  release can be described by newer docs. The skill tells agents that `capabilities` and the
  portal's errors win, but per-release docs would close the gap.
- **Branching the handoff on browser-vs-agent** — the band pitches the skill to everyone. Someone
  who has said they build in a browser IDE would be better served leading with the dev gateway.
- **Deploying an example in one click** — `examples/` is the obvious "start from something that
  works", but nothing serves those bundles to the SPA today, so the guide can only name them.
