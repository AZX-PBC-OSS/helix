import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkillGeneric } from "@azx-pbc/deploy-skill";

// Generates src/apps/quickstart.md from packages/deploy-skill/SKILL.md —
// the ADR-0036 decision that the public docs site consumes the generic
// render ("no public skill, only public docs"). Runs before every build
// and dev start, so the page can never drift from the template: there is
// exactly one authored source and this is not a second one.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const template = readFileSync(resolve(repoRoot, "packages/deploy-skill/SKILL.md"), "utf8");

// Drop the skill-discovery frontmatter (name/description) — the page carries
// its own VitePress frontmatter.
const body = template.replace(/^---\n[\s\S]*?\n---\n/, "");

const rendered = renderSkillGeneric(body);

const page = `---
title: Quickstart — build and deploy an app
---

This is the end-to-end guide to building a Helix app: the constraints you build
within, the capability manifest, the \`/_api/*\` gateway, and the deploy flow.

It is written as instructions for an AI coding agent, because that is how most
Helix apps get written. Point your agent at this page, or paste it into the
conversation, and it covers everything from the first file to a live URL. You
can read it yourself too — it is plain markdown.

${rendered}
`;

const outPath = resolve(here, "../src/apps/quickstart.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, page);

console.log(`render-skill: wrote ${outPath} (${page.length} bytes)`);
