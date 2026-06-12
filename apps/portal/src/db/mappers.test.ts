import { describe, expect, it } from "vitest";
import { VERSION_STATUSES, VISIBILITY_MODES } from "@helix/shared";
import { VersionStatus, VisibilityMode } from "./generated/enums.js";
import {
  blobPrefixFor,
  toApp,
  toVersion,
  visibilityFromColumns,
  visibilityToColumns,
} from "./mappers.js";
import type { App as AppRow, Version as VersionRow } from "./client.js";

// Guard against the DB enums drifting from the shared contract enums. If
// schema.prisma and @helix/shared disagree, this fails before any route does.
describe("enum drift guards", () => {
  it("VersionStatus matches VERSION_STATUSES", () => {
    expect(Object.values(VersionStatus).sort()).toEqual([...VERSION_STATUSES].sort());
  });

  it("VisibilityMode matches VISIBILITY_MODES", () => {
    expect(Object.values(VisibilityMode).sort()).toEqual([...VISIBILITY_MODES].sort());
  });
});

describe("visibility column mapping", () => {
  it("round-trips a group visibility through columns", () => {
    const columns = visibilityToColumns({ mode: "group", groupId: "abc" });
    expect(columns).toEqual({ visibilityMode: "group", visibilityGroupId: "abc" });
    expect(visibilityFromColumns(columns.visibilityMode, columns.visibilityGroupId)).toEqual({
      mode: "group",
      groupId: "abc",
    });
  });

  it("nulls the group id for payload-less modes", () => {
    expect(visibilityToColumns({ mode: "private" })).toEqual({
      visibilityMode: "private",
      visibilityGroupId: null,
    });
  });
});

const NOW = new Date("2026-06-11T00:00:00.000Z");

describe("row mappers validate against the shared schema", () => {
  const APP_ID = "11111111-1111-4111-8111-111111111111";
  const VERSION_ID = "22222222-2222-4222-8222-222222222222";

  it("maps an apps row to a wire App", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibilityMode: "private",
      visibilityGroupId: null,
      currentVersionId: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(toApp(row)).toEqual({
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibility: { mode: "private" },
      currentVersionId: null,
      archivedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it("maps an archived apps row with an ISO archivedAt", () => {
    const row: AppRow = {
      id: APP_ID,
      slug: "cost-explorer",
      displayName: "Cost Explorer",
      visibilityMode: "private",
      visibilityGroupId: null,
      currentVersionId: null,
      archivedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(toApp(row).archivedAt).toBe(NOW.toISOString());
  });

  it("maps a versions row to a wire Version", () => {
    const row: VersionRow = {
      id: VERSION_ID,
      appId: APP_ID,
      number: 1,
      blobPrefix: blobPrefixFor(APP_ID, 1),
      status: "preview",
      createdAt: NOW,
    };
    expect(toVersion(row)).toEqual({
      id: VERSION_ID,
      appId: APP_ID,
      number: 1,
      blobPrefix: `apps/${APP_ID}/1/`,
      status: "preview",
      createdAt: NOW.toISOString(),
    });
  });
});
