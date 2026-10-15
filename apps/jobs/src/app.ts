import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  HealthStatusSchema,
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  JOBS_MAX_INPUT_BYTES,
  jobRequestError,
  worstHealthState,
} from "@azx-pbc/shared";
import { JobsOperations, type JobsOperationName } from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_JOBS_OPERATION,
  ATTR_OUTCOME,
  ATTR_REASON,
  SPAN_JOBS_CANCEL,
  SPAN_JOBS_LIFECYCLE,
  SPAN_JOBS_RESULT,
  SPAN_JOBS_SNAPSHOT,
  SPAN_JOBS_SUBMIT,
} from "@azx-pbc/shared/telemetry";
import { traceContextMixin } from "@azx-pbc/telemetry/correlation";
import { loggerOption, requestIdOptions } from "@azx-pbc/shared/logging";

import { jobsDatabaseCheck } from "./health.js";
import { SERVICE_NAME } from "./serviceName.js";
import type { JobsStorage } from "./storage.js";
import { withRootSpan } from "./telemetry.js";
import type { JobsInstructionAuth } from "./instructionAuth.js";

export { SERVICE_NAME };

/**
 * helix-jobs — the background-jobs service (ADR-0045). This composition owns
 * the listener's health contract and the signed internal operation routes:
 * each verifies its instruction and burns its nonce through the receiver seam
 * before anything else happens; the operation semantics themselves are the
 * later tickets' seams, and until one lands its route answers the protocol's
 * retryable unavailable error rather than pretending to have served.
 *
 * The health contract is the platform's always-200 three-state roll-up: a
 * service that can answer HTTP but cannot execute work reports the
 * degradation in the body, never in the status code (spec criterion 55) —
 * a non-200 would let a liveness probe restart a replica whose store is
 * merely unreachable.
 */
export interface JobsDeps {
  /** The storage lifecycle; `/health` reads its snapshot, never a live probe. */
  storage: JobsStorage;
  /** The signed-instruction receiver; every internal route authenticates through it. */
  instructions: JobsInstructionAuth;
}

/** A request that arrived with a body the raw-capturing parser held onto. */
interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

/**
 * A signed operation's post-authentication seam — what each route does once
 * its instruction has verified and its nonce has burned. Every operation's
 * semantics land with the ticket that owns them; until then the receiver
 * answers the protocol's retryable unavailable error rather than pretending,
 * and the log line is where the gap is named.
 */
async function notYetServed(
  operation: JobsOperationName,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  req.log.warn(
    { event: "jobs.operation.unimplemented", operation },
    "the instruction verified and its nonce burned, but this operation has no implementation yet",
  );
  reply.header("cache-control", "no-store");
  return reply.code(503).send(jobRequestError("jobs_unavailable"));
}

const OPERATION_SPAN_NAMES = {
  submit: SPAN_JOBS_SUBMIT,
  snapshot: SPAN_JOBS_SNAPSHOT,
  result: SPAN_JOBS_RESULT,
  cancel: SPAN_JOBS_CANCEL,
  lifecycle: SPAN_JOBS_LIFECYCLE,
} as const;

type ReceivedOperation = keyof typeof OPERATION_SPAN_NAMES;

/**
 * The internal routes' error boundary. An unhandled throw answers the fixed
 * envelope, never Fastify's default body with the error's message in it — and
 * the parser's own refusals map onto the protocol's fixed codes, because the
 * raw parser errors carry input bytes in their messages (a JSON.parse failure
 * quotes a fragment of the body).
 */
const internalErrorHandler = (
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply,
): void => {
  const status = error.statusCode ?? 500;
  if (status >= 500) {
    req.log.error(
      { err: error, event: "jobs.internal.unhandled_error" },
      "unhandled error serving an internal jobs operation",
    );
    reply.header("cache-control", "no-store");
    void reply.code(500).send(jobRequestError("platform_error"));
    return;
  }
  // A bounded client-side refusal: oversized input, unparsable JSON, an
  // unknown media type — the status carries the distinction, the body the
  // catalogue's fixed input-refusal code.
  req.log.warn(
    { event: "jobs.internal.rejected_request", status },
    "the request was refused before its instruction could be verified",
  );
  reply.header("cache-control", "no-store");
  void reply
    .code(status)
    .send(jobRequestError(status === 413 ? "payload_too_large" : "payload_invalid"));
};

/**
 * The handler every signed operation route is served through: the root span
 * (never parented from the unverified request), the instruction enforcement —
 * verify, then burn, before anything else — and the outcome the span carries.
 * The operation's name, method and route all come from the receiver's own
 * registration in the shared operation matrix; a token never supplies them.
 */
function signedOperationHandler(
  operation: ReceivedOperation,
  auth: JobsInstructionAuth,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return (req, reply) =>
    withRootSpan(
      OPERATION_SPAN_NAMES[operation],
      {
        "http.route": JobsOperations[operation].path,
        [ATTR_JOBS_OPERATION]: operation,
      },
      async (span) => {
        const verdict = await auth.authenticate(operation, {
          url: req.url,
          params: req.params as Readonly<Record<string, string>>,
          body: rawBodyOf(req),
          instructionHeader: req.headers[INSTRUCTION_HEADER],
          // The retry-key header matters to submit only. Every operation
          // refuses a body the receiver cannot bind to exact bytes: never
          // parsed (a bodyless method), or parsed by a media type that does
          // not capture bytes — never verified against empty.
          ...(operation === "submit"
            ? {
                idempotencyKeyHeader: req.headers[IDEMPOTENCY_KEY_HEADER],
                unbindableBody: unbindableBodyOf(req),
              }
            : { unbindableBody: unbindableBodyOf(req) }),
        });
        const attributes: Record<string, string> = {
          [ATTR_OUTCOME]: verdict.ok ? "accepted" : verdict.outcome,
        };
        if (!verdict.ok && verdict.reason !== undefined) attributes[ATTR_REASON] = verdict.reason;
        span.setAttributes(attributes);
        if (!verdict.ok) {
          reply.header("cache-control", "no-store");
          return reply.code(verdict.status).send(verdict.body);
        }
        return notYetServed(operation, req, reply);
      },
      { reply },
    );
}

/** The exact body bytes of a body-carrying request, from the raw-capturing parser. */
function rawBodyOf(req: FastifyRequest): Uint8Array {
  const rawBody = (req as RawBodyRequest).rawBody;
  return rawBody ? new Uint8Array(rawBody) : new Uint8Array(0);
}

/** Did the request arrive advertising a body? */
function advertisesBody(req: FastifyRequest): boolean {
  const length = req.headers["content-length"];
  if (typeof length === "string" && length !== "" && Number(length) > 0) return true;
  return req.headers["transfer-encoding"] !== undefined;
}

/**
 * Is there a body on this request that the receiver cannot bind to exact
 * bytes? True when a body was advertised but never captured by the
 * raw-capturing parser — a bodyless method's bytes (never parsed), or a
 * media type the service parses without capturing (text/plain, replaced
 * below). Such a body is refused at the seam, never verified against empty.
 */
function unbindableBodyOf(req: FastifyRequest): boolean {
  return advertisesBody(req) && (req as RawBodyRequest).rawBody === undefined;
}

export function buildApp(deps: JobsDeps): FastifyInstance {
  const app = Fastify({
    logger: loggerOption(undefined, { prefix: "JOBS", mixin: traceContextMixin }),
    // The same fail-closed id rule as every other service: unauthenticated
    // metadata never carries authority. The signed-instruction verification
    // is what authenticates a jobs caller; the request id stays self-minted.
    ...requestIdOptions({ trustInbound: false }),
  });

  // The internal routes bind the exact body bytes by digest, so the raw bytes
  // must survive parsing: this parser hands Fastify the parsed JSON AND keeps
  // the buffer on the request for the digest. The limit is the platform's
  // input bound (the submission admission owns the finer validation).
  //
  // text/plain gets its own bounded parser that captures nothing: Fastify's
  // built-in parses a text/plain body into `req.body` without capturing raw
  // bytes, which would let a body the receiver cannot bind ride a token
  // minted over the empty digest. Parsed-but-uncaptured is refused at the
  // seam (the unbindable-body refusal), never verified against empty. Every
  // other media type has no parser at all — a 415 before authentication,
  // which is a refusal either way.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: JOBS_MAX_INPUT_BYTES },
    (req, body, done) => {
      (req as unknown as RawBodyRequest).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch (error) {
        const parseError = error as FastifyError;
        parseError.statusCode = 400;
        done(parseError, undefined);
      }
    },
  );

  app.addContentTypeParser(
    "text/plain",
    { parseAs: "buffer", bodyLimit: JOBS_MAX_INPUT_BYTES },
    (_req, body, done) => {
      done(null, (body as Buffer).toString("utf8"));
    },
  );

  app.route({
    method: ["GET", "HEAD"],
    url: "/health",
    handler: async (_req, reply) => {
      // The snapshot, never a live probe: a health request must not wait on a
      // store that is down, and the probes' cadence is the loop's business.
      const checks = [jobsDatabaseCheck(deps.storage.snapshot())];
      reply.header("cache-control", "no-store"); // a degraded body must not be cached
      return HealthStatusSchema.parse({
        status: worstHealthState(checks.map((c) => c.status)),
        service: SERVICE_NAME,
        uptime: process.uptime(),
        checks,
      });
    },
  });

  // The signed internal operations, registered verbatim from the shared
  // operation matrix so a route and its signed binding cannot drift. Until an
  // operation's semantics land, a verified instruction reaches its route and
  // is answered with the protocol's retryable unavailable error.
  app.route({
    method: ["POST"],
    url: JobsOperations.submit.path,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("submit", deps.instructions),
  });

  app.route({
    method: ["GET"],
    url: JobsOperations.snapshot.path,
    // The matrix serves GET; the HEAD alias would let a GET-signed
    // instruction verify and burn on a HEAD presentation.
    exposeHeadRoute: false,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("snapshot", deps.instructions),
  });

  app.route({
    method: ["GET"],
    url: JobsOperations.result.path,
    exposeHeadRoute: false,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("result", deps.instructions),
  });

  app.route({
    method: ["DELETE"],
    url: JobsOperations.cancel.path,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("cancel", deps.instructions),
  });

  app.route({
    method: ["POST"],
    url: JobsOperations.lifecycle.path,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("lifecycle", deps.instructions),
  });

  // Genuinely unmatched requests are still the availability gate while the
  // store is unusable (a routing mistake on a ready service is the stock 404).
  app.setNotFoundHandler(async (req, reply) => {
    if (deps.storage.snapshot().state !== "ready") {
      reply.header("cache-control", "no-store");
      await reply.code(503).send(jobRequestError("jobs_unavailable"));
      return;
    }
    await reply.code(404).send({
      message: `Route ${req.method}:${req.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  return app;
}
