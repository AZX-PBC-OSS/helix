# @azx-pbc/docs-site

The public docs site — [azx-pbc-oss.github.io/helix](https://azx-pbc-oss.github.io/helix/),
a VitePress build published to GitHub Pages by `.github/workflows/docs.yml`.

Edit source pages under `src/`. The exception is `src/apps/quickstart.md`, which
is generated before each build or dev start. Its source is
`packages/deploy-skill/SKILL.md`, rendered by `scripts/render-skill.ts` using
`renderSkillGeneric()` (ADR-0036 decision 7). Edit the template, not the generated
page.

Contributor documentation is **not** here — it stays in `docs/` and is read on
GitHub. The site's `src/contributing.md` links to it instead of copying, so no
document exists in two places.

## Commands

```bash
pnpm dev:docs                    # dev server (also generates the quickstart page)
pnpm --filter @azx-pbc/docs-site build   # static build → .vitepress/dist
```

`base` is `/helix/` (project page). VitePress fails the build on dead internal
links, so the build is the link checker.

## AI-consumable output (llms.txt)

Every build generates the [llmstxt.org](https://llmstxt.org) v2 artifacts into
`dist/` via `vitepress-plugin-llms`, plus a `sitemap.xml`:

- `llms.txt` — a markdown index of the site, structured from the sidebar
  config, with each page's frontmatter `description` as its summary
- `llms-full.txt` — the whole site concatenated into one file
- a `.md` twin of every page (e.g. `/helix/apps/manifest.md`), and a
  `<link rel="describedby">` in each page's head pointing at `llms.txt`

These are **build output only** — never hand-create or commit them. Pages
gain their llms.txt summaries by carrying a `description:` in their frontmatter
(the quickstart's is scaffolded in `scripts/render-skill.ts`).

There is deliberately no `robots.txt`: it is only honored at the origin root
(`azx-pbc-oss.github.io/`), which a project page cannot serve, and with no
robots file AI crawlers are unrestricted by default — nothing to allow. The
sitemap is still shipped, since it is valid at any path.
