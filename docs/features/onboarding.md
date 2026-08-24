# Onboarding — the in-app guide and the agent skill

> **Related ADRs:** [ADR-0028](../adr/0028-deployment-model-customer-deployed.md) (single-tenant, customer-deployed — why hostnames can't be baked in) · [ADR-0020](../adr/0020-static-only-apps-v1.md) (static-only apps — the first thing anyone must be told) · [ADR-0032](../adr/0032-cli-naming-and-distribution.md) (CLI naming + distribution — where the `npm i -g` line comes from) · [ADR-0036](../adr/0036-deployment-capability-catalogue.md) (deployment capability catalogue — the instance endpoint that renders the skill and serves the values the docs site can't).

**What it is.** The path from "I have a portal account" to "I have a deployed app", surfaced
where people actually are. Two pieces:

- **The "How to develop" modal** in the portal SPA — a short, readable summary of the platform
  for a human, reachable from the sidebar on every screen.
- **`packages/deploy-skill`** — the same story in full, as a `SKILL.md` a coding agent can load,
  handed out from that modal by **Copy** or **Download** with this deployment's real hostnames
  already substituted in — and, since it is the thing people actually come for, from a band on
  **My Apps** without opening the modal at all.

The platform's documentation is extensive and all of it lives in the repo. Someone building an
app in a browser IDE will never see it. This is the surface that closes that gap.

## How it works

### The modal

`apps/portal-web/src/modals/HelpModal.tsx`, opened from a **How to develop** button in the
sidebar footer (`components/Shell.tsx`) or from the My Apps handoff band. Two entry points, so
the open state sits on `modals/HelpContext.tsx` — a provider mirroring `modals/DeployContext.tsx`,
mounted above `Shell` in `App.tsx`.

It covers, in order: what a Helix app is (static frontend, gateway, manifest), the copy/download
buttons, the four steps (create → grant capabilities → build → deploy & promote), then a tab pair
for the two ways to build — **in a browser builder** (the dev-gateway path, see
[dev-mode.md](./dev-mode.md)) and **on your machine** (the `helix` CLI, see [cli.md](./cli.md)) —
and finally the `examples/` apps to start from.

Written as JSX, not markdown: the SPA has no markdown renderer and doesn't need one.

### The skill

`packages/deploy-skill/SKILL.md` is a [Claude Agent Skills](https://code.claude.com/docs/en/skills)
document (YAML frontmatter + markdown) that drops into `.claude/skills/helix/SKILL.md` unmodified
and reads fine pasted into any other agent. It is the reference version of the same story: the
static-frontend constraint, the CSP an app must live inside, the manifest shape, the `/_api/*`
endpoints with real request/response shapes, the deploy contract and its limits, the error codes
worth handling, and a pre-flight checklist.

It ships as a **template**. Hostnames differ per deployment and the dev gateway is opt-in, so the
file carries `{{PORTAL_ORIGIN}}`, `{{APPS_HOST}}`, `{{DEV_API_BASE}}`, `{{LLM_MODELS}}`, the deploy
caps, and the four `{{BASELINE_*}}` approval thresholds, plus a `<!-- IF:DEV_API -->` block.
`renderSkill()` (`packages/deploy-skill/src/index.ts`) fills them; the portal renders it server-side
at `GET /api/v1/skill` from the capability catalogue, and the SPA fetches that (ADR-0036). A
deployment with no dev gateway loses that section entirely rather than being handed a base URL that
will never answer — the same degradation the **Dev mode** tab does.

The models offered come from the catalogue's **servable** list (curated ∩ the upstream family has a
seeded `platform` secret), not the curated superset, so "what this platform will serve" cannot drift
from what it prices *and* what it can actually route — a deployment that never seeded the `openai`
key stops advertising `gpt-*` rather than 502ing at call time.

### Why it's fetched, not bundled

The SPA used to import the markdown with Vite's `?raw` and render it client-side from
`GET /api/v1/config` plus `MODEL_PRICING`. That listed models the edge could not serve, so an agent
built against it 502'd. The skill is now rendered server-side by `GET /api/v1/skill` (authed, behind
the ADR-0024 bearer chain) from the catalogue, and the SPA fetches the result — closing the
curated-vs-servable gap at its source. The catalogue itself is `GET /api/v1/capabilities` (also
authed): a single instance-wide JSON document answering, manifest key by key, what this deployment
can do and which requests auto-approve. An agent or the `helix skill` CLI command reads either; the
public docs site (deferred) will consume `renderSkillGeneric()` — the same template with descriptive
prose in place of every placeholder, pointing readers at their own `/api/v1/capabilities`.

## Design notes (why)

- **The modal is the summary; the skill is the reference.** Two copies of the developer story
  would drift. Anything longer than a couple of lines belongs in `SKILL.md`, and the modal's job
  is to be short enough that someone reads it.
- **A placeholder that reaches an agent is a bug, not a typo.** An agent acts on the file
  literally. `packages/deploy-skill/src/index.test.ts` asserts the rendered output contains no
  leftover `{{` in **both** render modes (the instance `renderSkill()` and the generic
  `renderSkillGeneric()`), so adding a token without wiring both maps fails the suite.
- **No external links.** Every reference is in-app (the Capabilities tab, the Dev mode tab) or a
  plain-text repo path. A customer deployment shouldn't render dead links to somewhere else.
- **The CLI instructions carry this deployment's `portalUrl`.** The CLI cannot discover its
  portal — it falls back to `http://localhost:3001` (`packages/cli/src/config.ts`) — so a
  `helix.json` copied from here without it makes `helix login` dial a portal that was never
  there, with nothing in the error naming the cause. Both the modal's CLI tab and `SKILL.md`
  print it, in the file rather than as a `--portal-url` flag because the file persists across
  `create`/`deploy`/`promote`. It is printed **before** the command block for the same reason:
  `helix create` reads the slug out of that file. The Deploy modal's one-off reminder command
  uses the flag instead, since there may be no file there yet.
- **The install instructions are honest.** They are now the real one-liner —
  `npm i -g @azx-pbc/helix-cli`, published from CI with provenance (ADR-0032). Before that landed
  the modal showed a clone/build/`npm link` sequence rather than a one-liner that fails on first
  contact; note that `npm i -g git+…` still cannot resolve this package (workspace `catalog:`
  specifiers, no prepack step), so it is not a fallback to reintroduce.
- **The skill promises nothing unbuilt.** No `@azx-pbc/app-sdk`, no `helix dev`, no MCP transport
  — an agent told those exist will write code against them.

## Planned / not yet built

- **A codemod in the skill** — "rewrite my third-party `fetch` calls to `/_api/fetch/<url>`" is a
  find-and-replace the skill could carry, per [fetch-proxy design §3.1](../design/fetch-proxy.md).
- **The public docs site** — deployment-agnostic, includes regions of `SKILL.md` via
  `renderSkillGeneric()`, and points readers at their own `/api/v1/capabilities` for values
  (ADR-0036 §7). The generic renderer and the "no leftover `{{`" guard for it are already in place;
  the site build itself is the remaining work.
- **Branching the handoff on browser-vs-agent** — the band pitches the skill to everyone. Someone
  who has said they build in a browser IDE would be better served leading with the dev gateway.
- **Deploying an example in one click** — `examples/` is the obvious "start from something that
  works", but nothing serves those bundles to the SPA today, so the guide can only name them.
