import { ApiErrorSchema } from "../../api.js";
import {
  defineRoute,
  jsonResponse,
  type BodySpec,
  type ResponseSpec,
  type RouteContract,
} from "../define.js";
import type { z } from "zod";

/** An error-envelope response. */
export function apiError(description: string): ResponseSpec {
  return jsonResponse(ApiErrorSchema, description);
}

export interface PortalRouteInput<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends BodySpec | undefined,
  R extends Record<number, ResponseSpec>,
> extends Omit<RouteContract<P, Q, B, R>, "api" | "auth" | "responses"> {
  /** Defaults to `bearer`. */
  auth?: RouteContract["auth"];
  /** The `ownsApp` preHandler: the caller owns the app or is a platform admin. */
  owner?: boolean;
  responses: R;
}

/**
 * Define a portal route, adding the error responses every portal route can
 * return:
 *
 * - 400 when the route reads params, a query, or a body;
 * - 401 for an authenticated route;
 * - 403 when the route is admin-only or owner-only;
 * - 404 when the route is owner-only (the app must exist);
 * - 413 and 415 from the body parser, on any method but GET;
 * - 500 always.
 *
 * A route's own entries win over these defaults.
 */
export function portalRoute<
  const P extends z.ZodObject | undefined = undefined,
  const Q extends z.ZodObject | undefined = undefined,
  const B extends BodySpec | undefined = undefined,
  const R extends Record<number, ResponseSpec> = Record<number, ResponseSpec>,
>(input: PortalRouteInput<P, Q, B, R>): RouteContract<P, Q, B, R> & { owner: boolean } {
  const { owner = false, auth = "bearer", responses, ...rest } = input;
  const defaults: Record<number, ResponseSpec> = {};
  if (rest.params || rest.query || rest.body) {
    defaults[400] = apiError("The request failed validation (`validation_failed`).");
  }
  if (auth !== "none") defaults[401] = apiError("Missing or invalid credentials (`unauthorized`).");
  if (rest.admin || owner) {
    defaults[403] = apiError(
      rest.admin
        ? "The caller is not a platform admin (`forbidden`)."
        : "The caller does not own the app and is not a platform admin (`forbidden`).",
    );
  }
  if (owner) defaults[404] = apiError("No app has this slug (`not_found`).");
  // Fastify's body parser answers these before the handler runs, on any
  // method that can carry a body.
  if (rest.method !== "GET") {
    defaults[413] = apiError("The request body exceeds the size limit (`bundle_invalid`).");
    defaults[415] = apiError(
      "The request body's content type is not one this route accepts (`validation_failed`).",
    );
  }
  defaults[500] = apiError("The platform failed (`internal`).");
  const description = [
    rest.description,
    rest.admin ? "Requires the platform-admin role." : undefined,
    owner ? "Requires ownership of the app, or the platform-admin role." : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...defineRoute({
      ...rest,
      api: "portal",
      auth,
      ...(description ? { description } : {}),
      responses: { ...defaults, ...responses } as R,
    }),
    owner,
  };
}
