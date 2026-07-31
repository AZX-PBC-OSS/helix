# Onboarding — the in-app guide and the agent skill

> **Related ADRs:** [ADR-0028](../adr/0028-deployment-model-customer-deployed.md) (single-tenant, customer-deployed — why hostnames can't be baked in) · [ADR-0020](../adr/0020-static-only-apps-v1.md) (static-only apps — the first thing anyone must be told) · [ADR-0032](../adr/0032-cli-naming-and-distribution.md) (CLI naming + distribution — why there's no `npm i -g` line yet).

**What it is.** The path from "I have a portal account" to "I have a deployed app", surfaced
where people actually are. Two pieces:

- **The "How to develop" modal** in the portal SPA — a short, readable summary of the platform
  for a human, reachable from the sidebar on every screen.
- **`packages/deploy-skill`** — the same story in full, as a `SKILL.md` a coding agent can load,
  handed out from that modal by **Copy** or **Download** with this deployment's real hostnames
  already substituted in.

The platform's documentation is extensive and all of it lives in the repo. Someone building an
app in a browser IDE will never see it. This is the surface that closes that gap.

## How it works

### The modal

`apps/portal-web/src/modals/HelpModal.tsx`, opened from a **How to develop** button in the
sidebar footer (`components/Shell.tsx`, local `useState` — the sidebar is the only entry point
today; a second one would justify a provider like `modals/DeployContext.tsx`).

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
file carries `{{PORTAL_ORIGIN}}`, `{{APPS_HOST}}`, `{{DEV_API_BASE}}`, and `{{LLM_MODELS}}` tokens
plus a `<!-- IF:DEV_API -->` block, and `renderSkill()` (`packages/deploy-skill/src/index.ts`)
fills them from `GET /api/v1/config` at copy/download time. A deployment with no dev gateway loses
that section entirely rather than being handed a base URL that will never answer — the same
degradation the **Dev mode** tab does.

The models offered come from `MODEL_PRICING` in `@azx-pbc/shared`, so "what this platform will
serve" cannot drift from what it prices.

### Why it's bundled, not fetched

The SPA imports the markdown with Vite's `?raw`, so it lands in the JS bundle and needs no portal
route. That is deliberate: the portal serves the SPA with an `index.html` fallback on a miss
(`apps/portal/src/routes/spa.ts`, `wildcard: false`), so a fetch of a mistyped static path would
succeed with a 200 and download the app shell. Nothing to get wrong if there's nothing to fetch.

## Design notes (why)

- **The modal is the summary; the skill is the reference.** Two copies of the developer story
  would drift. Anything longer than a couple of lines belongs in `SKILL.md`, and the modal's job
  is to be short enough that someone reads it.
- **A placeholder that reaches an agent is a bug, not a typo.** An agent acts on the file
  literally. `packages/deploy-skill/src/index.test.ts` asserts the rendered output contains no
  leftover `{{`, so adding a token without wiring it fails the suite.
- **No external links.** Every reference is in-app (the Capabilities tab, the Dev mode tab) or a
  plain-text repo path. A customer deployment shouldn't render dead links to somewhere else.
- **The install instructions are honest.** The CLI is a workspace package with `catalog:`
  specifiers and no prepack step, so `npm i -g git+…` cannot resolve it (ADR-0032). The modal
  shows the clone/build/`npm link` sequence that actually works and says `npm i -g` is coming,
  rather than a one-liner that fails on first contact.
- **The skill promises nothing unbuilt.** No `@azx-pbc/app-sdk`, no `helix dev`, no MCP transport
  — an agent told those exist will write code against them.

## Planned / not yet built

- **A codemod in the skill** — "rewrite my third-party `fetch` calls to `/_api/fetch/<url>`" is a
  find-and-replace the skill could carry, per [fetch-proxy design §3.1](../design/fetch-proxy.md).
- **Serving the skill over HTTP** — an agent can't `curl` it today; it comes out of the browser.
  A `GET /api/v1/skill` reusing `renderSkill()` is the obvious addition if that's wanted.
- **An `npm i -g @azx-pbc/helix-cli` line** — blocked on publishing the CLI (ADR-0032). When that
  lands, the modal's install block and `SKILL.md` §4 both change.
- **A first-run nudge** — the guide is discoverable but passive; an empty **My Apps** list is the
  natural place to point at it.
