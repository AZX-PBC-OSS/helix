import fp from "fastify-plugin";
import type { FastifyError } from "fastify";
import { ZodError } from "zod";
import type { ApiError, ApiErrorCode } from "@azx-pbc/shared";
import { redactUrl } from "@azx-pbc/shared/logging";

/** Default HTTP status for each error code. AppError may override. */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  bundle_invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  slug_taken: 409,
  conflict: 409,
  // Gateway codes (emitted by the edge, but the map is exhaustive over the
  // shared code set).
  model_not_allowed: 403,
  quota_exceeded: 429,
  rate_limited: 429,
  precondition_required: 428,
  capability_unavailable: 503,
  internal: 500,
};

/**
 * A domain error carrying a stable API error code. Routes throw these; the
 * error handler turns them into the shared {@link ApiError} envelope.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown, statusCode?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode ?? STATUS_BY_CODE[code];
  }
}

function envelope(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/**
 * Central error + not-found handling. Maps AppError, zod errors, Fastify
 * validation/multipart errors, and anything unexpected onto the uniform
 * {@link ApiError} envelope.
 */
export const errorsPlugin = fp(
  async (app) => {
    app.setNotFoundHandler((req, reply) => {
      // SPA deep links (/apps/foo) fall back to the SPA index when a built
      // bundle is being served (routes/spa.ts); API surface stays JSON.
      if (
        app.spaDist &&
        req.method === "GET" &&
        !req.url.startsWith("/api/") &&
        !req.url.startsWith("/health")
      ) {
        return reply.sendFile("index.html");
      }
      // Redacted for the same reason the access log is: without a built SPA,
      // `/auth/callback?code=…` falls through to here and the envelope would
      // echo the authorization code into a body that ends up in consoles,
      // client-side error reporting, and support tickets (issue #20).
      reply
        .status(404)
        .send(envelope("not_found", `route ${req.method} ${redactUrl(req.url)} not found`));
    });

    app.setErrorHandler((err: FastifyError, req, reply) => {
      if (err instanceof AppError) {
        reply.status(err.statusCode).send(envelope(err.code, err.message, err.details));
        return;
      }

      if (err instanceof ZodError) {
        reply
          .status(400)
          .send(envelope("validation_failed", "request validation failed", err.issues));
        return;
      }

      // Fastify schema validation.
      if (err.validation) {
        reply.status(400).send(envelope("validation_failed", err.message, err.validation));
        return;
      }

      // @fastify/multipart raises 413 when the bundle exceeds the size limit.
      if (err.statusCode === 413) {
        reply.status(413).send(envelope("bundle_invalid", "uploaded bundle is too large"));
        return;
      }

      req.log.error({ err }, "unhandled error");
      reply.status(500).send(envelope("internal", "internal server error"));
    });
  },
  { name: "errors" },
);
