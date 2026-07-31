import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSkill, SKILL_FILENAME, type SkillVars } from "./index.js";

/** The shipped template, so these assertions bind to the real document. */
const TEMPLATE = readFileSync(new URL(`../${SKILL_FILENAME}`, import.meta.url), "utf8");

const VARS: SkillVars = {
  portalOrigin: "https://portal.example.com",
  appsHost: "apps.example.com",
  devApiBase: "https://dev-api.example.com",
  llmModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
};

describe("renderSkill", () => {
  it("substitutes every placeholder in the shipped template", () => {
    const out = renderSkill(TEMPLATE, VARS);

    expect(out).toContain("https://portal.example.com");
    expect(out).toContain("https://<slug>.apps.example.com");
    expect(out).toContain("claude-haiku-4-5, claude-sonnet-4-6");
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

  it("keeps the dev-gateway section when a dev gateway is deployed", () => {
    const out = renderSkill(TEMPLATE, VARS);

    expect(out).toContain("https://dev-api.example.com/<slug>");
    expect(out).toContain("Developing before you deploy");
    expect(out).not.toContain("IF:DEV_API");
  });

  it("drops the dev-gateway section entirely when there is none", () => {
    const out = renderSkill(TEMPLATE, { ...VARS, devApiBase: null });

    expect(out).not.toContain("Developing before you deploy");
    expect(out).not.toContain("dev-api");
    expect(out).not.toContain("IF:DEV_API");
    // The rest of the document survives.
    expect(out).toContain("The capability manifest");
    expect(out).toContain("helix deploy");
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
