import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  type FetchErrorCode,
  OUTCOME_HEADER,
  parseFetchTarget,
  REQUEST_HEADER_SAFELIST,
  RESPONSE_HEADER_BLOCKLIST,
} from "@azx-pbc/shared";
import { capBody } from "@azx-pbc/shared/bodyCap";
import type { GatewayConfig } from "../config.js";
import type { RegistryReader } from "../registry/projection.js";
import { ANON_USER_OID, type CallerResolver } from "../auth/gate.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import type { OriginCheck } from "../auth/validate.js";
import { anonRateLimited, type IpRateLimiter } from "./ipRateLimiter.js";
import type { DenialThrottle } from "./denialThrottle.js";
import { EgressProviderError, type EgressProvider } from "./egressProvider.js";
import { mintInstruction } from "./instruction.js";
import { errorDetailOf, fetchPathOf, type GatewayOutcome, type UsageStore } from "./usage.js";

/**
 * `/_api/fetch/<url>` — the fetch-proxy policy plane (fetch-proxy design §7).
 * The edge authorizes (gate, CSRF, manifest allowlist, per-app budget), mints a
 * signed attested instruction, and forwards the call to `azx-egress` — which
 * holds the secrets and the internet route the edge deliberately lacks. The
 * upstream response streams straight back. Every call is metered into
 * `gateway_calls` (capability `fetch`, model = target origin, plus the request
 * `path` and `method`) — including the allowlist denial, which is recorded as
 * `forbidden` and is the one outcome here that never reaches egress. The
 * target's query string is never persisted (that is where credentials are
 * conventionally placed) — but the path is, and a path can carry a secret too:
 * see `fetchPathOf` in `usage.ts` for why no heuristic tries to spot one.
 */

export interface FetchGatewayRuntime {
  config: GatewayConfig;
  registry: RegistryReader;
  resolveCaller: CallerResolver;
  /** CSRF seam (dev-mode §5.4): edge = exact same-origin; dev-gateway = allowlist. */
  checkOrigin: OriginCheck;
  anonLimiter: IpRateLimiter | null;
  /** Caps metered allowlist denials per (app, env). null ⇒ uncapped (tests). */
  denialThrottle: DenialThrottle | null;
  /** null ⇒ EDGE_EGRESS_URL unset; the capability 503s. */
  egress: EgressProvider | null;
  usage: UsageStore | null;
  /** null ⇒ HELIX_INSTRUCTION_SECRET unset; the capability 503s. */
  instructionKey: Buffer | null;
}

const REQUEST_SAFE = new Set(REQUEST_HEADER_SAFELIST);
const RESPONSE_BLOCKED = new Set([...RESPONSE_HEADER_BLOCKLIST, OUTCOME_HEADER, "content-length"]);
const BODYLESS = new Set(["GET", "HEAD"]);

function sendFetchError(
  reply: FastifyReply,
  status: number,
  code: FetchErrorCode,
  message: string,
): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send({ code, message });
}

function safeRequestHeaders(headers: FastifyRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REQUEST_SAFE.has(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/** Map the egress outcome label to a ledger outcome. */
function toOutcome(egressOutcome: string): GatewayOutcome {
  if (egressOutcome === "ok") return "ok";
  if (egressOutcome === "refusal") return "refusal";
  return "error";
}

export function makeFetchHandler(rt: FetchGatewayRuntime) {
  return async function handleFetch(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return;

    const caller = await rt.resolveCaller(req, reply, entry);
    if (!caller) return;
    const userOid = caller.authenticated ? caller.oid : ANON_USER_OID;

    if (await anonRateLimited(rt.anonLimiter, req, entry, caller)) {
      sendFetchError(reply, 429, "rate_limited", "per-IP request budget exhausted");
      return;
    }

    // CSRF: the proxy call is same-origin by construction; reject anything else.
    if (!rt.checkOrigin(req, entry)) {
      sendFetchError(reply, 403, "forbidden", "Origin not allowed");
      return;
    }

    if (!rt.egress || !rt.usage || !rt.instructionKey) {
      sendFetchError(reply, 503, "upstream_error", "fetch capability is not configured");
      return;
    }
    // Bound once, above the allowlist denial — both it and the quota gate below
    // meter through this, and the 503 guard has already narrowed it.
    const usage = rt.usage;

    const target = parseFetchTarget(req.raw.url ?? "");
    if (!target) {
      sendFetchError(reply, 400, "bad_target", "missing or invalid target URL");
      return;
    }

    // Authz: the target origin must be a proxied origin in this app's manifest.
    // The lookup is on the canonical origin, so percent-encoding can't bypass it.
    if (!entry.fetch.connections.has(target.origin)) {
      // Meter the denial — an app reaching for an origin its manifest never
      // granted is the most audit-interesting event on this surface, and it used
      // to leave no trace at all: the request log kept it for 30 days and the
      // ledger, which is what the Audit page reads, knew nothing.
      //
      // Capped per (app, env). This is the one write on the handler that no
      // other gate bounds — the per-IP limiter skips authenticated callers, this
      // check returns before the daily budget, and `fetchRequestsToday` excludes
      // `forbidden` — so without the throttle a retry loop against a typo'd host
      // appends to an undeletable table at line rate. The first N per window
      // carry the whole audit signal ("this app reached for an origin it doesn't
      // have"); the rest are dropped with a magnitude summary on the log.
      const decision = rt.denialThrottle
        ? await rt.denialThrottle.admit(entry.appId, caller.env)
        : { meter: true as const, suppressedAt: undefined };
      if (decision.suppressedAt !== undefined) {
        req.log.warn(
          {
            appId: entry.appId,
            env: caller.env,
            origin: target.origin,
            attempts: decision.suppressedAt,
          },
          "allowlist-denial metering suppressed — this app is over its denial budget for the window",
        );
      }
      if (decision.meter) {
        // Deliberately not awaited: `record` opens a transaction
        // (`withPartition`) held across four round-trips on the pool that also
        // serves the budget checks. The 403 must not wait on that, and the
        // throttle above is what bounds how many can be in flight.
        void usage
          .record({
            appId: entry.appId,
            env: caller.env,
            userOid,
            capability: "fetch",
            model: target.origin,
            inputTokens: 0,
            outputTokens: 0,
            outcome: "forbidden",
            statusCode: 403,
            path: fetchPathOf(target.pathname),
            method: req.method,
            errorDetail: `origin ${target.origin} is not a proxied origin`,
          })
          .catch((err: unknown) => req.log.warn({ err }, "gateway usage record failed"));
      }
      sendFetchError(reply, 403, "forbidden", `origin ${target.origin} is not a proxied origin`);
      return;
    }
    const connection = entry.fetch.connections.get(target.origin) ?? null;

    // Quota (block-new): the per-app daily request budget from the manifest.
    const budget = entry.fetch.requestsPerDay;
    if (budget !== null) {
      const usedToday = await usage.fetchRequestsToday(entry.appId, caller.env);
      if (usedToday >= budget) {
        await usage
          .record({
            appId: entry.appId,
            env: caller.env,
            userOid,
            capability: "fetch",
            model: target.origin,
            inputTokens: 0,
            outputTokens: 0,
            outcome: "quota_blocked",
            statusCode: 429,
            path: fetchPathOf(target.pathname),
            method: req.method,
          })
          .catch((err: unknown) => req.log.warn({ err }, "gateway usage record failed"));
        sendFetchError(reply, 429, "rate_limited", "daily fetch budget exhausted");
        return;
      }
    }

    // Request body cap, fast-path: refuse a truthful oversized content-length
    // before minting an instruction or dialing egress. The byte counter on the
    // re-stream below is the real, framing-independent enforcement (issue #8).
    if (!BODYLESS.has(req.method)) {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > rt.config.fetch.maxBodyBytes) {
        sendFetchError(reply, 413, "too_large", "request body exceeds the size cap");
        return;
      }
    }

    // Mint the attested instruction and forward to egress.
    const instruction = await mintInstruction(
      {
        appId: entry.appId,
        userOid,
        capability: "fetch",
        origin: target.origin,
        requestId: randomUUID(),
        env: caller.env,
        method: req.method,
        path: target.pathname,
        ...(connection ? { connection } : {}),
      },
      rt.instructionKey,
    );

    // Abort the egress call if the app goes away — but watch the *response*, not
    // the request. `req.raw` emits 'close' when the request body finishes
    // arriving (the ended stream auto-destroys), which for a proxy that drains
    // `req.raw` itself is normal completion, not a disconnect: watching it
    // aborted every POST/PUT/PATCH/DELETE the moment its body landed, long
    // before egress answered. The ServerResponse's 'close' fires when the
    // connection actually goes away, and `writableEnded` separates "we
    // finished answering" from "they hung up". Fastify's own `request.signal` is
    // wired to the same unguarded `req.on('close')` — do not substitute it.
    //
    // `writableEnded`, not `writableFinished`: the two agree on a real socket,
    // but light-my-request's null socket never settles `writableFinished`, so
    // under `app.inject()` every ordinary response would look like a hang-up.
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    // Count the request bytes forwarded to egress: a chunked / CL-absent /
    // lying-CL upload can't stream past the cap uncounted. A trip destroys
    // req.raw and errors the forward → the catch maps it to a 413.
    let requestCapTripped = false;
    const requestBody = BODYLESS.has(req.method)
      ? null
      : capBody(req.raw, rt.config.fetch.maxBodyBytes, "request", () => {
          requestCapTripped = true;
        });

    const startedAt = performance.now();
    const record = (
      outcome: GatewayOutcome,
      extra: { statusCode?: number; errorDetail?: string } = {},
    ): Promise<void> =>
      usage
        .record({
          appId: entry.appId,
          env: caller.env,
          userOid,
          capability: "fetch",
          model: target.origin,
          inputTokens: 0,
          outputTokens: 0,
          outcome,
          durationMs: Math.round(performance.now() - startedAt),
          statusCode: extra.statusCode ?? null,
          errorDetail: extra.errorDetail ?? null,
          // `pathname` only — the query is dropped and the value is capped. See
          // `fetchPathOf`; the same line is drawn by the log serializer.
          path: fetchPathOf(target.pathname),
          method: req.method,
        })
        .catch((err: unknown) => req.log.warn({ err }, "gateway usage record failed"));

    try {
      const res = await rt.egress.proxy({
        instruction,
        target: target.href,
        method: req.method,
        headers: safeRequestHeaders(req.headers),
        body: requestBody,
        signal: abort.signal,
      });

      await record(toOutcome(res.outcome), { statusCode: res.status });

      reply.status(res.status).header("cache-control", "no-store");
      for (const [k, v] of Object.entries(res.headers)) {
        if (!RESPONSE_BLOCKED.has(k) && v !== undefined) reply.header(k, v);
      }
      // Count the response bytes on the way to the app: egress already caps, but
      // the edge caps independently (defense-in-depth — the two hops don't trust
      // each other). Status + headers are committed, so a trip truncates the
      // body rather than erroring (issue #8).
      return reply.send(
        capBody(res.body, rt.config.fetch.maxBodyBytes, "response", () => {
          req.log.warn(
            { appId: entry.appId, origin: target.origin, limit: rt.config.fetch.maxBodyBytes },
            "fetch response body exceeded the size cap — truncated",
          );
        }),
      );
    } catch (err) {
      // A request-body cap trip surfaces here as a failed egress forward; report
      // it as a 413 rather than a generic upstream error (nothing sent yet).
      if (requestCapTripped) {
        await record("refusal", { statusCode: 413 });
        sendFetchError(reply, 413, "too_large", "request body exceeds the size cap");
        return;
      }
      await record("error", { errorDetail: errorDetailOf(err) });
      if (err instanceof EgressProviderError) {
        sendFetchError(reply, 502, "upstream_error", "egress request failed");
        return;
      }
      sendFetchError(reply, 502, "upstream_error", "fetch failed");
    }
  };
}
