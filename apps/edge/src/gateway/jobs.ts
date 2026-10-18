import type { FastifyReply, FastifyRequest } from "fastify";
import { trace } from "@opentelemetry/api";
import {
  IDEMPOTENCY_KEY_HEADER,
  JOBS_MAX_INPUT_BYTES,
  type JobRequestError,
  jobRequestError,
  isValidJobsJobId,
  isValidJobsLocalType,
  isValidJobsRetryKey,
  qualifiedTypeMatchesServer,
  type GatewayOutcome,
} from "@azx-pbc/shared";
import type { JobOwnerKind } from "@azx-pbc/shared";
import {
  type JobsReferenceOutcome,
  type JobsSubmissionOutcome,
  ATTR_APP_ID,
  ATTR_APP_SLUG,
  ATTR_JOBS_JOB_ID,
  ATTR_JOBS_OPERATION,
  ATTR_METHOD,
  ATTR_OUTCOME,
} from "@azx-pbc/shared/telemetry";
import type { RegistryEntry, RegistryReader } from "../registry/projection.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { meterIdentity, type Caller, type CallerResolver } from "../auth/gate.js";
import type { OriginCheck } from "../auth/validate.js";
import { instruments, spanRoute } from "../telemetry.js";
import { meterGatewayCall, type GatewayCallRecord, type UsageStore } from "./usage.js";
import type { DenialThrottle } from "./denialThrottle.js";
import type { JobsSubmissionThrottle } from "./jobsThrottle.js";
import { readBoundedBody } from "../jobs/boundedBody.js";
import type { JobsForwarder, JobsRecordSpec } from "../jobs/forwarder.js";

/**
 * The app-facing jobs routes (background-jobs-plane design §1): the
 * submission `POST /_api/jobs/:server/types/:type` and the three reference
 * operations on an existing job — poll `GET /_api/jobs/:server/:jobId`,
 * result `GET /_api/jobs/:server/:jobId/result`, cancel
 * `DELETE /_api/jobs/:server/:jobId`. ONE handler factory per operation for
 * BOTH serving surfaces (the production edge and the dev gateway's `/:slug`
 * prefix): they differ only in the trusted resolution they are wired with
 * (the session-gated caller resolver vs the dev-token resolver, and the
 * exact-origin CSRF check vs the dev allowlist), never in policy.
 *
 * The gate order preserves every existing response on the way in — serving
 * surface (503/404/410), caller (302/401/403), then for the state-changing
 * requests (submission, cancellation) the origin check — and then the jobs
 * authorization check refuses everyone the platform does not attribute jobs
 * to: a resolved anonymous or shared-password caller answers 403 `forbidden`.
 * Only then is a signed instruction minted — trusted attribution from the
 * caller resolver and the registry projection, never from the request — and
 * forwarded to the one configured server named by the reference.
 *
 * Every request forwards the caller's current server-scoped grants
 * (`allowedTypes`) for the server's own enforcement: the record's type and
 * ownership are things only the server that holds the record can compare, so
 * the edge decides nothing about them — a lapsed grant rides the instruction
 * and comes back as the receiver's own 403.
 *
 * The response side validates before it forwards: a schema-conformant success
 * naming the addressed reference (an acceptance, a complete snapshot, a raw
 * JSON result, a cancellation acknowledgement) or a valid jobs error response
 * is forwarded as received with `no-store`; anything else — no answer, an
 * unusable body, a reference for another server or job — answers the
 * retryable 503 `jobs_unavailable` and never a fabricated success or a false
 * 404. No fallback destination, no automatic resubmit: a lost answer is
 * uncertainty the client resolves by keyed retry (submission) or by polling
 * again (observation), and abandoning or failing a request never cancels or
 * resubmits work.
 *
 * The reference operations are bodyless: the instruction binds the empty
 * digest, and the addressed job id is syntax-checked before anything is
 * minted — an id outside the reference grammar names no job on any server,
 * and the resource binding must never see one.
 *
 * The submission input is bounded here (64 KiB, byte-counted,
 * framing-independent) so a request the contract refuses is refused before
 * any instruction exists. The input's JSON validity is deliberately NOT
 * checked at the edge: a keyed replay of different bytes must reach the
 * server's retained-key comparison and be answered 409 even when invalid for
 * new work, and validation-before-acceptance is the jobs service's own gate —
 * forwarding unchanged bytes is the submission route's whole job.
 *
 * The submission buckets and the request ledger (design §4, ADR-0003/0004)
 * are the submission route's own: every authenticated attempt that passes the
 * gates — replays, invalid input, refusals and uncertain endings included —
 * consumes the per-app/environment and deployment-wide fixed windows before
 * any later decision, with no refund, and both buckets span every configured
 * server (their keys carry no server or type, so another prefix adds no
 * allowance). An exhausted window answers 429 `rate_limited`. Each counted
 * attempt is one recorded request in the gateway ledger (capability `jobs`,
 * the qualified type in the model field, the existing outcome vocabulary) —
 * an attempt counter that must never be read as an accepted-job count, since
 * a 202 can be a replay and an uncertain ending may have accepted work. The
 * write is best-effort and never awaited: a ledger failure cannot change
 * acceptance, and the throttle refusals' rows are capped per (app, env) so a
 * flood cannot turn into unbounded persistent audit writes. The reference
 * operations are not charged to these buckets and are not ledger rows — they
 * keep their ordinary request controls and their own spans.
 */

export interface JobsGatewayRuntime {
  registry: RegistryReader;
  resolveCaller: CallerResolver;
  /** CSRF seam (dev-mode §5.4): edge = exact same-origin; dev-gateway = allowlist. */
  checkOrigin: OriginCheck;
  /**
   * The signed forwarding seam over the configured servers. null ⇒ no jobs
   * configuration on this process — every request answers 503 `jobs_disabled`
   * (fail-closed, like every other capability's unconfigured seam).
   */
  forwarder: JobsForwarder | null;
  /**
   * The submission throttle buckets (design §4): every authenticated attempt
   * that passes the gates consumes the per-app/environment and the
   * deployment-wide windows — both spanning every configured server — before
   * any later decision, and an exhausted window answers 429 `rate_limited`.
   * Built by the composition (app.ts) from the shared counter primitive; a
   * composition that wires jobs always wires this.
   */
  submissionThrottle: JobsSubmissionThrottle;
  /**
   * Caps the throttle-refusal ledger rows per (app, env) — the one write on
   * this route no other gate bounds, since a refused attempt consumes no
   * window the caller could run out of. null ⇒ uncapped (tests).
   */
  denialThrottle: DenialThrottle | null;
  /**
   * The gateway request ledger (ADR-0004): each counted submission attempt is
   * one recorded request row, best-effort and never awaited — a ledger write
   * failure cannot change acceptance or delay a reply. null ⇒ not recorded.
   */
  usage: UsageStore | null;
}

/** Which serving surface a handler is wired into — span name and route constant. */
export interface JobsSurface {
  span: string;
  route: string;
}

/** The reference operations a stored `{server, jobId}` routes: poll, result, cancel. */
export type JobsRecordOperation = "snapshot" | "result" | "cancel";

function sendJobsError(reply: FastifyReply, status: number, error: JobRequestError): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(error);
}

/** The gate words both route vocabularies share — a gate's answer, not an operation's. */
type JobsGateOutcome = "unavailable" | "unauthorized" | "forbidden";

/**
 * The gate sequence every jobs request passes before an operation exists —
 * the serving surface, the caller, the origin check (state-changing requests
 * only: the polls are reads, in the data reads' posture — a cross-origin read
 * cannot be read back without CORS, and the edge reflects none), and the jobs
 * authorization check. Returns the resolved entry and the narrowed jobs
 * owner, or null after having already answered with the gate's own preserved
 * response.
 */
async function passJobsGates(
  rt: JobsGatewayRuntime,
  req: FastifyRequest,
  reply: FastifyReply,
  slug: string,
  setOutcome: (outcome: JobsGateOutcome) => void,
  mutation: boolean,
): Promise<{
  entry: RegistryEntry;
  caller: Caller;
  ownerKind: JobOwnerKind;
  ownerOid: string;
} | null> {
  // Serving surface first — its 503/404/410 are the existing responses.
  const entry = resolveServingEntry(rt.registry, slug, reply);
  if (!entry) {
    setOutcome("unavailable");
    return null;
  }
  trace.getActiveSpan()?.setAttributes({ [ATTR_APP_SLUG]: slug });

  // Caller gate — its 302/401/403 are the existing responses, untouched.
  const caller = await rt.resolveCaller(req, reply, entry);
  if (!caller) {
    setOutcome("unauthorized");
    return null;
  }

  // CSRF for the state-changing requests — same-origin by construction (the
  // dev gateway's resolver has already matched the token's allowlist by the
  // time its always-true seam runs).
  if (mutation && !rt.checkOrigin(req, entry)) {
    setOutcome("forbidden");
    sendJobsError(reply, 403, jobRequestError("forbidden"));
    return null;
  }

  // The jobs authorization check — the gate that owns eligibility for jobs.
  // Only an authenticated user or dev-token principal may operate on jobs;
  // an anonymous visitor or a shared-password pseudonym is refused here,
  // after the serving/caller gates kept their own responses. A kind the
  // session predates naming (null) fails closed with the same answer.
  if (!caller.authenticated || (caller.kind !== "user" && caller.kind !== "dev")) {
    setOutcome("forbidden");
    sendJobsError(reply, 403, jobRequestError("forbidden"));
    return null;
  }
  return { entry, caller, ownerKind: caller.kind, ownerOid: caller.oid };
}

/**
 * Abort the forward if the caller goes away — the RESPONSE's close, not the
 * request stream's (the ended body stream auto-destroys; see fetch.ts for the
 * measured details of that trap). A poll abandoned mid-flight aborts its
 * forward too — an observation failure, never a cancellation and never a
 * resubmission.
 */
function abortOnClientGone(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  return abort.signal;
}

/**
 * Map a forwarded submission refusal's HTTP status onto the ledger outcome —
 * the existing `GatewayOutcome` vocabulary restated at the jobs consumer
 * (ADR-0004: no new outcomes). The 409 has its own label (`conflict`); the
 * principal refusals are `forbidden`; the quota-shaped refusals (the
 * receiver's capacity/rate answers, like the edge's own throttle below) are
 * `quota_blocked`; a 5xx is an `error` — an uncertain ending, never proof the
 * job was not accepted; every other 4xx is a policy `refusal`.
 */
function submissionLedgerOutcome(status: number): GatewayOutcome {
  if (status === 409) return "conflict";
  if (status === 403) return "forbidden";
  if (status === 429) return "quota_blocked";
  if (status >= 500) return "error";
  return "refusal";
}

export function makeJobsSubmitHandler(rt: JobsGatewayRuntime, surface: JobsSurface) {
  async function handleJobsSubmit(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const setOutcome = (outcome: JobsSubmissionOutcome): void => {
      const attr = { [ATTR_OUTCOME]: outcome };
      trace.getActiveSpan()?.setAttributes(attr);
      instruments().jobsSubmissions.add(1, attr);
    };

    const gated = await passJobsGates(rt, req, reply, slug, setOutcome, true);
    if (!gated) return;
    const { entry, caller, ownerKind, ownerOid } = gated;
    const identity = meterIdentity(caller);

    // The requested operation, from the route. A server id that is not a
    // server id cannot be configured (the same 400 an unknown one answers
    // with); a type that is not a type is one no grant can ever have covered.
    // The raw `server:type` pair is what the ledger's model field records for
    // every counted attempt — the caller's own request, bounded by the
    // ledger's column cap, valid or not.
    const params = req.params as { server?: string; type?: string };
    const server = params.server ?? "";
    const requestedType = `${server}:${params.type ?? ""}`;
    if (!rt.forwarder) {
      setOutcome("disabled");
      sendJobsError(reply, 503, jobRequestError("jobs_disabled"));
      return;
    }

    // The ledger row for one counted attempt (ADR-0004): capability `jobs`,
    // the requested qualified type in the model field, the existing outcome
    // vocabulary, and a bounded catalogue word — never input, a retry key, a
    // URL or exception text — in `errorDetail`. Measured round-trip time is
    // carried only where a round trip happened.
    const gatewayCall = (
      outcome: GatewayOutcome,
      statusCode: number,
      errorDetail: string | null,
      durationMs?: number,
    ): GatewayCallRecord => ({
      appId: entry.appId,
      env: caller.env,
      ...identity,
      capability: "jobs",
      model: requestedType,
      inputTokens: 0,
      outputTokens: 0,
      outcome,
      ...(durationMs !== undefined ? { durationMs } : {}),
      statusCode,
      errorDetail,
    });
    const recordRow = (row: GatewayCallRecord): void => {
      if (!rt.usage) return;
      void rt.usage.record(row).catch((err: unknown) =>
        req.log.warn(
          {
            err,
            event: "gateway.usage_record_failed",
            appId: entry.appId,
            capability: "jobs",
            outcome: row.outcome,
          },
          "gateway usage record failed",
        ),
      );
    };
    const record = (
      outcome: GatewayOutcome,
      statusCode: number,
      errorDetail: string | null,
      durationMs?: number,
    ): void => {
      // Beside the ledger write, never inside it: a dropped row must not
      // blind the operational counter (ADR-0037 decision 9's shape).
      meterGatewayCall({
        appId: entry.appId,
        capability: "jobs",
        outcome,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      recordRow(gatewayCall(outcome, statusCode, errorDetail, durationMs));
    };

    // The submission buckets (design §4): every authenticated attempt that
    // reaches here is charged — before the server resolution, the key and
    // body checks, and the forward — and the charge stands whatever the
    // outcome. An exhausted window refuses here, before any instruction
    // exists; there is no refund and no midnight settlement.
    if (!(await rt.submissionThrottle.consume(entry.appId, caller.env))) {
      setOutcome("rate_limited");
      // The refused attempt's ledger row is the one write on this route no
      // bucket bounds — a flood consumes no window it could run out of — so
      // it is metered per (app, env) like the fetch allowlist denial: the
      // first N rows per window carry the audit signal, the rest are dropped
      // with a magnitude summary on the log. The metric is NOT gated on the
      // throttle's decision; only the row is.
      const decision = rt.denialThrottle
        ? await rt.denialThrottle.admit(entry.appId, caller.env)
        : { meter: true as const, suppressedAt: undefined };
      if (decision.suppressedAt !== undefined) {
        req.log.warn(
          {
            event: "edge.jobs_submit.refusal_ledger_suppressed",
            appId: entry.appId,
            env: caller.env,
            attempts: decision.suppressedAt,
          },
          "jobs throttle-refusal metering suppressed — this app is over its denial budget for the window",
        );
      }
      meterGatewayCall({ appId: entry.appId, capability: "jobs", outcome: "quota_blocked" });
      if (decision.meter) {
        recordRow(gatewayCall("quota_blocked", 429, "rate_limited"));
      }
      sendJobsError(reply, 429, jobRequestError("rate_limited"));
      return;
    }

    if (!rt.forwarder.has(server)) {
      setOutcome("server_unknown");
      record("refusal", 400, "job_server_unknown");
      sendJobsError(reply, 400, jobRequestError("job_server_unknown"));
      return;
    }
    const localType = params.type ?? "";
    if (!isValidJobsLocalType(localType)) {
      setOutcome("forbidden");
      record("forbidden", 403, "forbidden");
      sendJobsError(reply, 403, jobRequestError("forbidden"));
      return;
    }
    const qualifiedType = `${server}:${localType}`;

    // The current grant for the qualified type — the edge's own type
    // permission (ADR-0003): a revoked grant denies new submissions before any
    // instruction exists. The instruction binds exactly this server's types.
    const allowedTypes = (entry.jobs?.types ?? []).filter((t) =>
      qualifiedTypeMatchesServer(t, server),
    );
    if (!allowedTypes.includes(qualifiedType)) {
      setOutcome("forbidden");
      record("forbidden", 403, "forbidden");
      sendJobsError(reply, 403, jobRequestError("forbidden"));
      return;
    }
    trace.getActiveSpan()?.setAttributes({ [ATTR_APP_ID]: entry.appId });

    // The optional retry key: read once, validated against the shared rule,
    // signed into the claim, and forwarded as the same header — the signed
    // claim and the presented header must agree at the receiver, so there is
    // no unsigned override path. A header that is present but not a valid key
    // (empty, whitespace-only, over the byte cap) is REFUSED, never treated as
    // absent: dropping it silently would submit keyless work a client believes
    // it keyed. (Node joins a repeated header line into one string, so that
    // string IS the key; the array form is a presentation no receiver verifies
    // — refused, never guessed at.)
    const rawKey = req.headers[IDEMPOTENCY_KEY_HEADER];
    if (Array.isArray(rawKey)) {
      setOutcome("key_invalid");
      record("refusal", 400, "idempotency_key_invalid");
      sendJobsError(reply, 400, jobRequestError("idempotency_key_invalid"));
      return;
    }
    const idempotencyKey = typeof rawKey === "string" ? rawKey : null;
    if (idempotencyKey !== null && !isValidJobsRetryKey(idempotencyKey)) {
      setOutcome("key_invalid");
      record("refusal", 400, "idempotency_key_invalid");
      sendJobsError(reply, 400, jobRequestError("idempotency_key_invalid"));
      return;
    }

    // The exact input bytes, capped: a body the contract refuses never
    // becomes an instruction. The content-length fast-path refuses a truthful
    // oversized upload without draining it; the byte counter is the real,
    // framing-independent bound.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > JOBS_MAX_INPUT_BYTES) {
      setOutcome("payload_too_large");
      record("refusal", 413, "payload_too_large");
      sendJobsError(reply, 413, jobRequestError("payload_too_large"));
      return;
    }
    const bounded = await readBoundedBody(req.raw, JOBS_MAX_INPUT_BYTES);
    if (bounded.failed) {
      // The body errored before it ended — unreadable, refused before any
      // comparison. The caller is usually already gone; the reply is a formality.
      setOutcome("payload_invalid");
      record("refusal", 400, "payload_invalid");
      sendJobsError(reply, 400, jobRequestError("payload_invalid"));
      return;
    }
    if (bounded.over) {
      setOutcome("payload_too_large");
      record("refusal", 413, "payload_too_large");
      sendJobsError(reply, 413, jobRequestError("payload_too_large"));
      return;
    }

    // Mint and forward — one instruction, exact bytes, bounded wait. Trace
    // context rides the forward (inject-only); the jobs service mints its own
    // request id, so no correlation header of ours is read over there.
    const startedAt = performance.now();
    const forward = await rt.forwarder.submit({
      server,
      identity: {
        appId: entry.appId,
        env: caller.env,
        ownerKind,
        ownerOid,
        allowedTypes,
      },
      type: qualifiedType,
      generation: entry.jobsGeneration,
      idempotencyKey,
      body: bounded.bytes,
      signal: abortOnClientGone(reply),
    });
    const forwardMs = Math.round(performance.now() - startedAt);

    switch (forward.kind) {
      case "accepted": {
        // The validated acceptance, forwarded as received: the caller's
        // reference is the server it asked for and the job id the server
        // chose. The accepted job id rides the span — the join between this
        // submission's trace and the snapshot the app polls next (the same
        // evidence the receiver's route spans carry). The ledger row is the
        // recorded REQUEST — a keyed replay records the same `ok`, never a
        // unique-job claim.
        setOutcome("accepted");
        record("ok", forward.status, null, forwardMs);
        trace.getActiveSpan()?.setAttributes({ [ATTR_JOBS_JOB_ID]: forward.accepted.jobId });
        reply
          .status(forward.status)
          .header("cache-control", "no-store")
          .type("application/json; charset=utf-8")
          .send(Buffer.from(forward.rawBody));
        return;
      }
      case "refused": {
        // The server's own fixed, sanitized error response — validated against
        // the protocol's error schema and forwarded with its status. The
        // catalogue code rides the ledger row's bounded `errorDetail`.
        setOutcome("server_refused");
        record(
          submissionLedgerOutcome(forward.status),
          forward.status,
          forward.error.code,
          forwardMs,
        );
        sendJobsError(reply, forward.status, forward.error);
        return;
      }
      case "unreachable": {
        req.log.warn(
          { event: "edge.jobs_submit.unreachable", appId: entry.appId },
          "the jobs server did not answer a forwarded submission — acceptance is uncertain",
        );
        setOutcome("unreachable");
        // An uncertain ending records as a request failure, never as proof
        // the work was or was not accepted.
        record("error", 503, "unreachable", forwardMs);
        sendJobsError(reply, 503, jobRequestError("jobs_unavailable"));
        return;
      }
      case "invalid_response": {
        req.log.warn(
          {
            event: "edge.jobs_submit.invalid_response",
            appId: entry.appId,
            status: forward.status,
          },
          "the jobs server answered an unusable submission response — acceptance is uncertain",
        );
        setOutcome("invalid_response");
        record("error", 503, "invalid_response", forwardMs);
        sendJobsError(reply, 503, jobRequestError("jobs_unavailable"));
        return;
      }
    }
  }

  // The shared route wrapper: a fresh ROOT span (an inbound `traceparent`
  // never chooses its parentage), graded from the response, ended when the
  // handler settles — arity preserved for the app-host `slug`.
  return spanRoute(
    surface.span,
    (req) => ({
      [ATTR_METHOD]: req.method,
      [ATTR_JOBS_OPERATION]: "submit",
      "http.route": surface.route,
    }),
    handleJobsSubmit,
  );
}

/**
 * The uncertain forward endings' log events, one name per operation —
 * `edge.jobs_<operation>.unreachable` / `.invalid_response`, the same bounded
 * pair the submission route emits. The caller-facing answer is the identical
 * retryable 503 for both; these events and the span's outcome word are where
 * they stay distinguishable for the operator.
 */
const UNCERTAIN_EVENT = {
  unreachable: (operation: JobsRecordOperation): string => `edge.jobs_${operation}.unreachable`,
  invalidResponse: (operation: JobsRecordOperation): string =>
    `edge.jobs_${operation}.invalid_response`,
};

export function makeJobsRecordHandler(
  rt: JobsGatewayRuntime,
  surface: JobsSurface,
  operation: JobsRecordOperation,
) {
  async function handleJobsRecord(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const setOutcome = (outcome: JobsReferenceOutcome): void => {
      trace.getActiveSpan()?.setAttributes({ [ATTR_OUTCOME]: outcome });
    };

    // The cancel is the one reference operation that changes state, so it is
    // the one that runs the CSRF seam; the polls are reads.
    const gated = await passJobsGates(rt, req, reply, slug, setOutcome, operation === "cancel");
    if (!gated) return;
    const { entry, caller, ownerKind, ownerOid } = gated;

    // The reference, from the route. An unconfigured server and a job id that
    // is not a job id both read the same 404 `job_not_found` an unknown job
    // answers with — a reference operation never searches another namespace,
    // and there is no 400 here (that is the submission's answer for a server
    // the caller was choosing; a reference's server was already chosen and
    // stored). The syntax check runs before anything is minted: the signed
    // resource binding cannot carry an id the grammar refuses.
    const params = req.params as { server?: string; jobId?: string };
    const server = params.server ?? "";
    if (!rt.forwarder) {
      setOutcome("disabled");
      sendJobsError(reply, 503, jobRequestError("jobs_disabled"));
      return;
    }
    if (!rt.forwarder.has(server)) {
      setOutcome("server_unknown");
      sendJobsError(reply, 404, jobRequestError("job_not_found"));
      return;
    }
    const jobId = params.jobId ?? "";
    if (!isValidJobsJobId(jobId)) {
      setOutcome("reference_invalid");
      sendJobsError(reply, 404, jobRequestError("job_not_found"));
      return;
    }

    // The trusted attribution and the CURRENT grants, bound into the
    // instruction for the server's own enforcement: ownership (app,
    // environment, principal kind, owner) is compared against the record
    // there, and the record's type against these grants — a lapsed grant
    // denies the read as the receiver's own 403, never a local guess. The
    // addressed app and the validated reference ride the span from here —
    // the join a poll's trace offers the operator.
    const allowedTypes = (entry.jobs?.types ?? []).filter((t) =>
      qualifiedTypeMatchesServer(t, server),
    );
    trace.getActiveSpan()?.setAttributes({ [ATTR_APP_ID]: entry.appId, [ATTR_JOBS_JOB_ID]: jobId });

    const spec: JobsRecordSpec = {
      server,
      identity: {
        appId: entry.appId,
        env: caller.env,
        ownerKind,
        ownerOid,
        allowedTypes,
      },
      jobId,
      signal: abortOnClientGone(reply),
    };
    const forward =
      operation === "snapshot"
        ? await rt.forwarder.snapshot(spec)
        : operation === "result"
          ? await rt.forwarder.result(spec)
          : await rt.forwarder.cancel(spec);

    switch (forward.kind) {
      case "found":
      case "accepted": {
        // The validated success — a complete snapshot, a raw JSON result
        // (JSON `null` included), or a cancellation acknowledgement, each
        // naming the addressed reference — forwarded as received, no-store.
        setOutcome("found");
        reply
          .status(forward.status)
          .header("cache-control", "no-store")
          .type("application/json; charset=utf-8")
          .send(Buffer.from(forward.rawBody));
        return;
      }
      case "refused": {
        // The server's own fixed, sanitized error response — the unknown-job
        // 404, the lapsed-grant 403, the stateful 409s, the 410 — validated
        // against the protocol's error schema and forwarded with its status.
        setOutcome("server_refused");
        sendJobsError(reply, forward.status, forward.error);
        return;
      }
      case "unreachable": {
        req.log.warn(
          { event: UNCERTAIN_EVENT.unreachable(operation), appId: entry.appId },
          "the jobs server did not answer a forwarded job read — the last known state stays stale",
        );
        setOutcome("unreachable");
        sendJobsError(reply, 503, jobRequestError("jobs_unavailable"));
        return;
      }
      case "invalid_response": {
        req.log.warn(
          {
            event: UNCERTAIN_EVENT.invalidResponse(operation),
            appId: entry.appId,
            status: forward.status,
          },
          "the jobs server answered an unusable job-read response — the last known state stays stale",
        );
        setOutcome("invalid_response");
        sendJobsError(reply, 503, jobRequestError("jobs_unavailable"));
        return;
      }
    }
  }

  // The shared route wrapper: a fresh ROOT span, graded from the response,
  // ended when the handler settles — arity preserved for the app-host `slug`.
  return spanRoute(
    surface.span,
    (req) => ({
      [ATTR_METHOD]: req.method,
      [ATTR_JOBS_OPERATION]: operation,
      "http.route": surface.route,
    }),
    handleJobsRecord,
  );
}
