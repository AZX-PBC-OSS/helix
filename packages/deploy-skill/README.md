# `@azx-pbc/deploy-skill`

The **agent skill bundle** (project plan §2). It gives a coding agent what it
needs to write and deploy an app on Helix, in one short file it can load.

- **[`SKILL.md`](./SKILL.md)**: the skill itself, in [Claude Agent Skills](https://code.claude.com/docs/en/skills)
  format (YAML frontmatter plus markdown). It works unmodified at
  `.claude/skills/helix/SKILL.md` and reads fine pasted into any other agent.
- **[`src/index.ts`](./src/index.ts)**: `renderSkill(template, vars)`, which fills
  in one deployment's values.

It has no runtime dependencies: this package is a document plus a string transform.

## What goes in the skill

People download the skill once and rarely fetch it again, so it must stay correct
without being updated (ADR-0052). It holds only:

- **rules that don't change between releases**: the static-frontend model, the
  CSP's `connect-src 'self'`, compare-and-swap shared writes, and similar
  mistakes an agent makes before it would think to look anything up;
- **this deployment's addresses**, which are fixed once it is deployed;
- **pointers** to things that stay current by themselves:
  - `npx -y @azx-pbc/helix-cli@latest`, the newest CLI;
  - `helix capabilities`, this deployment's live values;
  - the public docs, which are published from `main`.

**The public docs (`apps/docs/src/apps/`) are the reference.** Never put a value
that changes per release or per deployment in the skill: no model ids, budgets,
size caps, or API details. Document it in the docs and link to it. The tests
enforce the main cases: no model ids or dollar or MB figures, no global install,
every docs link resolves to a real page, and the file stays under 200 lines.

## Why it's a template

Each deployment has its own hosts (Helix is single-tenant and customer-deployed,
[ADR-0028](../../docs/adr/0028-deployment-model-customer-deployed.md)), and the
dev gateway is optional. `SKILL.md` therefore carries `{{PLACEHOLDER}}` tokens
plus one conditional block, and the portal fills them in at `GET /api/v1/skill`:

| Token               | Filled with                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `{{PORTAL_ORIGIN}}` | The portal's origin, as the request reached it                       |
| `{{APPS_HOST}}`     | Host apps are served under — an app lives at `https://<slug>.<that>` |
| `{{DEV_API_BASE}}`  | The dev-gateway base, when one is deployed                           |

Everything between `<!-- IF:DEV_API -->` and `<!-- /IF:DEV_API -->` is removed when
the deployment has no dev gateway, rather than printing a base URL that will
never answer.

## Consumers

- `GET /api/v1/skill` on the portal renders it (`apps/portal/src/routes/catalogue.ts`).
- The portal SPA's **How to develop** modal and the My Apps panel fetch that
  route and offer it to copy or download.
- `helix skill` writes it to disk.

## Changing it

Add a placeholder only for a value that is fixed per deployment. It needs a field
in `SkillVars` and a value at the portal call site. `src/index.test.ts` asserts that
the rendered output has no leftover `{{`, so a half-wired placeholder fails the
tests instead of reaching an agent.

Keep it honest about what exists. The skill must not promise `@azx-pbc/app-sdk`,
`helix dev`, or an MCP transport, because none of those are built.
