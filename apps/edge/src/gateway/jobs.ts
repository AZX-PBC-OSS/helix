import type { FastifyReply, FastifyRequest } from "fastify";
import { trace } from "@opentelemetry/api";
import {
  IDEMPOTENCY_KEY_HEADER,
  JOBS_MAX_INPUT_BYTES,
  type JobRequestError,
  jobRequestError,
  isValidJobsLocalType,
  isValidJobsRetryKey,
  qualifiedTypeMatchesServer,
} from "@azx-pbc/shared";
import type { JobOwnerKind } from "@azx-pbc/shared";
import {
  type JobsSubmissionOutcome,
  ATTR_APP_ID,
  ATTR_APP_SLUG,
  ATTR_JOBS_JOB_ID,
  ATTR_JOBS_OPERATION,
  ATTR_METHOD,
  ATTR_OUTCOME,
} from "@azx-pbc/shared/telemetry";
import type { RegistryReader } from "../registry/projection.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { type CallerResolver } from "../auth/gate.js";
import type { OriginCheck } from "../auth/validate.js";
import { instruments, spanRoute } from "../telemetry.js";
import { readBoundedBody } from "../jobs/boundedBody.js";
import type { JobsForwarder } from "../jobs/forwarder.js";

/**
 * The app-facing jobs submission route — `POST /_api/jobs/:server/types/:type`
 * on the production edge, the same route under the dev gateway's `/:slug`
 * prefix (background-jobs-plane design §1). ONE handler factory for both
 * serving surfaces: they differ only in the trusted resolution they are wired
 * with (the session-gated caller resolver vs the dev-token resolver, and the
 * exact-origin CSRF check vs the dev allowlist), never in policy.
 *
 * The gate order preserves every existing response on the way in — serving
 * surface (503/404/410), caller (302/401/403), origin (403) — and then the
 * jobs authorization check refuses everyone the platform does not attribute
 * jobs to: a resolved anonymous or shared-password caller, and a caller whose
 * app holds no current grant for the requested qualified type, answers 403
 * `forbidden`. Only then is a signed instruction minted over the exact
 * request bytes — trusted attribution and the current lifecycle generation
 * from the registry projection, never from the request — and forwarded to the
 * one configured server named by the route, the original bytes and the
 * optional retry key surviving intact.
 *
 * The response side validates before it forwards: a valid acceptance (naming
 * the requested server) or a valid jobs error response is forwarded as
 * received with `no-store`; anything else — no answer, an unusable body, a
 * reference for another server — answers the retryable 503
 * `jobs_unavailable` and never a fabricated 202 or 404. No fallback
 * destination, no automatic resubmit: a lost answer is uncertainty the client
 * resolves by keyed retry.
 *
 * The input is bounded here (64 KiB, byte-counted, framing-independent) so a
 * request the contract refuses is refused before any instruction exists. The
 * input's JSON validity is deliberately NOT checked at the edge: a keyed
 * replay of different bytes must reach the server's retained-key comparison
 * and be answered 409 even when invalid for new work, and
 * validation-before-acceptance is the jobs service's own gate — forwarding
 * unchanged bytes is this route's whole job.
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
}

/** Which serving surface the handler is wired into — span name and route constant. */
export interface JobsSubmitSurface {
  span: string;
  route: string;
}

function sendJobsError(reply: FastifyReply, status: number, error: JobRequestError): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(error);
}

export function makeJobsSubmitHandler(rt: JobsGatewayRuntime, surface: JobsSubmitSurface) {
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

    // Serving surface first — its 503/404/410 are the existing responses.
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) {
      setOutcome("unavailable");
      return;
    }
    trace.getActiveSpan()?.setAttributes({ [ATTR_APP_SLUG]: slug });

    // Caller gate — its 302/401/403 are the existing responses, untouched.
    const caller = await rt.resolveCaller(req, reply, entry);
    if (!caller) {
      setOutcome("unauthorized");
      return;
    }

    // CSRF: a submission is same-origin by construction (the dev gateway's
    // resolver has already matched the token's allowlist by the time its
    // always-true seam runs).
    if (!rt.checkOrigin(req, entry)) {
      setOutcome("forbidden");
      sendJobsError(reply, 403, jobRequestError("forbidden"));
      return;
    }

    // The jobs authorization check — the gate that owns eligibility for jobs.
    // Only an authenticated user or dev-token principal may operate on jobs;
    // an anonymous visitor or a shared-password pseudonym is refused here,
    // after the serving/caller gates kept their own responses. A kind the
    // session predates naming (null) fails closed with the same answer.
    if (!caller.authenticated || (caller.kind !== "user" && caller.kind !== "dev")) {
      setOutcome("forbidden");
      sendJobsError(reply, 403, jobRequestError("forbidden"));
      return;
    }
    const ownerKind: JobOwnerKind = caller.kind;
    const ownerOid = caller.oid;

    // The requested operation, from the route. A server id that is not a
    // server id cannot be configured (the same 400 an unknown one answers
    // with); a type that is not a type is one no grant can ever have covered.
    const params = req.params as { server?: string; type?: string };
    const server = params.server ?? "";
    if (!rt.forwarder) {
      setOutcome("disabled");
      sendJobsError(reply, 503, jobRequestError("jobs_disabled"));
      return;
    }
    if (!rt.forwarder.has(server)) {
      setOutcome("server_unknown");
      sendJobsError(reply, 400, jobRequestError("job_server_unknown"));
      return;
    }
    const localType = params.type ?? "";
    if (!isValidJobsLocalType(localType)) {
      setOutcome("forbidden");
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
      sendJobsError(reply, 400, jobRequestError("idempotency_key_invalid"));
      return;
    }
    const idempotencyKey = typeof rawKey === "string" ? rawKey : null;
    if (idempotencyKey !== null && !isValidJobsRetryKey(idempotencyKey)) {
      setOutcome("key_invalid");
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
      sendJobsError(reply, 413, jobRequestError("payload_too_large"));
      return;
    }
    const bounded = await readBoundedBody(req.raw, JOBS_MAX_INPUT_BYTES);
    if (bounded.failed) {
      // The body errored before it ended — unreadable, refused before any
      // comparison. The caller is usually already gone; the reply is a formality.
      setOutcome("payload_invalid");
      sendJobsError(reply, 400, jobRequestError("payload_invalid"));
      return;
    }
    if (bounded.over) {
      setOutcome("payload_too_large");
      sendJobsError(reply, 413, jobRequestError("payload_too_large"));
      return;
    }

    // Abort the forward if the caller goes away — the RESPONSE's close, not
    // the request stream's (the ended body stream auto-destroys; see fetch.ts
    // for the measured details of that trap).
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    // Mint and forward — one instruction, exact bytes, bounded wait. Trace
    // context rides the forward (inject-only); the jobs service mints its own
    // request id, so no correlation header of ours is read over there.
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
      signal: abort.signal,
    });

    switch (forward.kind) {
      case "accepted": {
        // The validated acceptance, forwarded as received: the caller's
        // reference is the server it asked for and the job id the server
        // chose. The accepted job id rides the span — the join between this
        // submission's trace and the snapshot the app polls next (the same
        // evidence the receiver's route spans carry).
        setOutcome("accepted");
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
        // the protocol's error schema and forwarded with its status.
        setOutcome("server_refused");
        sendJobsError(reply, forward.status, forward.error);
        return;
      }
      case "unreachable": {
        req.log.warn(
          { event: "edge.jobs_submit.unreachable", appId: entry.appId },
          "the jobs server did not answer a forwarded submission — acceptance is uncertain",
        );
        setOutcome("unreachable");
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
