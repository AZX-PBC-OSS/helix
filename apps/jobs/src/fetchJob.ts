import { SpanStatusCode, type Span } from "@opentelemetry/api";

import {
  FetchJobInputSchema,
  INSTRUCTION_HEADER,
  JOBS_MAX_RESULT_BYTES,
  JobRequestErrorSchema,
  type FetchJobInput,
  type JobErrorCode,
} from "@azx-pbc/shared";
import {
  JobsOperations,
  mintJobsInstruction,
  type JobsCallbackIdentity,
} from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_APP_ID,
  ATTR_JOBS_JOB_ID,
  ATTR_JOBS_TYPE,
  ATTR_OUTCOME,
  ATTR_REASON,
  type JobsFetchDispatchOutcome,
} from "@azx-pbc/shared/telemetry";

import { JobsExecutionError, type JobsExecutionContext, type JobsHandler } from "./execution.js";
import { countFetchDispatch, withFetchDispatchSpan } from "./telemetry.js";

/**
 * The production outbound fetch handler — the platform-authored work for the
 * one installed production type (`jobs:fetch`, background-jobs-plane design
 * §§2, 6; ADR-0006). The job's whole contract is here: make ONE governed GET
 * through the app's current fetch permissions, and return only the complete
 * upstream JSON value.
 *
 * The governed GET is not made here — it is dispatched to the edge's signed
 * jobs→edge callback (`POST /internal/jobs/v1/fetch`, the receiver the
 * callback ticket owns), which resolves the CURRENT registry entry, fences
 * the signed lifecycle generation, checks the origin allowlist and the
 * delegated prohibition, charges the app's fetch budget, mints the egress
 * instruction and streams the upstream bytes back. This handler owns its
 * caller side: the signed instruction minted from the job's immutable record
 * identity, the destination selected by the job's signed environment tier
 * (never by input, never with a fallback between tiers), the 30-second
 * outbound bound, the attempt's own abort signal, and the bounded
 * interpretation of the answer.
 *
 * The interpretation is terminal, never retried: the type has one execution
 * attempt and this handler makes one dispatch — a refusal, an upstream
 * failure, an unusable answer or a timeout is the job's distinct terminal
 * reason (a {@link JobsExecutionError}), with no partial output ever
 * returned. The byte bound is enforced on the STREAM — the response is
 * stopped the moment it passes the platform's result allowance, the excess
 * bytes are never read, and the attempt is failed with the oversized-result
 * reason rather than truncating.
 *
 * Progress is the one unit of work, completed only when a valid complete
 * JSON result is available: nothing is reported until the bytes have arrived
 * inside the bound and parsed as a complete JSON value (JSON `null` included
 * — a result, never absence), and the report is the last thing before the
 * value is returned.
 */

/** The dispatch's verdict, before the caller maps it onto the attempt's outcome. */
type FetchDispatchVerdict =
  | { kind: "result"; value: unknown }
  | {
      kind: "terminal";
      code: JobErrorCode;
      outcome: JobsFetchDispatchOutcome;
      reason: string;
    };

/** Why the dispatch's outbound wait ended without an answer. */
export interface FetchJobHandlerOptions {
  /** The configured job server this handler runs as — the instruction's issuer namespace. */
  serverId: string;
  /** The edge's fetch-callback base for `prod` jobs (`JOBS_EDGE_PROD_URL`). */
  prodCallbackUrl: string;
  /** The edge's fetch-callback base for `dev` jobs (`JOBS_EDGE_DEV_URL`). */
  devCallbackUrl: string;
  /** The derived jobs→edge minting key — this server's own callback root. */
  jobsToEdgeKey: Uint8Array;
  /**
   * The whole dispatch's bound, in ms — the platform's 30-second outbound
   * timeout (design §6). The attempt's own abort signal (a cancellation or a
   * claim expiry) stops the dispatch regardless of it.
   */
  timeoutMs?: number;
  /** Injectable transport for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, in ms (house convention). */
  clock?: () => number;
  log: FetchJobLogger;
}

/** The structural logger the handler reports through (the pino surface, without importing Fastify). */
export interface FetchJobLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** The outbound timeout design §6 gives the fetch type's one GET. */
export const JOBS_FETCH_OUTBOUND_TIMEOUT_MS = 30_000;

/** The progress label of the fetch type's one completed unit (platform-authored, byte-bounded by the schema). */
const FETCH_PROGRESS_LABEL = "fetched";

/**
 * The failure statuses' error codes, mapped onto the job's terminal reasons
 * and the dispatch's own outcome word. A code with no row — the callback's
 * own machinery refusing (unauthorized, jobs_disabled, jobs_unavailable) or
 * a body refusal — is a platform failure, never the upstream's fault.
 */
const REFUSAL_CLASSIFICATIONS: Record<
  string,
  { code: JobErrorCode; outcome: JobsFetchDispatchOutcome }
> = {
  outbound_forbidden: { code: "outbound_forbidden", outcome: "refused" },
  delegated_unattended: { code: "delegated_unattended", outcome: "refused" },
  outbound_quota_exceeded: { code: "outbound_quota_exceeded", outcome: "refused" },
  upstream_error: { code: "upstream_error", outcome: "upstream_error" },
};

/**
 * The production fetch handler, composed once per process with this server's
 * signing key and callback destinations. Registered for the installed
 * `jobs:fetch` type only — the registry's own screens refuse every other
 * name, so no caller input can select this code.
 */
export function makeFetchJobHandler(options: FetchJobHandlerOptions): JobsHandler {
  const timeoutMs = options.timeoutMs ?? JOBS_FETCH_OUTBOUND_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  const log = options.log;

  return async (context: JobsExecutionContext): Promise<unknown> => {
    // The input's meaning: the same contract the admission validated and the
    // attempt's start gate revalidated — parsed here (never cast) so the
    // handler's own view of it is typed. A refusal is impossible behind the
    // gate's parse of the same schema; if it ever fires it is platform
    // drift, and the generic failure boundary answers that.
    const input: FetchJobInput = FetchJobInputSchema.parse(context.input);

    return withFetchDispatchSpan(async (span: Span) => {
      span.setAttributes({
        [ATTR_APP_ID]: context.record.appId,
        [ATTR_JOBS_JOB_ID]: context.record.jobId,
        [ATTR_JOBS_TYPE]: context.record.type,
      });
      try {
        const verdict = await dispatch(context, input);
        if (verdict.kind === "terminal") {
          span.setAttribute(ATTR_OUTCOME, verdict.outcome);
          span.setAttribute(ATTR_REASON, verdict.reason);
          // The grading contract is the execute span's: a designed answer (a
          // policy refusal, the upstream's failure, the result refusals, the
          // timeout, the cancellation) stays UNSET — the platform working as
          // designed; the callback seam failing or drifting (platform_error
          // and everything it answers) grades ERROR.
          if (verdict.code === "platform_error") {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          countFetchDispatch(verdict.outcome);
          throw new JobsExecutionError(verdict.code);
        }
        span.setAttribute(ATTR_OUTCOME, "dispatched");
        countFetchDispatch("dispatched");
        // The one completed progress unit — only now, with a valid
        // complete JSON result in hand. A refused report is a claim that
        // can no longer land its outcome; the attempt's settlement is
        // fenced either way, so the value is still returned for the fence
        // to judge.
        await context.report({ step: 1, of: 1, label: FETCH_PROGRESS_LABEL });
        return verdict.value;
      } catch (error) {
        // A failure that is not the dispatch's own verdict escaped — a
        // defect in this handler (the instruction mint, a wiring error),
        // never a job answer. Recorded and failed here; the attempt's
        // generic failure boundary answers it as the platform error.
        if (!(error instanceof JobsExecutionError)) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw error;
      }
    });
  };

  /** The one dispatch — mint, carry, and classify the answer. Never retried. */
  async function dispatch(
    context: JobsExecutionContext,
    input: FetchJobInput,
  ): Promise<FetchDispatchVerdict> {
    const record = context.record;
    const body = new TextEncoder().encode(JSON.stringify({ url: input.url }));
    const iatS = Math.floor(clock() / 1_000);
    const identity: JobsCallbackIdentity = {
      appId: record.appId,
      env: record.env,
      ownerKind: record.ownerKind,
      ownerOid: record.ownerOid,
      type: record.type,
    };
    // The instruction binds the exact body bytes, the operation's own
    // method/resource and the job's immutable identity; a fresh `jti` per
    // mint is the replay contract's minter half.
    const instruction = await mintJobsInstruction(
      {
        operation: "fetch",
        server: options.serverId,
        identity,
        jobId: record.jobId,
        generation: record.generation,
        body,
        iatS,
      },
      options.jobsToEdgeKey,
    );

    // The destination by the job's signed tier — the deployment resolves
    // both at boot; a tier with no destination is a boot error, never a
    // fallback to the other tier's receiver.
    const base = record.env === "prod" ? options.prodCallbackUrl : options.devCallbackUrl;
    const url = `${base}${JobsOperations.fetch.path}`;
    // The outbound bound and the attempt's own abort — a cancellation or a
    // claim expiry — both stop the dispatch. No redirect is followed: the
    // signed contract binds one resource, and a redirect answer is not it.
    const bound = AbortSignal.timeout(timeoutMs);
    const outboundSignal = AbortSignal.any([context.signal, bound]);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: JobsOperations.fetch.method,
        headers: {
          "content-type": "application/json",
          [INSTRUCTION_HEADER]: instruction,
        },
        body: Buffer.from(body),
        signal: outboundSignal,
        redirect: "error",
      });
    } catch (error) {
      return withoutAnswer(error, context.signal, bound);
    }

    if (response.status !== 200) {
      // The bounded refusal: the edge answers every failure before any body
      // with the protocol's fixed error envelope — read bounded, classified,
      // never forwarded upstream text.
      const failureBody = await readBounded(response);
      if (failureBody.kind === "over") {
        return terminal("platform_error", "invalid_response", "refusal_over_cap");
      }
      if (failureBody.kind === "failed") {
        return streamFailed(failureBody.error, context.signal, bound);
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(new TextDecoder().decode(failureBody.body));
      } catch {
        log.warn(
          { event: "jobs.fetch.callback_invalid", status: response.status },
          "the fetch callback answered a failure status outside the protocol's error envelope",
        );
        return terminal("platform_error", "invalid_response", "unparsable_refusal");
      }
      const parsed = JobRequestErrorSchema.safeParse(envelope);
      if (!parsed.success) {
        log.warn(
          { event: "jobs.fetch.callback_invalid", status: response.status },
          "the fetch callback answered a failure status outside the protocol's error envelope",
        );
        return terminal("platform_error", "invalid_response", "nonprotocol_refusal");
      }
      const reason = parsed.data.code;
      log.warn(
        { event: "jobs.fetch.dispatch_refused", reason, status: response.status },
        "the fetch callback refused the job's governed GET",
      );
      const classified = REFUSAL_CLASSIFICATIONS[reason];
      return {
        kind: "terminal",
        code: classified?.code ?? "platform_error",
        outcome: classified?.outcome ?? "callback_unavailable",
        reason,
      };
    }

    // The one success: the upstream bytes, bounded on the stream — the cap
    // stops the response the moment it passes the result allowance, and
    // nothing over it is ever read or held.
    const bounded = await readBounded(response);
    if (bounded.kind === "over") {
      log.warn(
        { event: "jobs.fetch.result_too_large", appId: record.appId },
        "the upstream response passed the platform's result allowance — the stream was stopped, nothing stored",
      );
      return terminal("result_too_large", "result_too_large", "over_result_cap");
    }
    if (bounded.kind === "failed") {
      // After headers, a transport failure is the bounded upstream failure —
      // never a partial result (ADR-0006).
      return streamFailed(bounded.error, context.signal, bound);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bounded.body));
    } catch {
      log.warn(
        { event: "jobs.fetch.result_invalid", appId: record.appId },
        "the upstream response was not a complete JSON value — nothing stored",
      );
      return terminal("result_invalid", "result_invalid", "invalid_json");
    }
    return { kind: "result", value: parsed };
  }

  /** The dispatch ended without an answer: aborted, expired or refused at the transport. */
  function withoutAnswer(
    error: unknown,
    attemptSignal: AbortSignal,
    bound: AbortSignal,
  ): FetchDispatchVerdict {
    if (attemptSignal.aborted) {
      // The attempt's own abort — a cancellation or a claim expiry. The
      // settlement is fenced either way; the bounded reason is the honest one.
      return terminal("cancelled", "unreachable", "attempt_aborted");
    }
    if (bound.aborted) {
      log.warn(
        { event: "jobs.fetch.outbound_timeout", timeoutMs },
        "the governed GET did not answer within the outbound bound — the dispatch was aborted",
      );
      return terminal("timeout", "unreachable", "outbound_timeout");
    }
    log.error(
      { event: "jobs.fetch.unreachable", err: error },
      "the fetch callback could not be reached — the dispatch failed at the transport",
    );
    return terminal("platform_error", "unreachable", "unreachable");
  }

  /** A bounded body read that failed mid-stream, classified against the aborts — the read's own cause rides the log. */
  function streamFailed(
    error: unknown,
    attemptSignal: AbortSignal,
    bound: AbortSignal,
  ): FetchDispatchVerdict {
    if (attemptSignal.aborted) {
      return terminal("cancelled", "unreachable", "attempt_aborted");
    }
    if (bound.aborted) {
      log.warn(
        { event: "jobs.fetch.outbound_timeout", timeoutMs },
        "the governed GET's response did not finish within the outbound bound — the stream was aborted",
      );
      return terminal("timeout", "unreachable", "outbound_timeout");
    }
    log.warn(
      { event: "jobs.fetch.stream_failed", err: error },
      "the callback's response stream failed after the headers — no partial result is accepted",
    );
    return terminal("upstream_error", "upstream_error", "stream_failed");
  }

  /** One terminal verdict — the caller carries it to the span, the counter and the attempt's failure boundary. */
  function terminal(
    code: JobErrorCode,
    outcome: JobsFetchDispatchOutcome,
    reason: string,
  ): FetchDispatchVerdict {
    return { kind: "terminal", code, outcome, reason };
  }
}

/** The bounded read's verdict over one callback response. */
type BoundedRead =
  | { kind: "bytes"; body: Uint8Array }
  | { kind: "over" }
  | { kind: "failed"; error: unknown };

/**
 * Read one response body to bytes under the platform's result allowance —
 * counting the stream's own bytes (framing-independent), cancelling the
 * stream the moment the cap trips, and reporting a mid-stream transport
 * failure as its own verdict (its cause attached — the abort's
 * classification is the caller's; it holds the two signals). The whole wait
 * is bounded by the dispatch signal the response was fetched with.
 */
async function readBounded(response: Response): Promise<BoundedRead> {
  const body = response.body;
  if (!body) {
    return { kind: "bytes", body: new Uint8Array(0) };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > JOBS_MAX_RESULT_BYTES) {
          // Stop the stream — the abort propagates back through the edge's
          // pipe to the egress forward. The excess bytes are never read.
          await reader.cancel();
          return { kind: "over" };
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    return { kind: "failed", error };
  }
  return { kind: "bytes", body: new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c)))) };
}
