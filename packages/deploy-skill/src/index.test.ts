import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSkill, renderSkillGeneric, SKILL_FILENAME, type SkillVars } from "./index.js";

/** The shipped template, so these assertions bind to the real document. */
const TEMPLATE = readFileSync(new URL(`../${SKILL_FILENAME}`, import.meta.url), "utf8");

const VARS: SkillVars = {
  portalOrigin: "https://portal.example.com",
  appsHost: "apps.example.com",
  devApiBase: "https://dev-api.example.com",
  llmModels: ["claude-haiku-4-5", "claude-sonnet-4-6"],
  maxFileMb: 50,
  maxBundleMb: 250,
  baselineDollarsPerDay: 50,
  baselineWritesPerDay: 10_000,
  baselineBytesPerDay: 50_000_000,
  baselineFetchRequestsPerDay: 10_000,
};

describe("renderSkill", () => {
  it("substitutes every placeholder in the shipped template", () => {
    const out = renderSkill(TEMPLATE, VARS);

    expect(out).toContain("https://portal.example.com");
    expect(out).toContain("https://<slug>.apps.example.com");
    expect(out).toContain("claude-haiku-4-5, claude-sonnet-4-6");
    expect(out).toContain("$50/day of LLM");
    expect(out).toContain("10000 writes/day");
    expect(out).toContain("50000000 bytes/day");
    expect(out).toContain("10000 proxied");
  });

  /**
   * The guard that matters: a `{{TOKEN}}` added to SKILL.md without a matching
   * SkillVars field would otherwise reach an agent verbatim. Covers both render
   * modes (ADR-0036 decision 1) so a new placeholder fails the suite until both
   * maps are wired.
   */
  it("leaves no unresolved placeholder behind (instance render)", () => {
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

  /**
   * The CLI cannot discover its portal — it defaults to `http://localhost:3001`,
   * so a `helix.json` handed to an agent without `portalUrl` produces a login
   * that fails to connect and does not say why. The template is the only document
   * in the repo that has always got this right; this is what keeps it that way.
   */
  it("gives the helix.json a portalUrl, ahead of the commands that resolve it", () => {
    const out = renderSkill(TEMPLATE, VARS);

    expect(out).toContain(`"portalUrl": "https://portal.example.com"`);
    expect(out.indexOf("portalUrl")).toBeLessThan(out.indexOf("helix login"));
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

describe("renderSkillGeneric", () => {
  /**
   * The generic rendering is what the public docs site consumes. It must resolve
   * every placeholder too — a `{{TOKEN}}` left in the published docs is a broken
   * reference, and the "both maps wired" rule is what keeps the two renderers in
   * lockstep (ADR-0036 decision 1).
   */
  it("leaves no unresolved placeholder in the shipped template", () => {
    expect(renderSkillGeneric(TEMPLATE)).not.toContain("{{");
  });

  it("consumes every conditional marker in the shipped template", () => {
    expect(renderSkillGeneric(TEMPLATE)).not.toContain("<!--");
  });

  it("points every placeholder at the catalogue rather than stating a value", () => {
    const out = renderSkillGeneric(TEMPLATE);

    expect(out).toContain("GET /api/v1/capabilities");
    // No instance value leaks into the generic rendering.
    expect(out).not.toContain("portal.example.com");
    expect(out).not.toContain("apps.example.com");
    expect(out).not.toContain("dev-api.example.com");
  });

  /**
   * The dev-gateway section is kept (not stripped) in the generic rendering, so
   * a reader of the public docs sees that the capability exists and how it works,
   * with the prose substitution carrying the "if deployed here" note.
   */
  it("keeps the dev-gateway section with a deployment-dependent note", () => {
    const out = renderSkillGeneric(TEMPLATE);

    expect(out).toContain("Developing before you deploy");
    expect(out).toContain("dev gateway is deployed here");
    expect(out).not.toContain("IF:DEV_API");
  });

  it("passes through an unknown token rather than blanking it", () => {
    expect(renderSkillGeneric("keep {{NOT_A_VAR}} intact")).toBe("keep {{NOT_A_VAR}} intact");
  });
});
