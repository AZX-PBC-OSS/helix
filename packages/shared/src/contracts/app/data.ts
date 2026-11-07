// Contracts for the edge's /_api/data routes (ADR-0054).
import { z } from "zod";
import {
  DataConflictErrorSchema,
  DataGetResponseSchema,
  DataKeyListSchema,
  DataPutResponseSchema,
  SharedKeyPageSchema,
} from "../../appDataApi.js";
import { emptyResponse, jsonResponse, media, type BodySpec, type ResponseSpec } from "../define.js";
import { appApiError, appRoute, jsonBodyRefusals } from "./common.js";

const tags = ["App data"] as const;

/** The stored-value cap the handlers enforce on the serialized body. */
const MAX_VALUE_KIB = 64;

const KEY_RULE =
  "1–256 printable ASCII characters, with no leading or trailing space. Percent-encode it in the path.";

const keyParams = z.object({
  key: z
    .string()
    .min(1)
    .max(256)
    .meta({ description: `The key. ${KEY_RULE}` }),
});

const EtagHeader = z.object({
  etag: z.string().meta({ description: 'The value\'s version as a strong ETag, `"<version>"`.' }),
});

const writeHeaders = z.object({
  origin: z
    .string()
    .optional()
    .meta({ description: "Must be the app's own origin (CSRF check). Browsers send it." }),
  "if-match": z
    .string()
    .optional()
    .meta({
      description:
        'Write only if the current version is this one: exactly one strong ETag, `"<version>"`. ' +
        "`If-Match: *`, lists and weak validators are refused.",
    }),
  "if-none-match": z
    .string()
    .optional()
    .meta({ description: "`*`: create the key only if it does not exist yet." }),
});

const originHeader = writeHeaders.pick({ origin: true });

function valueBody(what: string): BodySpec {
  return {
    required: true,
    description: `${what} Any JSON value, \`null\` included, up to ${MAX_VALUE_KIB} KiB serialized.`,
    content: media("application/json", undefined, z.unknown()),
  };
}

const conflict = jsonResponse(
  DataConflictErrorSchema,
  "A stated precondition did not hold: the value changed since it was read, or it already " +
    "exists for `If-None-Match: *` (`conflict`). `details.currentVersion` is the version to " +
    "retry against, or null when the key is absent. Not charged against the write budget.",
);

const writeThrottle = appApiError(
  "The anonymous per-IP budget is exhausted on a public app (`rate_limited`), or the app's " +
    "daily write budget is exhausted (`quota_exceeded`).",
);

const readThrottle = appApiError(
  "The anonymous per-IP budget is exhausted on a public app (`rate_limited`).",
);

const storeFailed = appApiError("The data store failed (`internal`).");

const unconfigured = appApiError(
  "The data capability is not configured on this deployment (`capability_unavailable`).",
);

const notStored = appApiError("No value is stored under this key (`not_found`).");

function forbidden(extra: string): ResponseSpec {
  return appApiError(`The app has no data capability (\`forbidden\`)${extra}.`);
}

const USER_SCOPE =
  "User scope: each signed-in user's own keys, invisible to every other user. Unavailable " +
  "to anonymous visitors of public apps.";

const SHARED_SCOPE =
  "Shared scope: app-wide keys every visitor the app admits can reach, limited to the keys " +
  "and prefixes the app's manifest grants.";

export const putUserData = appRoute({
  id: "putUserData",
  method: "PUT",
  path: "/_api/data/user/:key",
  auth: "session",
  resolvesCaller: true,
  tags,
  summary: "Write a user-scoped value",
  description:
    `${USER_SCOPE}\n\nLast write wins unless the request states a precondition ` +
    "(`If-Match` or `If-None-Match: *`). The request must carry the app's own `Origin` " +
    "(CSRF check).",
  params: keyParams,
  headers: writeHeaders,
  body: valueBody("The value to store."),
  responses: {
    200: { ...jsonResponse(DataPutResponseSchema, "The value was stored."), headers: EtagHeader },
    400: appApiError(
      "The key, the body, its size, or a precondition header is invalid (`validation_failed`).",
    ),
    403: forbidden(
      ", no user-scope grant, or the caller is anonymous; or the `Origin` is not the app's own",
    ),
    412: conflict,
    429: writeThrottle,
    502: storeFailed,
    503: unconfigured,
    ...jsonBodyRefusals,
  },
});

export const getUserData = appRoute({
  id: "getUserData",
  method: "GET",
  path: "/_api/data/user/:key",
  auth: "session",
  resolvesCaller: true,
  tags,
  summary: "Read a user-scoped value",
  description: USER_SCOPE,
  params: keyParams,
  responses: {
    200: { ...jsonResponse(DataGetResponseSchema, "The stored value."), headers: EtagHeader },
    400: appApiError("The key is invalid (`validation_failed`)."),
    403: forbidden(", no user-scope grant, or the caller is anonymous"),
    404: notStored,
    429: readThrottle,
    502: storeFailed,
    503: unconfigured,
  },
});

export const deleteUserData = appRoute({
  id: "deleteUserData",
  method: "DELETE",
  path: "/_api/data/user/:key",
  auth: "session",
  resolvesCaller: true,
  tags,
  summary: "Delete a user-scoped value",
  description: `${USER_SCOPE}\n\nThe request must carry the app's own \`Origin\` (CSRF check).`,
  params: keyParams,
  headers: originHeader,
  responses: {
    204: emptyResponse("The value was deleted."),
    400: appApiError("The key is invalid (`validation_failed`)."),
    403: forbidden(
      ", no user-scope grant, or the caller is anonymous; or the `Origin` is not the app's own",
    ),
    404: notStored,
    429: readThrottle,
    502: storeFailed,
    503: unconfigured,
  },
});

export const listUserData = appRoute({
  id: "listUserData",
  method: "GET",
  path: "/_api/data/user",
  auth: "session",
  resolvesCaller: true,
  tags,
  summary: "List the caller's user-scoped keys",
  description: `${USER_SCOPE}\n\nKeys and write times only, never values.`,
  responses: {
    200: jsonResponse(DataKeyListSchema, "The caller's keys."),
    403: forbidden(", no user-scope grant, or the caller is anonymous"),
    429: readThrottle,
    502: storeFailed,
    503: unconfigured,
  },
});

export const appendCollectionItem = appRoute({
  id: "appendCollectionItem",
  method: "POST",
  path: "/_api/data/collections/:name",
  tags,
  summary: "Append an item to a collection",
  description:
    "Collections are write-only: an app can append items, and only the app's owner can read " +
    "them, in the portal. There is no read, list or delete route, and the response carries no " +
    "item id. Anonymous visitors of public apps may append. The request must carry the app's " +
    "own `Origin` (CSRF check).",
  params: z.object({
    name: z
      .string()
      .min(1)
      .max(256)
      .meta({ description: "A collection the app's manifest declares." }),
  }),
  headers: originHeader,
  body: valueBody("The item."),
  responses: {
    201: emptyResponse("The item was appended."),
    400: appApiError("The name, the body or its size is invalid (`validation_failed`)."),
    403: forbidden(
      ", the collection is not declared in the manifest, or the `Origin` is not the app's own",
    ),
    429: writeThrottle,
    502: storeFailed,
    503: unconfigured,
    ...jsonBodyRefusals,
  },
});

export const listSharedData = appRoute({
  id: "listSharedData",
  method: "GET",
  path: "/_api/data/shared",
  tags,
  summary: "List shared keys under a prefix",
  description:
    `${SHARED_SCOPE}\n\nThe prefix must be covered by one of the app's shared-read prefix ` +
    "grants; a literal key grant does not allow listing. Returns at most 200 keys per page, " +
    "with versions and write times but no values.",
  query: z.object({
    prefix: z
      .string()
      .min(1)
      .max(256)
      .meta({
        description: `The key prefix to list, equal to or narrower than a granted prefix. ${KEY_RULE}`,
      }),
    cursor: z
      .string()
      .optional()
      .meta({ description: "The `nextCursor` of the previous page. Opaque." }),
  }),
  responses: {
    200: jsonResponse(SharedKeyPageSchema, "One page of keys, in key order."),
    400: appApiError(
      "`prefix` is missing or invalid, or `cursor` is invalid or repeated (`validation_failed`).",
    ),
    403: forbidden(", or no shared-read prefix grant covers `prefix`"),
    429: readThrottle,
    502: storeFailed,
    503: unconfigured,
  },
});

export const getSharedData = appRoute({
  id: "getSharedData",
  method: "GET",
  path: "/_api/data/shared/:key",
  tags,
  summary: "Read a shared value",
  description: SHARED_SCOPE,
  params: keyParams,
  responses: {
    200: { ...jsonResponse(DataGetResponseSchema, "The stored value."), headers: EtagHeader },
    400: appApiError("The key is invalid (`validation_failed`)."),
    403: forbidden(", or the key is not shared-readable"),
    404: notStored,
    429: readThrottle,
    502: storeFailed,
    503: unconfigured,
  },
});

export const putSharedData = appRoute({
  id: "putSharedData",
  method: "PUT",
  path: "/_api/data/shared/:key",
  tags,
  summary: "Write a shared value",
  description:
    `${SHARED_SCOPE}\n\nEvery shared write must state a precondition: \`If-Match: ` +
    '"<version>"` from the last read, or `If-None-Match: *` to create the key. The request ' +
    "must carry the app's own `Origin` (CSRF check).",
  params: keyParams,
  headers: writeHeaders,
  body: valueBody("The value to store."),
  responses: {
    200: { ...jsonResponse(DataPutResponseSchema, "The value was stored."), headers: EtagHeader },
    400: appApiError(
      "The key, the body, its size, or a precondition header is invalid (`validation_failed`).",
    ),
    403: forbidden(", the key is not shared-writable, or the `Origin` is not the app's own"),
    412: conflict,
    428: appApiError(
      "The write stated no precondition, or only `If-Match: *` (`precondition_required`). Not " +
        "charged against the write budget.",
    ),
    429: writeThrottle,
    502: storeFailed,
    503: unconfigured,
    ...jsonBodyRefusals,
  },
});

/** In registration order; `apps/edge/src/app.ts` builds its data routes from this table. */
export const dataContracts = [
  putUserData,
  getUserData,
  deleteUserData,
  listUserData,
  appendCollectionItem,
  listSharedData,
  getSharedData,
  putSharedData,
] as const;
