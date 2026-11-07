import { z } from "zod";
import { ApiErrorSchema } from "../../api.js";
import {
  defineRoute,
  jsonResponse,
  media,
  type BodySpec,
  type ContractAuth,
  type ResponseSpec,
  type RouteContract,
} from "../define.js";

/** An `ApiError` envelope response. */
export function appApiError(description: string): ResponseSpec {
  return jsonResponse(ApiErrorSchema, description);
}

/** A plain-text response, the shape of the edge's machine-facing terminals. */
export function plainText(description: string, mediaDescription?: string): ResponseSpec {
  return { description, content: media("text/plain", mediaDescription) };
}

/** An HTML page response. */
export function htmlPage(description: string, mediaDescription?: string): ResponseSpec {
  return { description, content: media("text/html", mediaDescription) };
}

/** `Retry-After`, sent with the edge's 503s and with throttling 429s. */
export const RetryAfterHeader = z.object({
  "retry-after": z.string().meta({ description: "Seconds to wait before retrying." }),
});

const LocationHeader = z.object({
  location: z.string().meta({ description: "Where the browser is sent." }),
});

/**
 * The 404 every app route can return. `sendNotFound` answers identically for
 * every reason, so a caller cannot tell which one applied.
 */
const NOT_FOUND = plainText(
  "Not found. The request was not made on an app host, the app does not exist or has no " +
    "live version, or this capability is not configured on this deployment. The reasons are " +
    "deliberately indistinguishable.",
  "`Not found`",
);

const GONE = htmlPage(
  "The app is archived. The response carries `Clear-Site-Data` so the browser drops the app's cached UI and storage.",
);

const REGISTRY_UNAVAILABLE: ResponseSpec = {
  ...plainText("The edge has not loaded the app registry yet. Retry shortly."),
  headers: RetryAfterHeader,
};

const GATE_UNAUTHORIZED = appApiError(
  "No session, or the session no longer grants access to this app (`unauthorized`), or the " +
    "session is due for a refresh (`refresh_required`). Reload the page so the browser " +
    "navigates through sign-in.",
);

const GATE_REDIRECT: ResponseSpec = {
  description:
    "A top-level navigation (`Sec-Fetch-Mode: navigate`, or an `Accept` that includes " +
    "`text/html`) without a usable session is redirected into sign-in instead of receiving " +
    "the 401.",
  headers: LocationHeader,
};

const MODE_FORBIDDEN = plainText(
  "The deployment's operator policy does not allow apps with this app's visibility mode.",
  "`Forbidden`",
);

const INTERNAL = appApiError("An unhandled failure (`internal`).");

/**
 * The refusals Fastify's JSON body parser raises before a handler runs. The
 * edge's error handler sends them in the `ApiError` envelope with the code
 * `internal` and the parser's own status; a malformed JSON body is a 400 of the
 * same shape.
 */
export const jsonBodyRefusals = {
  413: appApiError("The body exceeds the edge's request size limit (code `internal`)."),
  415: appApiError("The body is not `application/json` (code `internal`)."),
} as const;

export interface AppRouteInput<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends BodySpec | undefined,
  R extends Record<number, ResponseSpec>,
> extends Omit<RouteContract<P, Q, B, R>, "api" | "auth" | "responses"> {
  /** Defaults to `session-optional`, the gateway's posture: public apps accept anonymous callers. */
  auth?: ContractAuth;
  /**
   * Whether the route resolves its caller through the gateway's resolver,
   * which refuses an app whose visibility mode the operator policy forbids
   * (403 plain text). Defaults to true for `session-optional`.
   */
  resolvesCaller?: boolean;
  /**
   * Whether the platform session gate answers for an unauthenticated caller
   * (the JSON 401, or a redirect for a navigation). Defaults to true for the
   * session kinds. Routes that check the session themselves set it to false
   * and declare their own 401.
   */
  gate?: boolean;
  responses: R;
}

/** Merge two responses for one status: both media maps, both descriptions, both header sets. */
function mergeResponse(base: ResponseSpec, own: ResponseSpec): ResponseSpec {
  const content = base.content || own.content ? { ...base.content, ...own.content } : undefined;
  const headers =
    base.headers && own.headers
      ? base.headers.extend(own.headers.shape)
      : (own.headers ?? base.headers);
  return {
    description: `${own.description}\n\n${base.description}`,
    ...(content ? { content } : {}),
    ...(headers ? { headers } : {}),
  };
}

/**
 * Define an app API route (`/_api/*` on an app host), adding the responses
 * every app route can return:
 *
 * - 404 plain text: not an app host, an unknown app, or a capability this
 *   edge has not wired;
 * - 410 HTML: the app is archived;
 * - 503 plain text: the registry is not loaded yet;
 * - 401 JSON and a 302 for navigations, when the session gate answers;
 * - 403 plain text, when the route resolves its caller through the gateway's
 *   resolver and the operator policy refuses the app's visibility mode;
 * - 500 JSON, from the edge's error handler.
 *
 * Where a route declares the same status, the two are merged: the route's
 * media types are added to the default's, and the route's description comes
 * first. A route's own schema wins for a media type both declare.
 */
export function appRoute<
  const P extends z.ZodObject | undefined = undefined,
  const Q extends z.ZodObject | undefined = undefined,
  const B extends BodySpec | undefined = undefined,
  const R extends Record<number, ResponseSpec> = Record<number, ResponseSpec>,
>(input: AppRouteInput<P, Q, B, R>): RouteContract<P, Q, B, R> {
  const { auth = "session-optional", gate, resolvesCaller, responses, ...rest } = input;
  const gated = gate ?? (auth === "session" || auth === "session-optional");
  const defaults: Record<number, ResponseSpec> = {
    404: NOT_FOUND,
    410: GONE,
    503: REGISTRY_UNAVAILABLE,
    500: INTERNAL,
  };
  if (gated) {
    defaults[302] = GATE_REDIRECT;
    defaults[401] = GATE_UNAUTHORIZED;
  }
  if (resolvesCaller ?? auth === "session-optional") defaults[403] = MODE_FORBIDDEN;

  const merged: Record<number, ResponseSpec> = { ...defaults };
  for (const [key, own] of Object.entries(responses as Record<number, ResponseSpec>)) {
    const status = Number(key);
    const base = defaults[status];
    merged[status] = base ? mergeResponse(base, own) : own;
  }
  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => Number(a) - Number(b)),
  );

  const posture =
    auth === "session-optional"
      ? "Public apps accept anonymous callers; every other visibility mode requires the app's session."
      : auth === "session"
        ? "Requires the app's session."
        : undefined;
  const description = [rest.description, posture].filter(Boolean).join("\n\n");
  return defineRoute({
    ...rest,
    api: "app",
    auth,
    ...(description ? { description } : {}),
    responses: sorted as R,
  });
}
