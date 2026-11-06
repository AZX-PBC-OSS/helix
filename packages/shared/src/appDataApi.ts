import { z } from "zod";

/**
 * Response bodies of the app-data gateway (`/_api/data/*`, app-data design §5,
 * ADR-0041, ADR-0042). The edge builds these by hand and types them with the
 * inferred types below; it never parses them at runtime (ADR-0054 decision 4).
 * The route contracts document them, and the edge tests check every reply
 * against them.
 */

/** A value's opaque version, as the decimal string inside its `ETag`. */
const VersionString = z.string().meta({
  description: 'The value\'s opaque version. Send it back as `If-Match: "<version>"`.',
});

/** `PUT /_api/data/{user,shared}/:key` 200 body. The new version is in the `ETag` header. */
export const DataPutResponseSchema = z
  .object({
    key: z.string(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: "DataPutResponse", description: "A stored value's key and write time." });
export type DataPutResponse = z.infer<typeof DataPutResponseSchema>;

/** `GET /_api/data/{user,shared}/:key` 200 body. The version is in the `ETag` header. */
export const DataGetResponseSchema = z
  .object({
    key: z.string(),
    value: z.unknown().meta({ description: "The stored JSON value, as written." }),
  })
  .meta({ id: "DataGetResponse", description: "A stored value." });
export type DataGetResponse = z.infer<typeof DataGetResponseSchema>;

/** One of the caller's user-scoped keys (no value). */
export const UserKeyMetaSchema = z.object({
  key: z.string(),
  updatedAt: z.iso.datetime(),
});
export type UserKeyMeta = z.infer<typeof UserKeyMetaSchema>;

/** `GET /_api/data/user` 200 body. */
export const DataKeyListSchema = z
  .object({ keys: z.array(UserKeyMetaSchema) })
  .meta({ id: "DataKeyList", description: "The caller's user-scoped keys, without values." });
export type DataKeyList = z.infer<typeof DataKeyListSchema>;

/**
 * One entry of a `shared`-scope list page (ADR-0042 decision 3). Key, version
 * and updatedAt, never the value: the app lists and then fetches what it
 * needs. `version` rides along so a caller can list and then write
 * conditionally without a read per key.
 */
export const SharedKeyMetaSchema = z.object({
  key: z.string(),
  version: VersionString,
  updatedAt: z.iso.datetime(),
});
export type SharedKeyMeta = z.infer<typeof SharedKeyMetaSchema>;

/** `GET /_api/data/shared?prefix=` 200 body; `nextCursor` is present only when more keys match. */
export const SharedKeyPageSchema = z
  .object({
    keys: z.array(SharedKeyMetaSchema),
    nextCursor: z
      .string()
      .optional()
      .meta({ description: "Pass as `cursor` to read the next page. Absent on the last page." }),
  })
  .meta({ id: "SharedKeyPage", description: "One page of shared keys under a prefix." });
export type SharedKeyPage = z.infer<typeof SharedKeyPageSchema>;

/** `details` of a 412 `conflict`: the version that won, or null when the key is absent. */
export const DataConflictDetailsSchema = z.object({
  currentVersion: VersionString.nullable(),
});
export type DataConflictDetails = z.infer<typeof DataConflictDetailsSchema>;

/** The 412 body: the `ApiError` envelope with `code: "conflict"` and typed `details`. */
export const DataConflictErrorSchema = z
  .object({
    error: z.object({
      code: z.literal("conflict"),
      message: z.string(),
      details: DataConflictDetailsSchema,
    }),
  })
  .meta({
    id: "DataConflictError",
    description: "A stated write precondition did not hold. Re-read and retry.",
  });
export type DataConflictError = z.infer<typeof DataConflictErrorSchema>;
