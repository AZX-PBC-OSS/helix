import { describe, expect, it } from "vitest";
import { MODEL_PRICING, providerForModel } from "@azx-pbc/shared";
import { modelPolicy, servableLlmModels } from "./modelPolicy.js";

/**
 * The operator's servable-model policy (ADR-0047): `PORTAL_LLM_MODEL_ALLOWLIST`
 * replaces the seeded-secret heuristic outright (it exists for wiring the
 * heuristic cannot see — keyless Foundry seeds no `anthropic`/`openai` secret),
 * and `PORTAL_LLM_MODEL_BLOCKLIST` subtracts in either mode. Everything is
 * intersected with the priced catalog: there is no dynamic catalogue.
 */

const CATALOG = Object.keys(MODEL_PRICING);
const CLAUDE = CATALOG.filter((m) => providerForModel(m) === "anthropic");
const GPT = CATALOG.filter((m) => providerForModel(m) === "openai");

describe("modelPolicy", () => {
  it("is inert when neither var is set", () => {
    const p = modelPolicy({});
    expect(p.allowlist).toBeNull();
    expect(p.blocklist).toEqual([]);
    expect(p.unknown).toEqual([]);
  });

  it("treats an empty or all-separator allowlist as unset (the Bicep empty-string case)", () => {
    for (const raw of ["", "   ", ",", " , ,"]) {
      expect(
        modelPolicy({ PORTAL_LLM_MODEL_ALLOWLIST: raw }).allowlist,
        JSON.stringify(raw),
      ).toBeNull();
    }
  });

  it("parses the allowlist in catalog order, tolerating whitespace and duplicates", () => {
    const p = modelPolicy({
      PORTAL_LLM_MODEL_ALLOWLIST: " gpt-5-mini , claude-opus-4-8,,gpt-5-mini ",
    });
    expect(p.allowlist).toEqual(["claude-opus-4-8", "gpt-5-mini"]);
    expect(p.unknown).toEqual([]);
  });

  it("drops allowlist entries that name no catalog model and reports them", () => {
    const p = modelPolicy({
      PORTAL_LLM_MODEL_ALLOWLIST: "claude-opus-4-8,claude-typo-9",
    });
    // Unknown ids never advertise: the edge could not price or route them.
    expect(p.allowlist).toEqual(["claude-opus-4-8"]);
    expect(p.unknown).toEqual(["claude-typo-9"]);
  });

  it("reports unknown blocklist entries too (a typo'd block silently does nothing)", () => {
    const p = modelPolicy({ PORTAL_LLM_MODEL_BLOCKLIST: "claude-fable-5,claude-fable-6" });
    expect(p.blocklist).toEqual(["claude-fable-5"]);
    expect(p.unknown).toEqual(["claude-fable-6"]);
  });
});

describe("servableLlmModels", () => {
  it("without an allowlist, keeps the seeded-secret heuristic", () => {
    const p = modelPolicy({});
    expect(servableLlmModels(p, new Set(["anthropic"]))).toEqual(CLAUDE);
    expect(servableLlmModels(p, new Set(["anthropic", "openai"]))).toEqual(CATALOG);
    expect(servableLlmModels(p, new Set())).toEqual([]);
  });

  it("with an allowlist, IS the servable set — seeded secrets are not consulted", () => {
    // The keyless-Foundry shape: no platform secret exists for either family,
    // yet the deployed models must advertise.
    const p = modelPolicy({ PORTAL_LLM_MODEL_ALLOWLIST: "claude-opus-4-8,gpt-5-mini" });
    expect(servableLlmModels(p, new Set())).toEqual(["claude-opus-4-8", "gpt-5-mini"]);
  });

  it("subtracts the blocklist from the heuristic result", () => {
    const p = modelPolicy({ PORTAL_LLM_MODEL_BLOCKLIST: "claude-fable-5, claude-fable-5-1" });
    const out = servableLlmModels(p, new Set(["anthropic", "openai"]));
    expect(out).toEqual(CATALOG.filter((m) => !m.startsWith("claude-fable-5")));
  });

  it("subtracts the blocklist from an explicit allowlist", () => {
    const p = modelPolicy({
      PORTAL_LLM_MODEL_ALLOWLIST: "claude-opus-4-8,claude-fable-5",
      PORTAL_LLM_MODEL_BLOCKLIST: "claude-fable-5",
    });
    expect(servableLlmModels(p, new Set())).toEqual(["claude-opus-4-8"]);
  });

  it("never advertises an uncatalogued id even when the allowlist names one", () => {
    const p = modelPolicy({ PORTAL_LLM_MODEL_ALLOWLIST: GPT.join(",") + ",gpt-99-ultra" });
    expect(servableLlmModels(p, new Set())).toEqual(GPT);
    expect(p.unknown).toEqual(["gpt-99-ultra"]);
  });
});
