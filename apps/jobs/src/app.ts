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
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobSnapshotSchema,
  JobsLifecycleUpdateAckSchema,
  JobsLifecycleUpdateSchema,
  jobRequestError,
  worstHealthState,
  JOB_STATEFUL_ERROR_CODES,
  type JobRequestErrorCode,
  type JobsCapacityLimits,
} from "@azx-pbc/shared";
import type {
  JobsCancelClaims,
  JobsResultClaims,
  JobsSubmitClaims,
  JobsSnapshotClaims,
} from "@azx-pbc/shared/jobsSigning";
import { JobsOperations } from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_APP_ID,
  ATTR_JOBS_ARCHIVED,
  ATTR_JOBS_GENERATION,
  ATTR_JOBS_JOB_ID,
  ATTR_JOBS_LIFECYCLE_STAMPED,
  ATTR_JOBS_OPERATION,
  ATTR_OUTCOME,
  ATTR_REASON,
  SPAN_JOBS_CANCEL,
  SPAN_JOBS_LIFECYCLE,
  SPAN_JOBS_RESULT,
  SPAN_JOBS_SNAPSHOT,
  SPAN_JOBS_SUBMIT,
  type JobsCancelOutcome,
  type JobsResultOutcome,
  type JobsSnapshotOutcome,
  type JobsSubmitOutcome,
} from "@azx-pbc/shared/telemetry";
import { traceContextMixin } from "@azx-pbc/telemetry/correlation";
import { loggerOption, requestIdOptions } from "@azx-pbc/shared/logging";
import type { Span } from "@opentelemetry/api";

import type { JobsAdmission, JobsAdmissionResult } from "./acceptance.js";
import type { JobsCancelRequest, JobsCancelVerdict, JobsCancellation } from "./cancellation.js";
import type { JobsCleanupSnapshot } from "./cleanup.js";
import type { JobsIntakeSnapshot } from "./intake.js";
import {
  jobsCapacityCheck,
  jobsCleanupCheck,
  jobsDatabaseCheck,
  jobsIntakeCheck,
  jobsLifecycleRecoveryCheck,
  jobsSweeperCheck,
  jobsWorkerCheck,
} from "./health.js";
import type { JobsObservation, JobsResultVerdict, JobsSnapshotVerdict } from "./observation.js";
import type { JobsRecoverySnapshot } from "./recovery.js";
import type { JobsRunnerSnapshot } from "./runner.js";
import { SERVICE_NAME } from "./serviceName.js";
import type { JobsStorage } from "./storage.js";
import { withRootSpan } from "./telemetry.js";
import type { JobsInstructionAuth } from "./instructionAuth.js";
import type { JobsInstructionOutcome, JobsLifecycleOutcome } from "@azx-pbc/shared/telemetry";
import type { JobsLifecycleApplier } from "./lifecycle.js";

export { SERVICE_NAME };

/**
 * helix-jobs — the background-jobs service (ADR-0045). This composition owns
 * the listener's health contract and the signed internal operation routes:
 * each verifies its instruction and burns its nonce through the receiver seam
 * before anything else happens. Lifecycle delivery (the portal's
 * apply-before-acknowledge generation authority), submission (the acceptance
 * transaction's keyed recovery, validation and atomic enqueue), cancellation
 * (the durable intent write plus the runner drive) and the owner-scoped
 * observation reads (the logical public-read horizons' projection) are served
 * here, and the served surface is exactly the shared operation matrix.
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
  /** The durable app-lifecycle authority; the lifecycle route applies deliveries through it. */
  lifecycle: JobsLifecycleApplier;
  /** The acceptance seam; the submit route's decisions run through it. */
  admission: JobsAdmission;
  /** The owner-cancellation seam; the cancel route's decisions run through it — the durable intent write plus the runner drive, in that order. */
  cancellation: JobsCancellation;
  /** The owner-scoped observation seam; the snapshot and result routes' reads run through it — the logical public-read horizons' projection. */
  observation: JobsObservation;
  /**
   * The runner's supervision state, read per request — `/health`'s
   * `jobs_worker` check grades it (the runner started, the worker
   * registered), never a live probe.
   */
  worker: () => JobsRunnerSnapshot;
  /**
   * The recovery sweeper's supervision state, read per request —
   * `/health`'s `jobs_sweeper` check grades it (the loop running, its last
   * successful pass fresh), never a live probe.
   */
  recovery: () => JobsRecoverySnapshot;
  /**
   * The cleanup loop's supervision state, read per request — `/health`'s
   * `jobs_cleanup` (lag/overdue) and `jobs_capacity` (retained saturation)
   * checks grade the measurement its last successful pass took, never a
   * live probe.
   */
  cleanup: () => JobsCleanupSnapshot;
  /**
   * The intake applier's supervision state, read per request — `/health`'s
   * `jobs_intake` check grades whether the configured intake posture is
   * durably applied (and, closed, the drain progress the cleanup loop's
   * measurement carries), never a live probe.
   */
  intake: () => JobsIntakeSnapshot;
  /**
   * The resolved capacity limits this deployment enforces — the
   * `jobs_capacity` check grades server-wide retained saturation against
   * them. The same resolved set the acceptance store enforces; a hand-built
   * app carrying different numbers would grade a capacity posture the
   * service does not run under.
   */
  capacityLimits: JobsCapacityLimits;
}

/** A request that arrived with a body the raw-capturing parser held onto. */
interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

/**
 * The lifecycle delivery's operation (ADR-0007): apply the portal's
 * `{generation, archived}` change durably — highest generation wins, older
 * deliveries reopen nothing — and only then acknowledge with the generation
 * actually applied. The body parse is the first post-verification gate (the
 * instruction's digest bound guarantees the bytes, not their meaning); a
 * store that cannot answer leaves nothing applied and nothing acknowledged.
 * The delivery's own evidence — the target app, the delivered generation and
 * its archived flag, and the apply's outcome — rides the span, all bounded.
 */
async function serveLifecycle(
  deps: JobsDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  span: Span,
): Promise<void> {
  const appId = (req.params as { appId?: string }).appId;
  if (appId === undefined) {
    // Unreachable through the route (the path parameter is mandatory) — a
    // defect in the wiring, not a request answer.
    throw new Error("the lifecycle route served a request with no app id parameter");
  }
  const parsed = JobsLifecycleUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { event: "jobs.lifecycle.rejected_body" },
      "a verified lifecycle delivery carried a body that is not a lifecycle update",
    );
    span.setAttribute(ATTR_OUTCOME, "invalid_body" satisfies JobsLifecycleOutcome);
    reply.header("cache-control", "no-store");
    return reply.code(400).send(jobRequestError("payload_invalid"));
  }
  span.setAttributes({
    [ATTR_APP_ID]: appId,
    [ATTR_JOBS_GENERATION]: parsed.data.generation,
    [ATTR_JOBS_ARCHIVED]: parsed.data.archived,
  });
  let applied;
  try {
    applied = await deps.lifecycle.apply(appId, parsed.data);
  } catch (error) {
    // Any failure of the apply means nothing was applied and nothing is
    // acknowledged: the retryable refusal is the honest answer, and the
    // portal's sender delivers again with a fresh instruction.
    req.log.error(
      { event: "jobs.lifecycle.unavailable", err: error },
      "the lifecycle store could not apply a delivery",
    );
    span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsLifecycleOutcome);
    deps.storage.reportRequestFailure();
    reply.header("cache-control", "no-store");
    return reply.code(503).send(jobRequestError("jobs_unavailable"));
  }
  span.setAttributes({
    [ATTR_OUTCOME]: (applied.changed ? "applied" : "stale") satisfies JobsLifecycleOutcome,
    // The delivery's cancellation reach: the still-active closed-generation
    // records this apply stamped with durable intent before the commit — the
    // archive's own evidence of the work its recovery paths will carry to
    // terminal outcomes. A bounded count; never a job id, URL or owner.
    [ATTR_JOBS_LIFECYCLE_STAMPED]: applied.stamped,
  });
  reply.header("cache-control", "no-store");
  // The ack is validated against the wire schema before it is sent — a store
  // answer that cannot parse is a defect answered 500 by the error boundary,
  // never a malformed body on the wire.
  return reply.code(200).send(
    JobsLifecycleUpdateAckSchema.parse({
      appliedGeneration: applied.appliedGeneration,
    }),
  );
}

/** The fixed refusal each non-accepted submit outcome answers with. (The store signals unavailability by throwing — the route's catch maps that.) */
const SUBMIT_REFUSALS: Record<
  Exclude<JobsAdmissionResult["outcome"], "accepted" | "recovered" | "conflict">,
  {
    status: number;
    code: Exclude<JobRequestErrorCode, (typeof JOB_STATEFUL_ERROR_CODES)[number]>;
  }
> = {
  invalid_input: { status: 400, code: "payload_invalid" },
  type_unknown: { status: 403, code: "forbidden" },
  closed: { status: 403, code: "forbidden" },
  unseen: { status: 503, code: "jobs_unavailable" },
  // A definitive refusal of new work — but 503, not 403: a closed intake may
  // reopen on the same store, and a client's earlier uncertain submission is
  // still recovered by retrying its key (the retained-key comparison decided
  // before this).
  intake_closed: { status: 503, code: "jobs_disabled" },
  // An ordinary busy refusal — the worker is fine; the caller backs off and
  // retries (spec criterion 55: capacity refusal alone never marks anything
  // unhealthy, and this 4xx keeps the span UNSET with it).
  capacity_exceeded: { status: 429, code: "jobs_capacity_exceeded" },
  // An identical-bytes keyed replay of a job whose public record access has
  // expired: the same 404 an unknown job answers with, no work created while
  // the row is still retained (criterion 14).
  not_found: { status: 404, code: "job_not_found" },
};

/**
 * The submission's operation (ADR-0003): the acceptance transaction's decision
 * — keyed recovery, conflict, validation or intake refusal, or a new job's
 * reference — mapped onto the protocol's responses. A store that cannot
 * answer leaves nothing committed and is the retryable 503; the edge mints a
 * fresh instruction and presents the same retry identity again. The span's
 * outcome is the admission's own vocabulary, with the bounded evidence the
 * delivery-style operations carry (the submitting app and its claimed
 * generation — never the retry key, the input, or the job id).
 */
async function serveSubmit(
  deps: JobsDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  span: Span,
  claims: JobsSubmitClaims,
  body: Uint8Array,
): Promise<void> {
  let result: JobsAdmissionResult;
  try {
    result = await deps.admission.admit({ claims, body });
  } catch (error) {
    req.log.error(
      { event: "jobs.admission.unavailable", err: error },
      "the acceptance store could not decide a submission",
    );
    span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsSubmitOutcome);
    deps.storage.reportRequestFailure();
    reply.header("cache-control", "no-store");
    return reply.code(503).send(jobRequestError("jobs_unavailable"));
  }
  span.setAttributes({
    [ATTR_APP_ID]: claims.appId,
    [ATTR_JOBS_GENERATION]: claims.generation,
  });
  span.setAttribute(ATTR_OUTCOME, result.outcome satisfies JobsSubmitOutcome);
  reply.header("cache-control", "no-store");
  if (result.outcome === "accepted" || result.outcome === "recovered") {
    // The response is validated against the wire schema before it is sent —
    // a store answer that cannot parse is a defect answered 500 by the error
    // boundary, never a malformed body on the wire.
    return reply.code(202).send(
      JobAcceptedSchema.parse({
        server: claims.server,
        jobId: result.jobId,
        status: result.status,
      }),
    );
  }
  if (result.outcome === "conflict") {
    return reply.code(409).send(
      jobRequestError("idempotency_conflict", {
        status: result.status,
        error: result.error,
      }),
    );
  }
  const refusal = SUBMIT_REFUSALS[result.outcome];
  return reply.code(refusal.status).send(jobRequestError(refusal.code));
}

/**
 * The owner-cancellation's operation (background-jobs-plane design §6): the
 * durable intent write plus the runner drive, in that order, mapped onto the
 * protocol's responses. The 202 is the acknowledgement the durable intent
 * earns — it confirms the request was recorded, never that the job has
 * stopped (a competing terminal outcome may still win the race, and the
 * bounded paths — the worker-start gate, the recovery sweeper's cancellation
 * arm — carry the pending intent to its terminal outcome within the
 * healthy-service bound). A repeat while active is the same 202; a terminal
 * job answers 409 with its own status and nothing changes; an unknown or
 * foreign-owned job is the same 404; a caller whose grants do not cover the
 * job's type is 403. The span carries the bounded evidence — the addressed
 * app and the job's public id — never the owner identity or any job value.
 */
async function serveCancel(
  deps: JobsDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  span: Span,
  claims: JobsCancelClaims,
): Promise<void> {
  const jobId = (req.params as { jobId?: string }).jobId;
  if (jobId === undefined) {
    // Unreachable through the route (the path parameter is mandatory) — a
    // defect in the wiring, not a request answer.
    throw new Error("the cancel route served a request with no job id parameter");
  }
  span.setAttributes({
    [ATTR_APP_ID]: claims.appId,
    [ATTR_JOBS_JOB_ID]: jobId,
  });
  const request: JobsCancelRequest = { claims, jobId };
  let verdict: JobsCancelVerdict;
  try {
    verdict = await deps.cancellation.requestCancel(request);
  } catch (error) {
    req.log.error(
      { event: "jobs.cancellation.unavailable", appId: claims.appId, err: error },
      "the cancellation store could not decide a request",
    );
    span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsCancelOutcome);
    deps.storage.reportRequestFailure();
    reply.header("cache-control", "no-store");
    return reply.code(503).send(jobRequestError("jobs_unavailable"));
  }
  reply.header("cache-control", "no-store");
  switch (verdict.outcome) {
    case "requested":
      span.setAttribute(ATTR_OUTCOME, "requested" satisfies JobsCancelOutcome);
      // The acknowledgement is validated against the wire schema before it
      // is sent — a constructed body that cannot parse is a defect answered
      // 500 by the error boundary, never a malformed body on the wire.
      return reply.code(202).send(
        JobCancellationAcceptedSchema.parse({
          server: claims.server,
          jobId,
          cancellationRequested: true,
        }),
      );
    case "not_found":
      span.setAttribute(ATTR_OUTCOME, "not_found" satisfies JobsCancelOutcome);
      return reply.code(404).send(jobRequestError("job_not_found"));
    case "forbidden":
      span.setAttribute(ATTR_OUTCOME, "forbidden" satisfies JobsCancelOutcome);
      return reply.code(403).send(jobRequestError("forbidden"));
    case "terminal":
      span.setAttribute(ATTR_OUTCOME, "terminal" satisfies JobsCancelOutcome);
      return reply
        .code(409)
        .send(jobRequestError("job_terminal", { status: verdict.status, error: verdict.error }));
  }
}

/** The refusals every record operation answers with — the unknown-job 404 and the lapsed grant's 403. */
const RECORD_ACCESS_REFUSALS = {
  not_found: { status: 404, body: jobRequestError("job_not_found") },
  forbidden: { status: 403, body: jobRequestError("forbidden") },
} as const;

/**
 * The owner status poll's operation (ADR-0005): the observation store's
 * complete latest snapshot — terminal outcome, cancellation intent and
 * result/record expiry information included — mapped onto the protocol.
 * Authorization runs on every poll: a foreign or publicly expired record is
 * the same 404 an unknown job answers with, a lapsed grant the 403, and a
 * store that cannot answer the retryable 503 — an observation failure, never
 * an execution one, and the last known state stays visibly stale. The span
 * carries the bounded evidence — the addressed app and the job's public id —
 * never the owner identity or any job value.
 */
async function serveSnapshot(
  deps: JobsDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  span: Span,
  claims: JobsSnapshotClaims,
): Promise<void> {
  const jobId = (req.params as { jobId?: string }).jobId;
  if (jobId === undefined) {
    // Unreachable through the route (the path parameter is mandatory) — a
    // defect in the wiring, not a request answer.
    throw new Error("the snapshot route served a request with no job id parameter");
  }
  span.setAttributes({
    [ATTR_APP_ID]: claims.appId,
    [ATTR_JOBS_JOB_ID]: jobId,
  });
  let verdict: JobsSnapshotVerdict;
  try {
    verdict = await deps.observation.snapshot({ claims, jobId });
  } catch (error) {
    req.log.error(
      { event: "jobs.observation.unavailable", appId: claims.appId, err: error },
      "the observation store could not answer a status read",
    );
    span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsSnapshotOutcome);
    deps.storage.reportRequestFailure();
    reply.header("cache-control", "no-store");
    return reply.code(503).send(jobRequestError("jobs_unavailable"));
  }
  reply.header("cache-control", "no-store");
  if (verdict.outcome !== "found") {
    span.setAttribute(ATTR_OUTCOME, verdict.outcome satisfies JobsSnapshotOutcome);
    if (verdict.outcome === "not_found")
      return reply.code(404).send(RECORD_ACCESS_REFUSALS.not_found.body);
    return reply.code(403).send(RECORD_ACCESS_REFUSALS.forbidden.body);
  }
  span.setAttribute(ATTR_OUTCOME, "found" satisfies JobsSnapshotOutcome);
  // The snapshot is validated against the wire schema before it is sent — a
  // store answer that cannot parse is a defect answered 500 by the error
  // boundary, never a malformed body on the wire.
  return reply.code(200).send(JobSnapshotSchema.parse(verdict.snapshot));
}

/**
 * The owner result read's operation (background-jobs-plane design §7): the
 * job's successful result as the raw JSON value — JSON `null` included, sent
 * as the stored canonical bytes, never re-serialized — or the stateful 409
 * while the work is unfinished (`job_not_ready`) or terminal without a
 * result (`job_terminal`), or the 410 `result_expired` from the result
 * horizon's boundary onward. Authorization is the snapshot's, with the same
 * 404 for a foreign or publicly expired record. The span carries the same
 * bounded evidence as the status poll's.
 */
async function serveResult(
  deps: JobsDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  span: Span,
  claims: JobsResultClaims,
): Promise<void> {
  const jobId = (req.params as { jobId?: string }).jobId;
  if (jobId === undefined) {
    throw new Error("the result route served a request with no job id parameter");
  }
  span.setAttributes({
    [ATTR_APP_ID]: claims.appId,
    [ATTR_JOBS_JOB_ID]: jobId,
  });
  let verdict: JobsResultVerdict;
  try {
    verdict = await deps.observation.result({ claims, jobId });
  } catch (error) {
    req.log.error(
      { event: "jobs.observation.unavailable", appId: claims.appId, err: error },
      "the observation store could not answer a result read",
    );
    span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsResultOutcome);
    deps.storage.reportRequestFailure();
    reply.header("cache-control", "no-store");
    return reply.code(503).send(jobRequestError("jobs_unavailable"));
  }
  reply.header("cache-control", "no-store");
  span.setAttribute(ATTR_OUTCOME, verdict.outcome satisfies JobsResultOutcome);
  switch (verdict.outcome) {
    case "found":
      // The stored canonical JSON text, as exact bytes: the stored form is
      // what the result bound measured, and a re-serialization could not hold
      // a result at the cap's maximum legal depth.
      return reply.code(200).type("application/json").send(Buffer.from(verdict.resultText, "utf8"));
    case "not_ready":
      return reply
        .code(409)
        .send(jobRequestError("job_not_ready", { status: verdict.status, error: verdict.error }));
    case "terminal":
      return reply
        .code(409)
        .send(jobRequestError("job_terminal", { status: verdict.status, error: verdict.error }));
    case "expired":
      return reply.code(410).send(jobRequestError("result_expired"));
    case "not_found":
      return reply.code(404).send(RECORD_ACCESS_REFUSALS.not_found.body);
    case "forbidden":
      return reply.code(403).send(RECORD_ACCESS_REFUSALS.forbidden.body);
  }
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
  deps: JobsDeps,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return (req, reply) =>
    withRootSpan(
      OPERATION_SPAN_NAMES[operation],
      {
        "http.route": JobsOperations[operation].path,
        [ATTR_JOBS_OPERATION]: operation,
      },
      async (span) => {
        // Job routes answer 503 until the store verifies compatible (design
        // §8). Each operation would otherwise run against whichever of its
        // tables happen to exist while /health reports the store unusable.
        // Lifecycle delivery stays open: it is the convergence path, and its
        // own store answers for itself.
        if (operation !== "lifecycle" && deps.storage.snapshot().state !== "ready") {
          span.setAttribute(ATTR_OUTCOME, "unavailable" satisfies JobsInstructionOutcome);
          reply.header("cache-control", "no-store");
          return reply.code(503).send(jobRequestError("jobs_unavailable"));
        }
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
          // The only 503 verdict is the burn store failing to answer.
          if (verdict.status === 503) deps.storage.reportRequestFailure();
          reply.header("cache-control", "no-store");
          return reply.code(verdict.status).send(verdict.body);
        }
        // The operation's own semantics. Once one runs, its outcome is the
        // span's — the verification verdict's "accepted" is superseded by
        // what the operation actually did. The claims are narrowed at the
        // seam, not cast: the receiver parsed them with the operation's own
        // claim schema, and the guard below is what holds that pairing — a
        // receiver whose schema map drifted fails this route loudly instead
        // of serving misparsed claims.
        switch (operation) {
          case "submit": {
            if (verdict.claims.operation !== "submit") {
              throw new Error("the submit route served claims that are not submit claims");
            }
            return serveSubmit(deps, req, reply, span, verdict.claims, rawBodyOf(req));
          }
          case "snapshot": {
            if (verdict.claims.operation !== "snapshot") {
              throw new Error("the snapshot route served claims that are not snapshot claims");
            }
            return serveSnapshot(deps, req, reply, span, verdict.claims);
          }
          case "result": {
            if (verdict.claims.operation !== "result") {
              throw new Error("the result route served claims that are not result claims");
            }
            return serveResult(deps, req, reply, span, verdict.claims);
          }
          case "cancel": {
            if (verdict.claims.operation !== "cancel") {
              throw new Error("the cancel route served claims that are not cancel claims");
            }
            return serveCancel(deps, req, reply, span, verdict.claims);
          }
          case "lifecycle":
            return serveLifecycle(deps, req, reply, span);
        }
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
    // Job ids are legal to 128 characters (the shared reference grammar);
    // the router's own default (100) would refuse them 414 before the
    // record routes' handlers ran. A router-level option, so every
    // parametric route here shares the bound.
    routerOptions: { maxParamLength: 128 },
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
      const checks = [
        jobsDatabaseCheck(deps.storage.snapshot()),
        jobsWorkerCheck(deps.worker()),
        jobsSweeperCheck(deps.recovery()),
        jobsCapacityCheck(deps.cleanup(), deps.capacityLimits),
        jobsLifecycleRecoveryCheck(deps.recovery()),
        jobsCleanupCheck(deps.cleanup()),
        jobsIntakeCheck(deps.intake(), deps.cleanup()),
      ];
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
  // operation matrix so a route and its signed binding cannot drift. Each
  // route serves its own seam: the lifecycle delivery (the generation
  // authority's apply-before-acknowledge receiver), the acceptance
  // transaction (ADR-0003), the owner cancellation (the durable intent plus
  // the runner drive) and the owner-scoped observation reads (the logical
  // public-read horizons' projection).
  app.route({
    method: ["POST"],
    url: JobsOperations.submit.path,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("submit", deps.instructions, deps),
  });

  app.route({
    method: ["GET"],
    url: JobsOperations.snapshot.path,
    // The matrix serves GET; the HEAD alias would let a GET-signed
    // instruction verify and burn on a HEAD presentation.
    exposeHeadRoute: false,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("snapshot", deps.instructions, deps),
  });

  app.route({
    method: ["GET"],
    url: JobsOperations.result.path,
    exposeHeadRoute: false,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("result", deps.instructions, deps),
  });

  app.route({
    method: ["DELETE"],
    url: JobsOperations.cancel.path,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("cancel", deps.instructions, deps),
  });

  app.route({
    method: ["POST"],
    url: JobsOperations.lifecycle.path,
    errorHandler: internalErrorHandler,
    handler: signedOperationHandler("lifecycle", deps.instructions, deps),
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
