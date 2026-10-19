import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSkill, SKILL_FILENAME, type SkillVars } from "./index.js";

/** The shipped template, so these assertions bind to the real document. */
const TEMPLATE = readFileSync(new URL(`../${SKILL_FILENAME}`, import.meta.url), "utf8");

const VARS: SkillVars = {
  portalOrigin: "https://portal.example.com",
  appsHost: "apps.example.com",
  devApiBase: "https://dev-api.example.com",
};

const NPX = "npx -y @azx-pbc/helix-cli@latest";
const DOCS = "https://azx-pbc-oss.github.io/helix/";

describe("renderSkill", () => {
  it("substitutes every placeholder in the shipped template", () => {
    const out = renderSkill(TEMPLATE, VARS);

    expect(out).toContain("https://portal.example.com");
    expect(out).toContain("https://<slug>.apps.example.com");
  });

  /**
   * The guard that matters: a `{{TOKEN}}` added to SKILL.md without a matching
   * SkillVars field would otherwise reach an agent verbatim.
   */
  it("leaves no unresolved placeholder behind", () => {
    expect(renderSkill(TEMPLATE, VARS)).not.toContain("{{");
    expect(renderSkill(TEMPLATE, { ...VARS, devApiBase: null })).not.toContain("{{");
  });

  /**
   * Every conditional marker in the shipped template has to be matched and
   * consumed. A stray `<!--` in the output means one of them was reflowed onto a
   * line with other content and the block silently half-matched.
   */
  it("consumes every conditional marker in the shipped template", () => {
    expect(renderSkill(TEMPLATE, VARS)).not.toContain("<!--");
    expect(renderSkill(TEMPLATE, { ...VARS, devApiBase: null })).not.toContain("<!--");
  });

  it("keeps the dev-gateway lines when a dev gateway is deployed", () => {
    const out = renderSkill(TEMPLATE, VARS);

    expect(out).toContain("https://dev-api.example.com/<slug>");
    expect(out).toContain(`${DOCS}apps/dev-gateway.md`);
    expect(out).not.toContain("IF:DEV_API");
  });

  it("drops the dev-gateway lines entirely when there is none", () => {
    const out = renderSkill(TEMPLATE, { ...VARS, devApiBase: null });

    expect(out).not.toContain("dev-api");
    expect(out).not.toContain("dev-gateway.md");
    expect(out).not.toContain("IF:DEV_API");
    // The rest of the document survives.
    expect(out).toContain("Rules you must not break");
    expect(out).toContain(`${NPX} deploy`);
  });

  /**
   * The CLI cannot discover its portal — it defaults to `http://localhost:3001`,
   * so a `helix.json` handed to an agent without `portalUrl` produces a login
   * that fails to connect and does not say why.
   */
  it("gives the helix.json a portalUrl, ahead of the commands that resolve it", () => {
    const out = renderSkill(TEMPLATE, VARS);

    expect(out).toContain(`"portalUrl": "https://portal.example.com"`);
    expect(out.indexOf("portalUrl")).toBeLessThan(out.indexOf(`${NPX} login`));
  });

  it("passes through an unknown token rather than blanking it", () => {
    expect(renderSkill("keep {{NOT_A_VAR}} intact", VARS)).toBe("keep {{NOT_A_VAR}} intact");
  });

  it("strips a conditional block without eating the surrounding lines", () => {
    const t = ["before", "<!-- IF:DEV_API -->", "inside", "<!-- /IF:DEV_API -->", "after"].join(
      "\n",
    );

    expect(renderSkill(t, { ...VARS, devApiBase: null })).toBe("before\nafter");
    expect(renderSkill(t, VARS)).toBe("before\ninside\nafter");
  });
});

/**
 * A downloaded skill must stay correct without being re-downloaded (ADR-0052).
 * These pin the properties that make that true: the CLI runs from npx at its
 * latest version, live values come from `capabilities`, details come from the
 * docs, and the file stays small enough that nobody turns it back into a
 * reference.
 */
describe("the skill stays evergreen", () => {
  const out = renderSkill(TEMPLATE, VARS);

  it("runs the CLI through npx at the latest version, never a global install", () => {
    expect(out).toContain(NPX);
    expect(out).not.toContain("npm i -g");
    expect(out).not.toContain("npm install -g");
    // Every CLI invocation in a code block goes through npx.
    const bare = out.split("\n").filter((line) => /^\s*helix\s/.test(line));
    expect(bare).toEqual([]);
  });

  it("sends the agent to `capabilities` for live values and to the docs for detail", () => {
    expect(out).toContain(`${NPX} capabilities`);
    expect(out).toContain(`${DOCS}apps/quickstart.md`);
    expect(out).toContain(`${DOCS}llms-full.txt`);
  });

  it("states no per-release or per-deployment values", () => {
    // Model ids, budgets, and caps belong to `capabilities`.
    expect(out).not.toMatch(/claude-[a-z]+-\d/);
    expect(out).not.toMatch(/\d+ MB per (file|bundle)/);
    expect(out).not.toMatch(/\$\d+\/day/);
  });

  /**
   * Downloaded skills link to these pages by URL and are never re-fetched, so
   * renaming or removing one breaks every copy in the field. Each link must
   * name a page the docs site builds.
   */
  it("links only to docs pages that exist", () => {
    const pages = [...out.matchAll(/azx-pbc-oss\.github\.io\/helix\/(apps\/[a-z-]+)\.md/g)].map(
      (m) => m[1]!,
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const src = new URL(`../../../apps/docs/src/${page}.md`, import.meta.url);
      expect(existsSync(src), `${page}.md is linked from SKILL.md`).toBe(true);
    }
  });

  it("stays short", () => {
    expect(TEMPLATE.split("\n").length).toBeLessThan(200);
  });
});
