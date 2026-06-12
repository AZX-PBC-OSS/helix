import {
  AppSchema,
  VersionSchema,
  type App,
  type Version,
  type Visibility,
  type VisibilityMode,
} from "@helix/shared";
import type { App as AppRow, Version as VersionRow } from "./client.js";

/** Flattened visibility columns as stored on the `apps` row. */
export interface VisibilityColumns {
  visibilityMode: VisibilityMode;
  visibilityGroupId: string | null;
}

/** Reassemble the discriminated-union Visibility from its flattened columns. */
export function visibilityFromColumns(mode: VisibilityMode, groupId: string | null): Visibility {
  if (mode === "group") {
    // groupId is non-null whenever mode is `group` (enforced on write below).
    return { mode, groupId: groupId ?? "" };
  }
  return { mode };
}

/** Flatten a Visibility union into columns for an `apps` insert/update. */
export function visibilityToColumns(visibility: Visibility): VisibilityColumns {
  return visibility.mode === "group"
    ? { visibilityMode: "group", visibilityGroupId: visibility.groupId }
    : { visibilityMode: visibility.mode, visibilityGroupId: null };
}

/**
 * Map an `apps` row to the wire `App`, validating through the shared schema so
 * any drift between the DB shape and the contract fails loudly at the boundary.
 */
export function toApp(row: AppRow): App {
  return AppSchema.parse({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    visibility: visibilityFromColumns(row.visibilityMode, row.visibilityGroupId),
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Map a `versions` row to the wire `Version`, validated through the schema. */
export function toVersion(row: VersionRow): Version {
  return VersionSchema.parse({
    id: row.id,
    appId: row.appId,
    number: row.number,
    blobPrefix: row.blobPrefix,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Blob key prefix for a version's assets: `apps/<appId>/<number>/`. */
export function blobPrefixFor(appId: string, number: number): string {
  return `apps/${appId}/${number}/`;
}
