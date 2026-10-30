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
import { meterIdentity, type CallerResolver } from "../auth/gate.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import type { OriginCheck } from "../auth/validate.js";
import { anonRateLimited, type IpRateLimiter } from "./ipRateLimiter.js";
import type { DenialThrottle } from "./denialThrottle.js";
import { EgressProviderError, type EgressProvider } from "./egressProvider.js";
import { abortOnClientGone } from "./clientGone.js";
import { runFetchPolicy, type FetchDenial } from "./fetchPolicy.js";
import type { UsageStore } from "./usage.js";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import {
  ATTR_APP_SLUG,
  ATTR_CAPABILITY,
  ATTR_METHOD,
  ROUTE_FETCH,
  SPAN_FETCH,
} from "@azx-pbc/shared/telemetry";
import { withRootSpan } from "../telemetry.js";

/**
 * `/_api/fetch/<url>` — the browser adapter for the shared fetch-policy core
 * (fetch-proxy design §7, ADR-0006). This surface owns what is specific to a
 * browser caller: the serving gate, the session-caller resolution, the per-IP
 * limiter, the CSRF origin check, the route-shaped target parse, the client-
 * gone abort, and delivering the upstream response into the reply (blocklisted
 * headers, independently capped body). Everything past those gates — the
 * manifest allowlist, the credential source, the budget, instruction minting,
 * the egress forward, and the ledger/metric bookkeeping — is the shared core's
 * (`fetchPolicy.ts`), which an unattended caller (the signed jobs callback)
 * reaches with its own authority and no session.
 *
 * Every policy denial still meters into `gateway_calls` (capability `fetch`,
 * model = target origin, plus the request `path` and `method`). Three outcomes
 * never reach egress: the allowlist denial (`forbidden`), the daily budget
 * refusal (`quota_blocked`), and a request body known to be over the cap
 * before minting (`too_large`). A body that trips the cap while streaming has
 * already reached egress and records `refusal`, status 413. See
 * `fetchPolicy.ts` for the reason. The target's query string is never persisted
 * (that is where credentials are conventionally placed) — but the path is, and
 * a path can carry a secret too: see `fetchPathOf` in `usage.ts` for why no
 * heuristic tries to spot one.
 */

export interface FetchGatewayRuntime {
  config: GatewayConfig;
  registry: RegistryReader;
  resolveCaller: CallerResolver;
  /** CSRF seam (dev-mode §5.4): edge = exact same-origin; dev-gateway = allowlist. */
  checkOrigin: OriginCheck;
  anonLimiter: IpRateLimiter | null;
  /** Caps metered fetch-policy denials per (app, env). null ⇒ uncapped (tests). */
  denialThrottle: DenialThrottle | null;
  /** null ⇒ EDGE_EGRESS_URL unset; the capability 503s. */
  egress: EgressProvider | null;
  usage: UsageStore | null;
  /** null ⇒ HELIX_INSTRUCTION_SECRET unset; the capability 503s. */
  instructionKey: Buffer | null;
}

const REQUEST_SAFE = new Set(REQUEST_HEADER_SAFELIST);
const RESPONSE_BLOCKED = new Set([...RESPONSE_HEADER_BLOCKLIST, OUTCOME_HEADER, "content-length"]);

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

/**
 * Render the core's denial in this route's `{code, message}` vocabulary. The
 * unattended-only reasons cannot be produced for a browser authority, but a
 * denial is never fallen through: if the core and the adapter ever disagree
 * about that, the caller sees the refusal.
 */
function renderDenial(reply: FastifyReply, denial: FetchDenial): void {
  switch (denial.reason) {
    case "origin_not_granted":
      sendFetchError(reply, 403, "forbidden", `origin ${denial.origin} is not a proxied origin`);
      return;
    case "budget_exhausted":
      sendFetchError(reply, 429, "rate_limited", "daily fetch budget exhausted");
      return;
    case "request_too_large":
      sendFetchError(reply, 413, "too_large", "request body exceeds the size cap");
      return;
    case "generation_stale":
    case "delegated_unattended":
      sendFetchError(reply, 403, "forbidden", "Origin not allowed");
      return;
    default: {
      // A `FetchDenialReason` variant without a case above must not reach the
      // browser as a silent empty reply where the core refused the call — the
      // compile error names the arm to render, and the runtime answer below
      // fails closed for anything that slips past the types.
      denial.reason satisfies never;
      sendFetchError(reply, 403, "forbidden", "Origin not allowed");
      return;
    }
  }
}

export function makeFetchHandler(rt: FetchGatewayRuntime) {
  async function handleFetch(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    const entry = resolveServingEntry(rt.registry, slug, reply);
    if (!entry) return;

    const caller = await rt.resolveCaller(req, reply, entry);
    if (!caller) return;

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

    const target = parseFetchTarget(req.raw.url ?? "");
    if (!target) {
      sendFetchError(reply, 400, "bad_target", "missing or invalid target URL");
      return;
    }

    // Abort the egress call if the caller goes away — the response's close,
    // not the request stream's (`abortOnClientGone` for the measured details
    // of that trap). Registered ahead of the policy run: a caller that hangs
    // up while a budget check or the mint is still in flight aborts the
    // forward too, instead of completing a call nobody is waiting for.
    const signal = abortOnClientGone(reply);

    const declared = Number(req.headers["content-length"]);
    const result = await runFetchPolicy(
      {
        egress: rt.egress,
        usage: rt.usage,
        instructionKey: rt.instructionKey,
        denialThrottle: rt.denialThrottle,
        maxBodyBytes: rt.config.fetch.maxBodyBytes,
      },
      {
        entry,
        env: caller.env,
        authority: { kind: "browser", identity: meterIdentity(caller) },
        target,
        method: req.method,
        headers: safeRequestHeaders(req.headers),
        body: req.raw,
        declaredRequestBytes: Number.isFinite(declared) ? declared : null,
        signal,
        correlationId: String(req.id),
        log: req.log,
      },
    );

    if (result.kind === "denied") {
      renderDenial(reply, result.denial);
      return;
    }
    if (result.kind === "failed") {
      if (result.error instanceof EgressProviderError) {
        sendFetchError(reply, 502, "upstream_error", "egress request failed");
        return;
      }
      sendFetchError(reply, 502, "upstream_error", "fetch failed");
      return;
    }

    const res = result.response;
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
  }

  /**
   * The one gateway route whose URL is attacker-controlled: `/_api/fetch/<target>`
   * splices the app's chosen target in unencoded, so *its* query string becomes
   * ours — and that is conventionally where an API key or an Azure SAS `sig`
   * lives (ADR-0037 decision 6). `spanUrlAttributes` runs `redactUrl` and then
   * drops the query wholesale, so no parameter-name list has to be right.
   *
   * Per-target attributes are added inside the policy core, once the target has been
   * parsed and matched against the manifest allowlist — an origin that failed
   * that check is not a value worth recording under a stable key.
   */
  return (req: FastifyRequest, reply: FastifyReply, slug: string): Promise<void> =>
    withRootSpan(
      SPAN_FETCH,
      {
        [ATTR_CAPABILITY]: "fetch",
        [ATTR_APP_SLUG]: slug,
        [ATTR_METHOD]: req.method,
        "http.route": ROUTE_FETCH,
        ...spanUrlAttributes(req.url),
      },
      () => handleFetch(req, reply, slug),
      { reply },
    );
}
