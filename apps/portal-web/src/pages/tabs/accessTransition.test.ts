import { describe, expect, it } from "vitest";
import type { App, Visibility } from "@azx-pbc/shared";
import { accessStateOf, planTransition } from "./accessTransition";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(visibility: Visibility, archived = false): App {
  return {
    id: APP_ID,
    slug: "demo",
    displayName: "Demo",
    visibility,
    currentVersionId: null,
    archivedAt: archived ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const vis = (mode: Visibility["mode"], ...groupIds: string[]) => ({ mode, groupIds }) as Visibility;

/** The kinds of the planned steps, as a compact string for matrix assertions. */
const shape = (app: App, target: Parameters<typeof planTransition>[1], groupIds: string[] = []) =>
  planTransition(app, target, groupIds)?.steps.map((s) =>
    s.kind === "setVisibility"
      ? `visibility:${s.visibility.mode === "group" ? `group:${s.visibility.groupIds.join(",")}` : s.visibility.mode}`
      : s.kind === "setArchived"
        ? `setArchived:${s.archived}`
        : s.kind,
  ) ?? null;

describe("accessStateOf", () => {
  it("reports the visibility mode for a live app", () => {
    expect(accessStateOf(makeApp(vis("group", "g1")))).toBe("group");
  });

  it("reports archived over whatever visibility is preserved underneath", () => {
    expect(accessStateOf(makeApp(vis("public"), true))).toBe("archived");
  });
});

describe("planTransition — no-ops", () => {
  it("plans nothing for the current state", () => {
    expect(planTransition(makeApp(vis("internal")), "internal", [])).toBeNull();
    expect(planTransition(makeApp(vis("public")), "public", [])).toBeNull();
    expect(planTransition(makeApp(vis("internal"), true), "archived", [])).toBeNull();
  });

  it("plans nothing for a group app whose set is unchanged — order is meaningless", () => {
    const app = makeApp(vis("group", "eng", "product"));
    expect(planTransition(app, "group", ["eng", "product"])).toBeNull();
    expect(planTransition(app, "group", ["product", "eng"])).toBeNull();
  });
});

describe("planTransition — live mode switches", () => {
  it("restricts an internal app to groups in one call", () => {
    const plan = planTransition(makeApp(vis("internal")), "group", ["eng"]);
    expect(shape(makeApp(vis("internal")), "group", ["eng"])).toEqual(["visibility:group:eng"]);
    expect(plan).toMatchObject({
      elevated: false,
      title: "Restrict Demo to groups?",
      confirmLabel: "Restrict to groups",
    });
  });

  it("requests approval to go public, from any live mode", () => {
    for (const from of [vis("internal"), vis("group", "eng")]) {
      const plan = planTransition(makeApp(from), "public", []);
      expect(shape(makeApp(from), "public")).toEqual(["visibility:public"]);
      expect(plan).toMatchObject({
        elevated: true,
        title: "Request public access for Demo?",
        confirmLabel: "Request approval",
      });
    }
  });

  it("makes an app internal in one call, whether narrowing or widening", () => {
    for (const from of [vis("group", "eng"), vis("public")]) {
      const plan = planTransition(makeApp(from), "internal", []);
      expect(shape(makeApp(from), "internal")).toEqual(["visibility:internal"]);
      expect(plan).toMatchObject({
        elevated: false,
        title: "Make Demo internal?",
        confirmLabel: "Make internal",
      });
    }
  });

  it("enables password access in one call", () => {
    const plan = planTransition(makeApp(vis("internal")), "password", []);
    expect(shape(makeApp(vis("internal")), "password")).toEqual(["enablePassword"]);
    expect(plan).toMatchObject({
      elevated: false,
      title: "Enable password access for Demo?",
      confirmLabel: "Enable password access",
    });
  });
});

describe("planTransition — out of password mode", () => {
  it("disables straight to internal — the endpoint's landing state", () => {
    const plan = planTransition(makeApp(vis("password")), "internal", []);
    expect(shape(makeApp(vis("password")), "internal")).toEqual(["disablePassword"]);
    expect(plan).toMatchObject({
      elevated: false,
      title: "Disable password access for Demo?",
      confirmLabel: "Disable",
    });
  });

  it("migrates to group through internal — disable, then apply", () => {
    const plan = planTransition(makeApp(vis("password")), "group", ["eng"]);
    expect(shape(makeApp(vis("password")), "group", ["eng"])).toEqual([
      "disablePassword",
      "visibility:group:eng",
    ]);
    expect(plan).toMatchObject({ elevated: false, title: "Restrict Demo to groups?" });
  });

  it("migrates to public through internal, and the request elevates", () => {
    const plan = planTransition(makeApp(vis("password")), "public", []);
    expect(shape(makeApp(vis("password")), "public")).toEqual([
      "disablePassword",
      "visibility:public",
    ]);
    expect(plan).toMatchObject({ elevated: true, confirmLabel: "Request approval" });
  });
});

describe("planTransition — group edits in place", () => {
  it("saves an edited set on an already-group app", () => {
    const plan = planTransition(makeApp(vis("group", "eng")), "group", ["eng", "product"]);
    expect(shape(makeApp(vis("group", "eng")), "group", ["eng", "product"])).toEqual([
      "visibility:group:eng,product",
    ]);
    expect(plan).toMatchObject({
      elevated: false,
      title: "Change the groups for Demo?",
      confirmLabel: "Save groups",
    });
  });

  it("compares as a set, so a reorder is not an edit", () => {
    expect(
      planTransition(makeApp(vis("group", "eng", "product")), "group", ["product", "eng"]),
    ).toBeNull();
  });
});

describe("planTransition — archiving", () => {
  it("archives any live state in one call", () => {
    for (const from of [vis("internal"), vis("group", "eng"), vis("public"), vis("password")]) {
      const plan = planTransition(makeApp(from), "archived", []);
      expect(shape(makeApp(from), "archived")).toEqual(["setArchived:true"]);
      expect(plan).toMatchObject({
        elevated: false,
        title: "Archive Demo?",
        confirmLabel: "Archive",
      });
    }
  });

  it("unarchives alone when the target restores the preserved visibility", () => {
    const plan = planTransition(makeApp(vis("internal"), true), "internal", []);
    expect(shape(makeApp(vis("internal"), true), "internal")).toEqual(["setArchived:false"]);
    expect(plan).toMatchObject({
      elevated: false,
      title: "Unarchive Demo?",
      confirmLabel: "Unarchive",
    });
  });

  it("unarchives alone for a preserved group set, compared as a set", () => {
    const plan = planTransition(makeApp(vis("group", "eng"), true), "group", ["eng"]);
    expect(plan?.steps).toEqual([{ kind: "setArchived", archived: false }]);
    // And a reordered draft of the same set restores too — no visibility call.
    expect(planTransition(makeApp(vis("group", "eng"), true), "group", ["eng"])?.steps).toEqual([
      { kind: "setArchived", archived: false },
    ]);
  });

  it("applies the new visibility before unarchiving, so a partial failure stays archived", () => {
    const plan = planTransition(makeApp(vis("internal"), true), "group", ["eng"]);
    expect(shape(makeApp(vis("internal"), true), "group", ["eng"])).toEqual([
      "visibility:group:eng",
      "setArchived:false",
    ]);
    expect(plan).toMatchObject({ elevated: false, title: "Restrict Demo to groups?" });
  });

  it("does not unarchive a request to go public — the app stays archived until approval", () => {
    const plan = planTransition(makeApp(vis("internal"), true), "public", []);
    expect(shape(makeApp(vis("internal"), true), "public")).toEqual(["visibility:public"]);
    expect(plan).toMatchObject({ elevated: true, confirmLabel: "Request approval" });
  });

  it("unarchives without a visibility call when the preserved mode was already public", () => {
    const plan = planTransition(makeApp(vis("public"), true), "public", []);
    expect(plan?.steps).toEqual([{ kind: "setArchived", archived: false }]);
    expect(plan).toMatchObject({ elevated: false });
  });

  it("restores a preserved password app without touching the credential", () => {
    const plan = planTransition(makeApp(vis("password"), true), "password", []);
    expect(plan?.steps).toEqual([{ kind: "setArchived", archived: false }]);
  });
});
