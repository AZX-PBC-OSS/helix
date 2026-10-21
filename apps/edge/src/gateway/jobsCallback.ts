import type { FastifyReply, FastifyRequest } from "fastify";
import { trace } from "@opentelemetry/api";
import { discardBody } from "@azx-pbc/shared/bodyCap";
import {
  FetchJobInputSchema,
  INSTRUCTION_HEADER,
  JOBS_MAX_INPUT_BYTES,
  jobRequestError,
  type JobRequestError,
} from "@azx-pbc/shared";
import {
  JobsOperations,
  verifyJobsInstruction,
  type JobsFetchCallbackClaims,
  type JobsInstructionRejectReason,
  type JobsInstructionVerifyResult,
} from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_APP_ID,
  ATTR_JOBS_GENERATION,
  ATTR_JOBS_JOB_ID,
  ATTR_JOBS_OPERATION,
  ATTR_JOBS_TYPE,
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_REASON,
  ROUTE_JOBS_FETCH,
  type JobsFetchCallbackOutcome,
} from "@azx-pbc/shared/telemetry";
import type { RegistryReader } from "../registry/projection.js";
import type { MeterIdentity } from "../auth/gate.js";
import type { JobsCallbackBurnStore } from "../jobs/burns.js";
import { readBoundedBody } from "../jobs/boundedBody.js";
import type { DenialThrottle } from "./denialThrottle.js";
import type { EgressProvider } from "./egressProvider.js";
import { abortOnClientGone } from "./clientGone.js";
import { runFetchPolicy, type FetchDenial } from "./fetchPolicy.js";
import type { UsageStore } from "./usage.js";
import { instruments, spanRoute } from "../telemetry.js";

/**
 * The signed jobs→edge fetch-callback receiver (background-jobs-plane design
 * §2, ADR-0002/0006): the route an executing job calls to make its one
 * governed outbound GET. This surface owns what is specific to an unattended,
 * signed caller — instruction verification against the configured servers'
 * jobs→edge keys, the durable nonce burn, the environment-tier refusal, and
 * the response vocabulary jobs classifies — and then dispatches through the
 * ONE fetch-policy core the browser route uses (`fetchPolicy.ts`), so origin
 * permission, credential binding, budget and ledger semantics can never drift
 * between the two callers.
 *
 * The gate order is the contract:
 *
 * 1. **Verification** — the token must verify against SOME configured server's
 *    jobs→edge key with the fetch operation's exact method/resource/body
 *    binding (each candidate verify pins `server` to that key's own server, so
 *    a token minted by one server verifies only against that server's root —
 *    the signature, never an unverified claim, selects the key). Nothing about
 *    the request is trusted before this: no URL, no header, no body meaning.
 * 2. **Tier** — a verified instruction for the opposite environment tier is
 *    refused WITHOUT consuming its nonce: the production edge and the dev
 *    gateway are separate nonce spaces and separate registries, and a
 *    misrouted token must stay usable at its own tier's receiver.
 * 3. **Burn** — the `jti` is consumed before any side effect, so a replay is
 *    refused across replicas and restarts (the store's RLS-partitioned table).
 * 4. **Dispatch** — the current registry entry resolved by the SIGNED app id;
 *    unknown and archived apps refuse; the `{url}` body parse is the first
 *    thing that reads the verified bytes for meaning; then
 *    `runFetchPolicy` fences the signed lifecycle generation against the
 *    registry's current generation, checks the origin allowlist and the
 *    delegated prohibition, charges the budget, and mints the ordinary egress
 *    instruction. The outbound method is always GET — the callback's own POST
 *    merely transports the signed request.
 *
 * The responses are exactly the protocol's: an upstream 2xx streams its bytes
 * to jobs (which owns JSON validation and the 64-KiB result bound and aborts
 * the stream past it); every refusal and failure answers a bounded
 * `JobRequestError` before any body — never the upstream's own body, status
 * text, or any secret or user token. Jobs' cancellation and its outbound
 * timeout hang up this request, and the client-gone abort takes the egress
 * forward down with it.
 */

/** Everything the receiver needs, composed once per process (see `app.ts`). */
export interface JobsCallbackRuntime {
  /** The environment tier this process serves — the burn store's own pin. */
  env: "prod" | "dev";
  registry: RegistryReader;
  /** Each configured server's jobs→edge verification key, by validated server id. */
  verificationKeys: ReadonlyMap<string, Uint8Array>;
  burns: JobsCallbackBurnStore;
  egress: EgressProvider;
  usage: UsageStore;
  instructionKey: Buffer;
  /** Caps metered policy denials per (app, env); null ⇒ uncapped (tests). */
  denialThrottle: DenialThrottle | null;
  /** The edge's own request-body cap for the policy's request path. */
  maxBodyBytes: number;
}

/** The unattended authority's metered identity, from the verified claims. */
function callbackIdentity(claims: { ownerOid: string; ownerKind: "user" | "dev" }): MeterIdentity {
  // The triggering principal is ATTRIBUTION only — the display halves do not
  // exist on a signed claim (no session was resolved), and the kind rides the
  // ledger rows the way the submission's own identity did.
  return {
    userOid: claims.ownerOid,
    userName: null,
    userEmail: null,
    userKind: claims.ownerKind,
  };
}

function sendCallbackError(reply: FastifyReply, status: number, error: JobRequestError): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(error);
}

/**
 * Render the core's denial in the callback's `JobRequestError` vocabulary —
 * the distinct terminal reasons spec criterion 30–32 gives the job:
 * `outbound_forbidden` for the policy refusals, `delegated_unattended` for the
 * delegated prohibition, `outbound_quota_exceeded` for the budget.
 */
function renderDenial(reply: FastifyReply, denial: FetchDenial): JobsFetchCallbackOutcome {
  switch (denial.reason) {
    case "generation_stale":
    case "origin_not_granted":
      sendCallbackError(reply, 403, jobRequestError("outbound_forbidden"));
      return "forbidden";
    case "delegated_unattended":
      sendCallbackError(reply, 403, jobRequestError("delegated_unattended"));
      return "delegated_unattended";
    case "budget_exhausted":
      sendCallbackError(reply, 429, jobRequestError("outbound_quota_exceeded"));
      return "quota_blocked";
    case "request_too_large":
      // Unreachable for this adapter — the outbound method is always GET, and
      // a bodyless method skips the request cap. Rendered rather than fallen
      // through: the caller sees the refusal, never a silently-forwarded call.
      sendCallbackError(reply, 413, jobRequestError("payload_too_large"));
      return "payload_too_large";
    default: {
      // A denial variant without a case above must not reach jobs as a silent
      // empty reply where the core refused the call: the compile error names
      // the arm to render, and the runtime answer below fails closed for
      // anything that slips past the types.
      denial.reason satisfies never;
      sendCallbackError(reply, 403, jobRequestError("outbound_forbidden"));
      return "forbidden";
    }
  }
}

export function makeJobsFetchCallbackHandler(
  rt: JobsCallbackRuntime | null,
  surface: { span: string },
) {
  async function handleJobsFetch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const setOutcome = (outcome: JobsFetchCallbackOutcome, reason?: string): void => {
      const attrs: Record<string, string> = { [ATTR_OUTCOME]: outcome };
      if (reason !== undefined) attrs[ATTR_REASON] = reason;
      trace.getActiveSpan()?.setAttributes(attrs);
      instruments().jobsCallbacks.add(1, { [ATTR_OUTCOME]: outcome });
    };

    // Unwired is a designed answer, not an absence: no configured servers (or
    // no fetch machinery/ledger/burn store) refuses fail-closed, and the
    // verification the route always requires never ran.
    if (!rt) {
      setOutcome("disabled");
      sendCallbackError(reply, 503, jobRequestError("jobs_disabled"));
      return;
    }

    // A presentation no signed claim can name is refused before it consumes
    // anything: the instruction binds the bare resource path, so a request
    // carrying a query or fragment is not a presentation of it (the same
    // refusal the jobs receiver makes; the operation matrix has no query
    // strings).
    const presentedUrl = req.raw.url ?? "/";
    if (presentedUrl.includes("?") || presentedUrl.includes("#")) {
      setOutcome("rejected", "resource");
      sendCallbackError(reply, 401, jobRequestError("unauthorized"));
      return;
    }

    // The exact body bytes, bounded: the instruction binds their digest, so
    // nothing may parse or normalize them first — and a body the contract
    // refuses is never read past the trip, forwarded, or held.
    const bounded = await readBoundedBody(req.raw, JOBS_MAX_INPUT_BYTES);
    if (bounded.over) {
      setOutcome("payload_too_large");
      sendCallbackError(reply, 413, jobRequestError("payload_too_large"));
      return;
    }
    if (bounded.failed) {
      setOutcome("payload_invalid");
      sendCallbackError(reply, 400, jobRequestError("payload_invalid"));
      return;
    }

    // Instruction verification. The header must be one string (a repeated
    // line is an unusable presentation, never a token); the token must verify
    // against a CONFIGURED server's jobs→edge key with the fetch operation's
    // own method/resource/body — each attempt pins the expectation to that
    // key's server, so the signature is what selects the key and an unverified
    // claim can never supply a URL, key or authority. A wrong-server token
    // fails every attempt and answers the same refusal.
    const header = req.headers[INSTRUCTION_HEADER];
    if (header === undefined || (typeof header === "string" && header.length === 0)) {
      setOutcome("rejected", "missing");
      sendCallbackError(reply, 401, jobRequestError("unauthorized"));
      return;
    }
    if (typeof header !== "string") {
      setOutcome("rejected", "malformed");
      sendCallbackError(reply, 401, jobRequestError("unauthorized"));
      return;
    }
    // Whole verification seconds — the same clock discipline the token's own
    // timestamps carry; `mintJobsInstruction` refuses a non-finite reading on
    // the minting side, and the verifier refuses one here.
    const nowS = Math.floor(Date.now() / 1_000);
    let verdict: Extract<JobsInstructionVerifyResult, { ok: true }> | null = null;
    let rejectReason: JobsInstructionRejectReason | null = null;
    for (const [server, key] of rt.verificationKeys) {
      const attempt = await verifyJobsInstruction(
        header,
        key,
        {
          server,
          operation: "fetch",
          method: JobsOperations.fetch.method,
          resource: JobsOperations.fetch.path,
          body: bounded.bytes,
        },
        nowS,
      );
      if (attempt.ok) {
        verdict = attempt;
        break;
      }
      rejectReason = attempt.reason;
    }
    if (!verdict) {
      setOutcome("rejected", rejectReason ?? "signature");
      req.log.warn(
        { event: "edge.jobs_callback.rejected", reason: rejectReason ?? "signature" },
        "the callback instruction failed verification — denied",
      );
      sendCallbackError(reply, 401, jobRequestError("unauthorized"));
      return;
    }
    // The claims are narrowed at the seam, not cast: the receiver verified
    // them with the fetch operation's own claim schema, and this guard is
    // what holds that pairing — a verify whose schema map drifted fails this
    // route loudly instead of serving misparsed claims.
    if (verdict.claims.operation !== "fetch") {
      throw new Error("the fetch-callback route served claims that are not fetch claims");
    }
    const claims: JobsFetchCallbackClaims = verdict.claims;

    // The verified identity, before anything acts on it — the app, the job and
    // the generation the rest of the handler fences with.
    trace.getActiveSpan()?.setAttributes({
      [ATTR_APP_ID]: claims.appId,
      [ATTR_JOBS_JOB_ID]: claims.jobId,
      [ATTR_JOBS_GENERATION]: claims.generation,
      [ATTR_JOBS_TYPE]: claims.type,
    });

    // Tier refusal, BEFORE the burn: the two receivers are separate nonce
    // spaces, so a token presented at the wrong tier must stay consumable at
    // its own. (The burn store's RLS pin is the durable backstop — this check
    // is what keeps a misrouted token from being spent.)
    if (claims.env !== rt.env) {
      setOutcome("wrong_tier");
      sendCallbackError(reply, 403, jobRequestError("forbidden"));
      return;
    }

    // The nonce burn — replay protection before any effect, exactly the jobs
    // receiver's discipline: a store that cannot answer denies without a
    // verdict, because an unburned token that ran is the one thing a replay
    // could double.
    const burn = await rt.burns.burn(verdict.jti);
    if (burn.verdict === "replay") {
      setOutcome("replayed");
      req.log.warn(
        { event: "edge.jobs_callback.replayed" },
        "a verified callback instruction's nonce was already spent — denied as a replay",
      );
      sendCallbackError(reply, 401, jobRequestError("unauthorized"));
      return;
    }
    if (burn.verdict === "store-unavailable") {
      setOutcome("unavailable");
      req.log.warn(
        { event: "edge.jobs_callback.burn_failed", err: burn.error },
        "the callback burn store could not record the nonce — denying without a verdict",
      );
      sendCallbackError(reply, 503, jobRequestError("jobs_unavailable"));
      return;
    }

    // The CURRENT serving entry, resolved by the signed app id at call time —
    // never an enqueue-time copy, and never the request's host. An app the
    // edge does not serve, or an archived one, refuses before the dispatch.
    const entry = rt.registry.getAppById(claims.appId);
    if (!entry || entry.archived) {
      setOutcome("forbidden", entry?.archived === true ? "app_archived" : "app_unknown");
      sendCallbackError(reply, 403, jobRequestError("outbound_forbidden"));
      return;
    }

    // The verified body's meaning: the fetch input contract — one target URL.
    // The digest bound the bytes; this parse reads them, and a verified
    // instruction carrying anything else is refused, never guessed at.
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(bounded.bytes));
    } catch {
      input = null;
    }
    const parsedInput = FetchJobInputSchema.safeParse(input);
    if (!parsedInput.success) {
      setOutcome("payload_invalid");
      sendCallbackError(reply, 400, jobRequestError("payload_invalid"));
      return;
    }
    const target = new URL(parsedInput.data.url);

    // The dispatch — the shared policy core with the unattended authority.
    // A dependency failure (the budget read, the mint) propagates here as a
    // throw: nothing was dialled, so the retryable 503 is the honest answer.
    let result;
    try {
      result = await runFetchPolicy(
        {
          egress: rt.egress,
          usage: rt.usage,
          instructionKey: rt.instructionKey,
          denialThrottle: rt.denialThrottle,
          maxBodyBytes: rt.maxBodyBytes,
        },
        {
          entry,
          env: rt.env,
          authority: {
            kind: "unattended",
            identity: callbackIdentity(claims),
            generation: claims.generation,
          },
          target,
          // The callback's outbound call is always GET — the POST that carried
          // the signed instruction transports it, never names the method.
          method: "GET",
          // No caller-selected headers exist to forward: the job's contract
          // accepts none, so the upstream GET is exactly the policy's own.
          headers: {},
          body: null,
          declaredRequestBytes: null,
          // Jobs' cancellation and its outbound timeout hang up this request;
          // the response's premature close is what aborts the egress forward.
          signal: abortOnClientGone(reply),
          correlationId: String(req.id),
          log: req.log,
        },
      );
    } catch (error) {
      req.log.error(
        { event: "edge.jobs_callback.unavailable", appId: claims.appId, err: error },
        "the fetch policy could not decide a verified callback — nothing was dialled",
      );
      setOutcome("unavailable");
      sendCallbackError(reply, 503, jobRequestError("jobs_unavailable"));
      return;
    }

    if (result.kind === "denied") {
      setOutcome(renderDenial(reply, result.denial), result.denial.reason);
      return;
    }
    if (result.kind === "failed") {
      req.log.warn(
        { event: "edge.jobs_callback.forward_failed", appId: claims.appId },
        "the egress forward of a verified callback failed — the job's answer is the bounded refusal",
      );
      setOutcome("upstream_failed");
      sendCallbackError(reply, 502, jobRequestError("upstream_error"));
      return;
    }

    const res = result.response;
    if (res.status < 200 || res.status > 299) {
      // The upstream answered non-2xx: the bounded refusal, never the upstream
      // body (criterion 32 — the job's own reason is distinct from a policy
      // refusal). The body stream is destroyed, not left dangling: nothing
      // consumes it, and the socket must not wait for a reader that will
      // never come.
      discardBody(res.body);
      req.log.info(
        { event: "edge.jobs_callback.upstream_refused", appId: claims.appId, status: res.status },
        "the upstream answered the governed callback GET with a non-success status",
      );
      setOutcome("upstream_refused");
      sendCallbackError(reply, 502, jobRequestError("upstream_error"));
      return;
    }

    // The one success: stream the upstream bytes to jobs — status and headers
    // stay ours (the result is the JSON value, and the upstream's framing is
    // never re-exposed). Returned, not merely sent: this handler is async, and
    // a bare `reply.send` leaves Fastify's own wrapper free to `end` the
    // response behind the pipe (ERR_STREAM_WRITE_AFTER_END — an empty 200).
    // The client-gone abort covers the stream itself.
    setOutcome("dispatched");
    return reply.status(200).header("cache-control", "no-store").send(res.body);
  }

  // The route wrapper: a fresh ROOT span (jobs extracts only verified service
  // context on its side; an inbound `traceparent` never chooses parentage
  // here either), graded from the response, ended when the handler settles.
  return spanRoute(
    surface.span,
    (req) => ({
      [ATTR_METHOD]: req.method,
      [ATTR_JOBS_OPERATION]: "fetch",
      "http.route": ROUTE_JOBS_FETCH,
    }),
    handleJobsFetch,
  );
}
