import { jobRequestError, type JobRequestError } from "@azx-pbc/shared";
import {
  buildJobsInternalResource,
  JobsOperations,
  type JobsInstructionClaims,
  type JobsOperationName,
  verifyJobsInstruction,
} from "@azx-pbc/shared/jobsSigning";
import type { JobsInstructionOutcome } from "@azx-pbc/shared/telemetry";

import type { JobsBurnStore } from "./burns.js";
import { countInstruction } from "./telemetry.js";

/**
 * The jobs receiver's instruction enforcement — the one seam every signed
 * internal request passes before its operation runs (ADR-0002). `authenticate`
 * verifies the `x-helix-instruction` token against what the ROUTE is serving
 * (the operation — and with it the direction, key and method — comes from the
 * route's registration, never from the token), then durably burns the
 * validated `jti`, in that order: a replayed, forged, altered or wrong-server
 * instruction is refused before any side effect, and a token is consumed by
 * its first valid presentation, not its first successful effect.
 *
 * Every denial is a fixed `{code, message}` body — the reject reason never
 * reaches the caller — while the operator's evidence (the counter's outcome,
 * the span's `helix.reason`, the log event) is bounded vocabulary only: no
 * token bytes, no claims, no URLs. A burn store that cannot answer denies
 * without a verdict (fail closed, retryable), never lets the operation run on
 * an unburned token.
 */

/** The structural logger the receiver reports through (the pino surface, without importing Fastify). */
export interface JobsInstructionLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface JobsInstructionAuthOptions {
  /** This receiver's configured server — the `server` claim is rechecked against it on every verify. */
  serverId: string;
  /** The two derived receiver keys, by direction; the operation fixes which one verifies a token. */
  keys: { readonly edgeToJobs: Uint8Array; readonly portalToJobs: Uint8Array };
  /** The durable nonce store; replay is a burn-store answer, not a verify answer. */
  burns: JobsBurnStore;
  /** Whole verification seconds — the real clock by default, injectable in tests. */
  clock?: () => number;
  log: JobsInstructionLogger;
}

/** The request facts an operation route hands over, exactly as received. */
export interface JobsInstructionRequest {
  /** The raw request target as received (`req.url` — path plus any query). */
  url: string;
  /**
   * The route's path parameters, as the router matched them — the receiver
   * rebuilds the concrete resource from them and the operation's own template
   * (`buildJobsInternalResource`), so a route and its signed binding cannot
   * drift and a malformed parameter is a denial, never a served request.
   */
  params: Readonly<Record<string, string>>;
  /** The exact body bytes received — empty for the bodyless operations. */
  body: Uint8Array;
  /**
   * A body arrived that the receiver cannot bind to exact bytes — never
   * parsed (a bodyless method), or parsed by a media type that does not
   * capture bytes. Such a body is refused rather than verified against the
   * empty digest it would otherwise match.
   */
  unbindableBody?: boolean;
  /** The instruction header as received (`string | string[] | undefined`). */
  instructionHeader: unknown;
  /** The retry-key header as received; read for submit only, where the signed claim must match it. */
  idempotencyKeyHeader?: unknown;
}

/**
 * Why a presentation was denied, for the span and the log — the verifier's
 * bounded reasons, plus the request-level classes that never reach it: no
 * instruction header at all; one that cannot be a token; a route parameter
 * that cannot name a resource.
 */
const DENIAL_REASON_MISSING = "missing";
const DENIAL_REASON_MALFORMED = "malformed";
const DENIAL_REASON_RESOURCE = "resource";

export type JobsInstructionAuthResult =
  | { ok: true; claims: JobsInstructionClaims }
  | {
      ok: false;
      status: 401 | 503;
      body: JobRequestError;
      outcome: JobsInstructionOutcome;
      reason?: string;
    };

export interface JobsInstructionAuth {
  authenticate(
    operation: JobsOperationName,
    request: JobsInstructionRequest,
  ): Promise<JobsInstructionAuthResult>;
}

export function createJobsInstructionAuth(
  options: JobsInstructionAuthOptions,
): JobsInstructionAuth {
  const clock = options.clock ?? ((): number => Math.floor(Date.now() / 1_000));

  /** Count, log (sanitized evidence only) and deny — the one path every refusal takes. */
  function denied(
    operation: JobsOperationName,
    outcome: Exclude<JobsInstructionOutcome, "accepted">,
    status: 401 | 503,
    reason?: string,
  ): JobsInstructionAuthResult {
    countInstruction(operation, outcome);
    if (outcome === "replayed") {
      options.log.warn(
        { event: "jobs.instruction.replayed" },
        "a verified instruction's nonce was already spent — denied as a replay",
      );
    } else if (outcome === "rejected") {
      options.log.warn(
        { event: "jobs.instruction.rejected", reason },
        "the instruction failed verification — denied",
      );
    }
    return {
      ok: false,
      status,
      body: status === 401 ? jobRequestError("unauthorized") : jobRequestError("jobs_unavailable"),
      outcome,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  return {
    async authenticate(
      operation: JobsOperationName,
      request: JobsInstructionRequest,
    ): Promise<JobsInstructionAuthResult> {
      // The direction comes from the receiver's own operation matrix, and this
      // receiver holds keys for its two receiving directions only — a route
      // registered for the jobs→edge callback direction would be a wiring
      // defect (the edge is that receiver), refused here rather than miskeyed.
      const direction = JobsOperations[operation].direction;
      if (direction === "jobsToEdge") {
        throw new Error(
          `the ${operation} operation's receiver is the edge — this service receives edge→jobs and portal→jobs instructions only`,
        );
      }
      const key = direction === "edgeToJobs" ? options.keys.edgeToJobs : options.keys.portalToJobs;

      // The signed resource is the path built from the route — a query string
      // or fragment on the request is a different resource than any signed
      // claim can name (the operation matrix has no query strings), so it is
      // refused outright rather than ignored.
      if (request.url.includes("?") || request.url.includes("#")) {
        return denied(operation, "rejected", 401, DENIAL_REASON_RESOURCE);
      }

      const header = request.instructionHeader;
      if (header === undefined || (typeof header === "string" && header.length === 0)) {
        return denied(operation, "rejected", 401, DENIAL_REASON_MISSING);
      }
      if (typeof header !== "string") {
        return denied(operation, "rejected", 401, DENIAL_REASON_MALFORMED);
      }

      // The retry-key header is submit-only and must agree with the signed
      // claim exactly; a repeated header is an unusable presentation, denied
      // before the token is spent on it.
      let idempotencyKeyHeader: string | null | undefined;
      if (operation === "submit") {
        if (Array.isArray(request.idempotencyKeyHeader)) {
          return denied(operation, "rejected", 401, DENIAL_REASON_MALFORMED);
        }
        idempotencyKeyHeader =
          typeof request.idempotencyKeyHeader === "string" ? request.idempotencyKeyHeader : null;
      }

      // The receiver rebuilds the concrete resource from its own route
      // params — a request path that cannot name a resource is a denial,
      // never a comparison against a quietly-wrong string.
      let resource: string;
      try {
        resource = buildJobsInternalResource(operation, request.params);
      } catch {
        return denied(operation, "rejected", 401, DENIAL_REASON_RESOURCE);
      }

      // A bodyless operation binds the empty digest: a request that arrived
      // with a body is a presentation the signed instruction never named.
      if (request.unbindableBody) {
        return denied(operation, "rejected", 401, "body");
      }

      const verdict = await verifyJobsInstruction(
        header,
        key,
        {
          server: options.serverId,
          operation,
          method: JobsOperations[operation].method,
          resource,
          body: request.body,
          ...(idempotencyKeyHeader !== undefined ? { idempotencyKeyHeader } : {}),
        },
        clock(),
      );
      if (!verdict.ok) {
        return denied(operation, "rejected", 401, verdict.reason);
      }

      // The burn is the replay gate, and it happens before the caller can do
      // anything: a store that cannot answer the claim denies the request
      // (retryable), because an unburned token that ran is the one thing a
      // replay could double.
      const burn = await options.burns.burn(direction, verdict.jti);
      if (burn.verdict === "replay") {
        return denied(operation, "replayed", 401);
      }
      if (burn.verdict === "store-unavailable") {
        options.log.warn(
          { event: "jobs.instruction.burn_failed", err: burn.error },
          "the instruction burn store could not record the nonce — denying without a verdict",
        );
        return denied(operation, "unavailable", 503);
      }

      countInstruction(operation, "accepted");
      return { ok: true, claims: verdict.claims };
    },
  };
}
