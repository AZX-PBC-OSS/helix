# @azx-pbc/docs-site

The public docs site — [azx-pbc-oss.github.io/helix](https://azx-pbc-oss.github.io/helix/),
a VitePress build published to GitHub Pages by `.github/workflows/docs.yml`.

Content lives in `src/`, in plain markdown. The `src/apps/quickstart.md` page
is **generated**: `scripts/render-skill.ts` renders
`packages/deploy-skill/SKILL.md` through `renderSkillGeneric()` and writes it
before every build and dev start (ADR-0036 decision 7 — there is no public
skill, only public docs, and the skill template stays the single authored
source). Do not edit the generated file; edit the template or this page's
scaffolding in the script.

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
