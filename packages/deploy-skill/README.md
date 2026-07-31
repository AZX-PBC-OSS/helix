# `@azx-pbc/deploy-skill`

The **agent skill bundle** (project plan §2): what a coding agent needs to know to
write and deploy an app on Helix, in one file it can load.

- **[`SKILL.md`](./SKILL.md)** — the skill itself, in [Claude Agent Skills](https://code.claude.com/docs/en/skills)
  format (YAML frontmatter + markdown), so it drops into `.claude/skills/helix/SKILL.md`
  unmodified and reads fine pasted into any other agent.
- **[`src/index.ts`](./src/index.ts)** — `renderSkill(template, vars)`, the substitution
  that turns the on-disk template into something deployment-specific.

Zero runtime dependencies: this package is a document plus a string transform.

## Why it's a template

Hosts differ per deployment (Helix is single-tenant, customer-deployed — [ADR-0028](../../docs/adr/0028-deployment-model-customer-deployed.md)),
and the dev gateway is opt-in, so a skill checked in with real hostnames would be wrong
almost everywhere. `SKILL.md` therefore carries `{{PLACEHOLDER}}` tokens plus one
conditional block, and the consumer fills them from `GET /api/v1/config`:

| Token               | Filled with                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `{{PORTAL_ORIGIN}}` | The portal's own origin                                              |
| `{{APPS_HOST}}`     | Host apps are served under — an app lives at `https://<slug>.<that>` |
| `{{DEV_API_BASE}}`  | `devApiBase` from the deployment config                              |
| `{{LLM_MODELS}}`    | The priced/curated model ids (`MODEL_PRICING` in `@azx-pbc/shared`)  |

Everything between `<!-- IF:DEV_API -->` and `<!-- /IF:DEV_API -->` is dropped when the
deployment runs no dev gateway, rather than printing a base URL that will never answer.

## Consumers

The portal SPA's **How to develop** modal (`apps/portal-web/src/modals/HelpModal.tsx`)
imports the markdown with Vite's `?raw`, renders it, and offers it as copy-to-clipboard
or a `SKILL.md` download. Because it is bundled rather than fetched, it works from the
portal's static build with no extra route.

## Changing it

`SKILL.md` is the **reference**; the help modal is the **summary**. Anything longer than
a couple of lines belongs here, not duplicated into the modal's JSX.

Adding a placeholder means adding a field to `SkillVars` **and** filling it at every call
site. `src/index.test.ts` asserts the rendered output contains no leftover `{{`, so a
half-wired placeholder fails the suite instead of reaching an agent.

Keep it honest about what exists. The skill must not promise `@azx-pbc/app-sdk`,
`helix dev`, or MCP transport — none of those are built.
