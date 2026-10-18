import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { trace } from "@opentelemetry/api";
import type { Env } from "@azx-pbc/shared";
import { capBody } from "@azx-pbc/shared/bodyCap";
import {
  ATTR_CONNECTION,
  ATTR_PROVIDER_REF,
  ATTR_TARGET_ORIGIN,
  ATTR_TARGET_PATH,
} from "@azx-pbc/shared/telemetry";
import type { RegistryEntry } from "../registry/projection.js";
import type { MeterIdentity } from "../auth/gate.js";
import type { DenialThrottle } from "./denialThrottle.js";
import type { EgressProvider, EgressResponse } from "./egressProvider.js";
import { mintInstruction } from "./instruction.js";
import {
  errorDetailOf,
  fetchPathOf,
  meterGatewayCall,
  type GatewayOutcome,
  type UsageStore,
} from "./usage.js";

/**
 * The shared fetch-policy/execution core (ADR-0006): everything an outbound
 * proxied call needs beyond the caller transport — the manifest allowlist, the
 * credential source, the per-app budget, attested-instruction minting, the
 * egress forward, and the ledger/metric bookkeeping — written once and
 * consumed through an explicit caller authority.
 *
 * The core never resolves a session, never touches a Fastify reply, and never
 * parses a transport-specific URL. An adapter brings the CURRENT serving entry
 * (resolved at call time — never an enqueue-time copy), the environment, the
 * caller's {@link FetchAuthority}, a parsed target, and the transport plumbing
 * (headers, body, abort signal, logger); the core returns a typed outcome the
 * adapter renders in its own response vocabulary. The browser adapter is
 * `fetch.ts` (`makeFetchHandler`); the signed jobs callback
 * (background-jobs-plane design §2) is the unattended one.
 *
 * The authority distinction is the boundary's point, and no caller may infer
 * it from an id's shape: a browser caller may spend a delegated provider
 * binding (the session principal's connection is what egress injects, keyed by
 * the principal kind the mint attests), while an unattended caller may not —
 * the core refuses such origins (`delegated_unattended`) before minting and
 * never falls back to a keyless request. The unattended caller's signed
 * lifecycle generation is fenced against the registry's current generation
 * before dispatch, so work awaiting execution under an app generation that is
 * no longer current never dials out.
 *
 * Every pre-egress policy denial is ledgered exactly as the browser route
 * always metered its allowlist denial (capped, metric unconditional), and the
 * triggering principal — whoever the authority names — stays the attribution
 * on every row.
 */

/**
 * The slice of the request logger the core warns through — the record-failure
 * and denial-suppression lines. Narrow on purpose: the core's logging surface
 * is those events and nothing else. A Fastify request logger satisfies it
 * structurally.
 */
export interface FetchPolicyLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The caller authority a proxied call runs under — the explicit browser/job
 * distinction ADR-0006 keeps at this boundary.
 */
export type FetchAuthority =
  | {
      /**
       * A browser caller on a serving surface (the app host or the dev
       * gateway): a resolved session principal, or the anonymous sentinel on
       * a public app. Delegated providers are usable — the caller's own
       * connection to the provider is what egress injects, which is why the
       * mint must attest the principal kind egress refuses `anon`/`password`
       * callers by.
       */
      kind: "browser";
      /** The session's metered attribution, display half included. */
      identity: MeterIdentity;
    }
  | {
      /**
       * An unattended caller (the signed jobs callback): the triggering
       * principal is ATTRIBUTION only — recorded on the ledger rows, never a
       * credential. No session exists, so the display half is null, and
       * delegated providers are refused outright: a user's OAuth connection
       * must not be spent by work running after the user left
       * (`delegated_unattended`, no keyless fallback).
       */
      kind: "unattended";
      identity: MeterIdentity;
      /**
       * The lifecycle generation the caller's signed instruction carried.
       * Fenced against the entry's current generation before anything is
       * minted or dialled — a generation that is no longer current (the app
       * archived, or a new generation opened, while the work waited) refuses
       * with `generation_stale` even when every grant would otherwise admit
       * the call.
       */
      generation: string;
    };

/**
 * Why the core refused a call before egress was dialled. Adapter-neutral
 * words: each adapter renders them in its own response vocabulary (the
 * browser route's `{code, message}` shapes; the jobs callback's
 * `JobRequestError` catalogue).
 */
export type FetchDenialReason =
  | "generation_stale"
  | "origin_not_granted"
  | "delegated_unattended"
  | "budget_exhausted"
  | "request_too_large";

export interface FetchDenial {
  reason: FetchDenialReason;
  /** The upstream origin the denial concerns (parsed before every denial). */
  origin: string;
}

export type FetchPolicyResult =
  | { kind: "denied"; denial: FetchDenial }
  /**
   * Egress answered — any status, success or not: the ledger row is written
   * and the response is the adapter's to deliver. The body streams untouched.
   */
  | { kind: "forwarded"; response: EgressResponse }
  /**
   * The forward itself failed after minting — a transport failure, the client
   * abort firing, or a request-body cap trip (that one is answered
   * `request_too_large` instead). The ledger row is written; the error is the
   * adapter's to classify (its own 502 vocabulary, a bounded upstream failure).
   */
  | { kind: "failed"; error: unknown };

export interface FetchPolicyDeps {
  egress: EgressProvider;
  usage: UsageStore;
  instructionKey: Buffer;
  /**
   * Caps metered policy denials per (app, env) — the one write on the policy
   * path no other gate bounds. null ⇒ uncapped (tests).
   */
  denialThrottle: DenialThrottle | null;
  /** The edge's own request-body cap, independent of egress's. */
  maxBodyBytes: number;
}

export interface FetchPolicyCall {
  /** The CURRENT serving entry — resolved by the adapter at call time. */
  entry: RegistryEntry;
  env: Env;
  authority: FetchAuthority;
  /** The parsed upstream target (the adapter owns its transport's parse). */
  target: URL;
  /** The upstream method — the unattended callback's is always GET. */
  method: string;
  /** Already-safelisted request headers to forward upstream. */
  headers: Record<string, string>;
  /**
   * The offered request body; nulled here for the bodyless methods, and
   * enforced against the cap before anything is minted or dialled — a
   * materialized body by its length, a stream by byte count on the way out.
   */
  body: Readable | Buffer | string | null;
  /**
   * The caller-declared request size, when its transport states one — the
   * fast-path refuses a truthful oversized upload before minting. The byte
   * counter below is the real, framing-independent enforcement.
   */
  declaredRequestBytes: number | null;
  signal: AbortSignal;
  /**
   * The adapter's own request id, so both halves of the egress call land on
   * one value in two different Log Analytics workspaces. **Not** the
   * instruction's `jti`/`requestId`, which is a single-use replay nonce and
   * must stay one.
   */
  correlationId: string;
  log: FetchPolicyLog;
}

/** Which methods carry no request body — and so skip the body cap entirely. */
const BODYLESS = new Set(["GET", "HEAD"]);

/**
 * Map the egress outcome label to a ledger outcome — the ledger's outcome
 * granularity, restated at the consumer. `connection_required` is its own
 * label: "the caller has no usable connection" is a consent state, not a
 * policy refusal, and the ledger separates
 * the two. The provider-shaped codes (`provider_unavailable`,
 * `provider_misconfigured`) ledger as `refusal`, like egress's other 4xx
 * refusals. Everything else — a vendor throttle, a temporary renewal failure,
 * any future word — folds to `error`, so an unknown label can never masquerade
 * as a clean `ok`.
 */
function toOutcome(egressOutcome: string): GatewayOutcome {
  if (egressOutcome === "ok") return "ok";
  if (egressOutcome === "connection_required") return "connection_required";
  if (
    egressOutcome === "refusal" ||
    egressOutcome === "provider_unavailable" ||
    egressOutcome === "provider_misconfigured"
  ) {
    return "refusal";
  }
  return "error";
}

/**
 * Ledger one pre-egress policy denial — the shape the browser route's
 * allowlist denial always had, now shared by every denial the core can reach.
 * The row's `outcome`/`statusCode` mirror the answer the caller actually gets,
 * so the audit trail never describes a different refusal than the one served.
 *
 * Capped per (app, env). This is the one write on the policy path no other
 * gate bounds — the per-IP limiter only sees browser callers, every denial
 * here returns before the egress dial, and the ones ledgered `forbidden` are
 * excluded from `fetchRequestsToday`, so they consume no budget either —
 * without the throttle a retry loop appends to an undeletable table at line
 * rate. The first N per window carry the whole audit signal; the rest are
 * dropped with a magnitude summary on the log.
 *
 * The metric is NOT gated on `decision.meter`, and that divergence is
 * deliberate. The throttle is a write-amplification defence on an append-only
 * table with no DELETE grant — it exists to stop an app filling the ledger,
 * not to hide the event. "An app is hammering at a call it cannot make" is
 * precisely what an operator wants to see, and past N the ledger is blind to
 * it by design. This makes `helix.gateway.calls` and `gateway_calls` provably
 * differ, which strengthens ADR-0037 decision 9 rather than bending it: the
 * two can now never be reconciled, so nobody will try.
 */
async function meterPolicyDenial(
  deps: FetchPolicyDeps,
  call: FetchPolicyCall,
  origin: string,
  outcome: Extract<GatewayOutcome, "forbidden">,
  statusCode: number,
  errorDetail: string,
): Promise<void> {
  const { entry, env, method, target, authority, log } = call;
  const decision = deps.denialThrottle
    ? await deps.denialThrottle.admit(entry.appId, env)
    : { meter: true as const, suppressedAt: undefined };
  if (decision.suppressedAt !== undefined) {
    log.warn(
      {
        appId: entry.appId,
        env,
        origin,
        attempts: decision.suppressedAt,
      },
      "fetch policy-denial metering suppressed — this app is over its denial budget for the window",
    );
  }
  meterGatewayCall({
    appId: entry.appId,
    capability: "fetch",
    outcome,
  });
  if (decision.meter) {
    // Deliberately not awaited: `record` opens a transaction
    // (`withPartition`) held across four round-trips on the pool that also
    // serves the budget checks. The refusal must not wait on that, and the
    // throttle above is what bounds how many can be in flight.
    void deps.usage
      .record({
        appId: entry.appId,
        env,
        ...authority.identity,
        capability: "fetch",
        model: origin,
        inputTokens: 0,
        outputTokens: 0,
        outcome,
        statusCode,
        path: fetchPathOf(target.pathname),
        method,
        errorDetail,
      })
      .catch((err: unknown) => log.warn({ err }, "gateway usage record failed"));
  }
}

/**
 * Run one proxied call through the fetch policy and execute it against
 * egress. Returns a typed outcome — a denial (already metered and ledgered),
 * a forwarded response (ledgered, streaming, the adapter's to deliver), or a
 * failed forward (ledgered, the error the adapter's to classify). The
 * egress forward's failures are returned, never thrown; a failure inside a
 * dependency itself (the budget read, the mint) propagates to the caller's
 * error handling, exactly as it did before the core existed.
 */
export async function runFetchPolicy(
  deps: FetchPolicyDeps,
  call: FetchPolicyCall,
): Promise<FetchPolicyResult> {
  const { entry, env, authority, target, method } = call;
  const origin = target.origin;

  // Unattended authority, fenced first (ADR-0006): the signed lifecycle
  // generation must equal the registry's current generation before dispatch.
  // An app archived — or a new generation opened — while the work waited
  // refuses here, before any allowlist look, mint, or dial, and the refusal
  // never falls back to trying without it.
  if (authority.kind === "unattended" && authority.generation !== entry.jobsGeneration) {
    await meterPolicyDenial(
      deps,
      call,
      origin,
      "forbidden",
      403,
      "the app's lifecycle generation is not current",
    );
    return { kind: "denied", denial: { reason: "generation_stale", origin } };
  }

  // Authz: the target origin must be a proxied origin in this app's manifest.
  // The lookup is on the canonical origin, so percent-encoding can't bypass it.
  if (!entry.fetch.connections.has(origin)) {
    await meterPolicyDenial(
      deps,
      call,
      origin,
      "forbidden",
      403,
      `origin ${origin} is not a proxied origin`,
    );
    return { kind: "denied", denial: { reason: "origin_not_granted", origin } };
  }

  // The origin is allowlisted; unwrap its credential source. Exactly one of
  // the three shapes mints a credential field: a secret-bound origin names
  // the stored secret, a provider-bound origin names the delegated provider
  // ref (the user's connection to that provider is what egress injects — the
  // edge holds no provider state and evaluates none), and a
  // keyless one carries neither. The union makes secret and provider
  // mutually exclusive, so the instruction's XOR holds by
  // construction.
  const credential = entry.fetch.connections.get(origin);
  const connection = credential?.kind === "secret" ? credential.connection : null;
  const provider = credential?.kind === "provider" ? credential.provider : null;

  // Recorded only now: the origin has been matched against the manifest
  // allowlist, so it is a value the operator granted rather than one the app
  // chose. `fetchPathOf` is the ledger's own cap — reusing it means the span
  // attribute and the `path` column cannot draw the line in different places.
  trace.getActiveSpan()?.setAttributes({
    [ATTR_TARGET_ORIGIN]: origin,
    [ATTR_TARGET_PATH]: fetchPathOf(target.pathname),
    ...(connection ? { [ATTR_CONNECTION]: connection } : {}),
    ...(provider ? { [ATTR_PROVIDER_REF]: provider } : {}),
  });

  // Unattended authority, delegated prohibition (ADR-0006): a provider-backed
  // origin spends a user's delegated connection, which unattended work may
  // never do — refused before minting, and never stripped to retry keyless.
  if (authority.kind === "unattended" && provider !== null) {
    await meterPolicyDenial(
      deps,
      call,
      origin,
      "forbidden",
      403,
      "origin requires delegated user credentials",
    );
    return { kind: "denied", denial: { reason: "delegated_unattended", origin } };
  }

  // Quota (block-new): the per-app daily request budget from the manifest.
  const budget = entry.fetch.requestsPerDay;
  if (budget !== null) {
    const usedToday = await deps.usage.fetchRequestsToday(entry.appId, env);
    if (usedToday >= budget) {
      // No `durationMs`: refused before anything was dialled.
      meterGatewayCall({ appId: entry.appId, capability: "fetch", outcome: "quota_blocked" });
      await deps.usage
        .record({
          appId: entry.appId,
          env,
          ...authority.identity,
          capability: "fetch",
          model: origin,
          inputTokens: 0,
          outputTokens: 0,
          outcome: "quota_blocked",
          statusCode: 429,
          path: fetchPathOf(target.pathname),
          method,
        })
        .catch((err: unknown) => call.log.warn({ err }, "gateway usage record failed"));
      return { kind: "denied", denial: { reason: "budget_exhausted", origin } };
    }
  }

  // Request body cap (issue #8). The byte counter on the re-stream below is
  // the real, framing-independent enforcement for a stream; two fast paths
  // refuse up front what is already known to be over the cap, before minting
  // an instruction or dialing egress: a content-length over the cap, and a
  // materialized body whose length is final — a declaration cannot make a
  // Buffer smaller, so the lying-declaration case the counter exists for is
  // settled by direct comparison. A bodyless method has nothing to cap.
  // Both fast paths meter like every other pre-egress denial: the per-IP
  // limiter skips authenticated callers, `fetchRequestsToday` excludes
  // `forbidden`, and nothing else bounds this write — an unmetered 413 flood
  // would be exactly the blindness the denial ledger exists to prevent.
  const bodyless = BODYLESS.has(method);
  const requestBody = bodyless ? null : call.body;
  const overCap =
    !bodyless &&
    ((call.declaredRequestBytes !== null && call.declaredRequestBytes > deps.maxBodyBytes) ||
      (requestBody instanceof Buffer && requestBody.length > deps.maxBodyBytes) ||
      (typeof requestBody === "string" && Buffer.byteLength(requestBody) > deps.maxBodyBytes));
  if (overCap) {
    await meterPolicyDenial(
      deps,
      call,
      origin,
      "forbidden",
      413,
      "request body exceeds the size cap",
    );
    return { kind: "denied", denial: { reason: "request_too_large", origin } };
  }

  // Mint the attested instruction and forward to egress. The opaque id ONLY
  // crosses the egress trust boundary: `AttestedInstructionSchema` is
  // deliberately the id and nothing more, and the captured labels must not
  // follow it there. `userKind` joins it only on a delegated mint, where
  // egress needs the recorded kind to refuse anon/password callers; the
  // display half (`userName`/`userEmail`) still never crosses. An unattended
  // call can never reach a delegated mint (refused above), so no kindless-
  // caller fabrication exists on that path either: the instruction attests
  // exactly what the authority stated.
  const instruction = await mintInstruction(
    {
      appId: entry.appId,
      userOid: authority.identity.userOid,
      capability: "fetch",
      origin,
      requestId: randomUUID(),
      env,
      method,
      path: target.pathname,
      ...(connection ? { connection } : {}),
      ...(provider ? { provider } : {}),
      ...(provider && authority.identity.userKind ? { userKind: authority.identity.userKind } : {}),
    },
    deps.instructionKey,
  );

  // Count the request bytes forwarded to egress: a chunked / CL-absent /
  // lying-CL upload can't stream past the cap uncounted. A trip destroys
  // the body stream and errors the forward → the catch maps it to a 413.
  let requestCapTripped = false;
  const cappedBody =
    requestBody instanceof Readable
      ? capBody(requestBody, deps.maxBodyBytes, "request", () => {
          requestCapTripped = true;
        })
      : requestBody;

  const startedAt = performance.now();
  const record = (
    outcome: GatewayOutcome,
    extra: { statusCode?: number; errorDetail?: string } = {},
  ): Promise<void> => {
    const durationMs = Math.round(performance.now() - startedAt);
    meterGatewayCall({ appId: entry.appId, capability: "fetch", outcome, durationMs });
    return deps.usage
      .record({
        appId: entry.appId,
        env,
        ...authority.identity,
        capability: "fetch",
        model: origin,
        inputTokens: 0,
        outputTokens: 0,
        outcome,
        durationMs,
        statusCode: extra.statusCode ?? null,
        errorDetail: extra.errorDetail ?? null,
        // `pathname` only — the query is dropped and the value is capped. See
        // `fetchPathOf`; the same line is drawn by the log serializer.
        path: fetchPathOf(target.pathname),
        method,
      })
      .catch((err: unknown) =>
        call.log.warn(
          {
            err,
            event: "gateway.usage_record_failed",
            appId: entry.appId,
            capability: "fetch",
            outcome,
          },
          "gateway usage record failed",
        ),
      );
  };

  try {
    const res = await deps.egress.proxy({
      instruction,
      target: target.href,
      method,
      headers: call.headers,
      body: cappedBody,
      signal: call.signal,
      correlationId: call.correlationId,
    });

    await record(toOutcome(res.outcome), { statusCode: res.status });
    return { kind: "forwarded", response: res };
  } catch (err) {
    // A request-body cap trip surfaces here as a failed egress forward; report
    // it as a 413 rather than a generic upstream error (nothing sent yet).
    if (requestCapTripped) {
      await record("refusal", { statusCode: 413 });
      return { kind: "denied", denial: { reason: "request_too_large", origin } };
    }
    await record("error", { errorDetail: errorDetailOf(err) });
    return { kind: "failed", error: err };
  }
}
