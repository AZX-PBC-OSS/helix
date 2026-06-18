import { describe, expect, it } from "vitest";
import type { Capabilities } from "./manifest.js";
import {
  BASELINE_TOKENS,
  BASELINE_WRITES_PER_DAY,
  applyDeltas,
  captureSnapshot,
  classifyChange,
  classifyVisibilityChange,
  maxRisk,
  snapshotConflicts,
  touchedAreas,
} from "./approval.js";

const EMPTY: Capabilities = { mcp: [], externalOrigins: [] };

function paths(deltas: { path: string }[]): string[] {
  return deltas.map((d) => d.path);
}

describe("classifyChange — LLM", () => {
  it("baselines a curated model and gates a non-curated one", () => {
    const r = classifyChange(EMPTY, {
      mcp: [],
      externalOrigins: [],
      llm: { models: ["claude-fable-5", "gpt-5"] },
    });
    expect(paths(r.baselineDeltas)).toContain("llm.models[+claude-fable-5]");
    expect(paths(r.elevatedDeltas)).toEqual(["llm.models[+gpt-5]"]);
    expect(r.risk).toBe("med");
  });

  it("gates a token budget above baseline but not at/under it", () => {
    const under = classifyChange(EMPTY, {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: BASELINE_TOKENS },
    });
    expect(under.elevatedDeltas).toHaveLength(0);

    const over = classifyChange(EMPTY, {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: BASELINE_TOKENS + 1 },
    });
    expect(paths(over.elevatedDeltas)).toEqual(["llm.tokensPerDay"]);
  });

  it("treats removing a token cap (→ unlimited) as elevated", () => {
    const eff: Capabilities = {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: 500 },
    };
    const r = classifyChange(eff, { mcp: [], externalOrigins: [], llm: { models: [] } });
    expect(paths(r.elevatedDeltas)).toEqual(["llm.tokensPerDay"]);
  });

  it("treats adding a cap (unlimited → capped) as baseline privilege reduction", () => {
    const eff: Capabilities = { mcp: [], externalOrigins: [], llm: { models: [] } };
    const r = classifyChange(eff, {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: 10 },
    });
    expect(r.elevatedDeltas).toHaveLength(0);
    expect(paths(r.baselineDeltas)).toContain("llm.tokensPerDay");
  });

  it("lowering a budget that stays above baseline is still baseline (reduction)", () => {
    const eff: Capabilities = {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: BASELINE_TOKENS * 5 },
    };
    const r = classifyChange(eff, {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: BASELINE_TOKENS * 2 },
    });
    expect(r.elevatedDeltas).toHaveLength(0);
  });
});

describe("classifyChange — mcp / origins / data", () => {
  it("gates any MCP server as high risk", () => {
    const r = classifyChange(EMPTY, { mcp: ["pagerduty"], externalOrigins: [] });
    expect(paths(r.elevatedDeltas)).toEqual(["mcp[+pagerduty]"]);
    expect(r.risk).toBe("high");
  });

  it("gates any external origin added", () => {
    const r = classifyChange(EMPTY, { mcp: [], externalOrigins: ["https://api.foo.com"] });
    expect(paths(r.elevatedDeltas)).toEqual(["externalOrigins[+https://api.foo.com]"]);
    expect(r.risk).toBe("med");
  });

  it("treats data scopes (user/collections/shared) as baseline", () => {
    const r = classifyChange(EMPTY, {
      mcp: [],
      externalOrigins: [],
      data: { user: true, collections: ["contacts"], sharedRead: ["cfg"], sharedWrite: [] },
    });
    expect(r.elevatedDeltas).toHaveLength(0);
    expect(paths(r.baselineDeltas)).toEqual(
      expect.arrayContaining(["data.user", "data.collections[+contacts]", "data.sharedRead[+cfg]"]),
    );
  });

  it("gates a data write budget above baseline", () => {
    const r = classifyChange(EMPTY, {
      mcp: [],
      externalOrigins: [],
      data: {
        user: false,
        collections: [],
        sharedRead: [],
        sharedWrite: [],
        writesPerDay: BASELINE_WRITES_PER_DAY + 1,
      },
    });
    expect(paths(r.elevatedDeltas)).toEqual(["data.writesPerDay"]);
  });
});

describe("classifyChange — reductions are always baseline", () => {
  it("removing grants never elevates", () => {
    const eff: Capabilities = {
      mcp: ["pagerduty"],
      externalOrigins: ["https://api.foo.com"],
      llm: { models: ["gpt-5"] },
    };
    const r = classifyChange(eff, EMPTY);
    expect(r.elevatedDeltas).toHaveLength(0);
    expect(paths(r.baselineDeltas)).toEqual(
      expect.arrayContaining([
        "mcp[-pagerduty]",
        "externalOrigins[-https://api.foo.com]",
        "llm.models[-gpt-5]",
      ]),
    );
  });
});

describe("classifyChange — mixed submission splits and risk = max", () => {
  it("commits baseline, bundles elevated, reports max risk", () => {
    const r = classifyChange(EMPTY, {
      mcp: ["pagerduty"], // high, elevated
      externalOrigins: ["https://api.foo.com"], // med, elevated
      llm: { models: ["claude-fable-5"] }, // baseline
      data: { user: true, collections: [], sharedRead: [], sharedWrite: [] }, // baseline
    });
    expect(r.baselineDeltas.length).toBeGreaterThan(0);
    expect(r.elevatedDeltas.length).toBe(2);
    expect(r.risk).toBe("high");
  });
});

describe("classifyVisibilityChange", () => {
  it("gates → public as high, everything else baseline", () => {
    expect(classifyVisibilityChange("group", "public")).toMatchObject({
      elevated: true,
      risk: "high",
    });
    expect(classifyVisibilityChange("public", "private")).toMatchObject({ elevated: false });
    expect(classifyVisibilityChange("private", "private")).toBeNull();
  });
});

describe("applyDeltas", () => {
  it("round-trips elevated deltas onto effective state", () => {
    const r = classifyChange(EMPTY, {
      mcp: ["pagerduty"],
      externalOrigins: ["https://api.foo.com"],
      llm: { models: ["gpt-5"] },
    });
    const applied = applyDeltas(EMPTY, r.elevatedDeltas);
    expect(applied.mcp).toEqual(["pagerduty"]);
    expect(applied.externalOrigins).toEqual(["https://api.foo.com"]);
    expect(applied.llm?.models).toEqual(["gpt-5"]);
  });

  it("applying only baseline deltas excludes the elevated bundle", () => {
    const requested = {
      mcp: ["pagerduty"],
      externalOrigins: [],
      llm: { models: ["claude-fable-5"] },
    };
    const r = classifyChange(EMPTY, requested);
    const applied = applyDeltas(EMPTY, r.baselineDeltas);
    expect(applied.llm?.models).toEqual(["claude-fable-5"]);
    expect(applied.mcp).toEqual([]); // pagerduty stays out until approved
  });

  it("applies scalar removal (cap removed)", () => {
    const eff: Capabilities = {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: 500 },
    };
    const r = classifyChange(eff, { mcp: [], externalOrigins: [], llm: { models: [] } });
    const applied = applyDeltas(eff, r.elevatedDeltas);
    expect(applied.llm?.tokensPerDay).toBeUndefined();
  });
});

describe("snapshot + conflict (optimistic concurrency)", () => {
  it("captures touched areas and detects a moved value", () => {
    const eff: Capabilities = {
      mcp: [],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: 500 },
    };
    const r = classifyChange(eff, {
      mcp: ["pagerduty"],
      externalOrigins: [],
      llm: { models: [], tokensPerDay: 500 },
    });
    const areas = touchedAreas(r.elevatedDeltas);
    expect(areas).toEqual(["mcp"]);
    const snap = captureSnapshot(eff, "private", areas);

    // unchanged → no conflict
    expect(snapshotConflicts(snap, eff, "private")).toBe(false);

    // someone else added an mcp server → conflict
    const moved: Capabilities = { ...eff, mcp: ["other"] };
    expect(snapshotConflicts(snap, moved, "private")).toBe(true);
  });

  it("detects a visibility move", () => {
    const snap = captureSnapshot(EMPTY, "group", ["visibility"]);
    expect(snapshotConflicts(snap, EMPTY, "group")).toBe(false);
    expect(snapshotConflicts(snap, EMPTY, "private")).toBe(true);
  });
});

describe("maxRisk", () => {
  it("orders low < med < high", () => {
    expect(maxRisk([])).toBe("low");
    expect(maxRisk(["low", "med"])).toBe("med");
    expect(maxRisk(["med", "high", "low"])).toBe("high");
  });
});
