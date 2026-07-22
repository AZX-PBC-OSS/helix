import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  type FetchErrorCode,
  FETCH_PROXY_PREFIX,
  OUTCOME_HEADER,
  REQUEST_HEADER_SAFELIST,
  RESPONSE_HEADER_BLOCKLIST,
} from "@azx-pbc/shared";
import { capBody } from "@azx-pbc/shared/bodyCap";
import type { EdgeConfig } from "../config.js";
import type { RegistryReader } from "../registry/projection.js";
import { ANON_USER_OID, type CallerResolver } from "../auth/gate.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { isSameOrigin } from "../auth/validate.js";
import { anonRateLimited, type IpRateLimiter } from "./ipRateLimiter.js";
import { EgressProviderError, type EgressProvider } from "./egressProvider.js";
import { mintInstruction } from "./instruction.js";
import type { GatewayOutcome, UsageStore } from "./usage.js";

/**
 * `/_api/fetch/<url>` — the fetch-proxy policy plane (fetch-proxy design §7).
 * The edge authorizes (gate, CSRF, manifest allowlist, per-app budget), mints a
 * signed attested instruction, and forwards the call to `azx-egress` — which
 * holds the secrets and the internet route the edge deliberately lacks. The
 * upstream response streams straight back. Every call is metered into
 * `gateway_calls` (capability `fetch`, model = target origin).
 */

export interface FetchGatewayRuntime {
  config: EdgeConfig;
  registry: RegistryReader;
  resolveCaller: CallerResolver;
  anonLimiter: IpRateLimiter | null;
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

/** Extract the target URL from `/_api/fetch/<url>` (raw, then percent-decoded). */
function parseTarget(rawUrl: string): URL | null {
  const i = rawUrl.indexOf(FETCH_PROXY_PREFIX);
  if (i === -1) return null;
  const tail = rawUrl.slice(i + FETCH_PROXY_PREFIX.length);
  if (!tail) return null;
  for (const candidate of [tail, safeDecode(tail)]) {
    if (candidate === null) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") return url;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
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
    if (!isSameOrigin(req.headers.origin, rt.config, entry.slug)) {
      sendFetchError(reply, 403, "forbidden", "Origin not allowed");
      return;
    }

    if (!rt.egress || !rt.usage || !rt.instructionKey) {
      sendFetchError(reply, 503, "upstream_error", "fetch capability is not configured");
      return;
    }

    const target = parseTarget(req.raw.url ?? "");
    if (!target) {
      sendFetchError(reply, 400, "bad_target", "missing or invalid target URL");
      return;
    }

    // Authz: the target origin must be a proxied origin in this app's manifest.
    // The lookup is on the canonical origin, so percent-encoding can't bypass it.
    if (!entry.fetch.connections.has(target.origin)) {
      sendFetchError(reply, 403, "forbidden", `origin ${target.origin} is not a proxied origin`);
      return;
    }
    const connection = entry.fetch.connections.get(target.origin) ?? null;

    // Quota (block-new): the per-app daily request budget from the manifest.
    const usage = rt.usage;
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
          })
          .catch(() => {});
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
        ...(connection ? { connection } : {}),
      },
      rt.instructionKey,
    );

    const abort = new AbortController();
    req.raw.on("close", () => abort.abort());

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
      const detail = err instanceof Error ? err.message : String(err);
      await record("error", {
        errorDetail: detail.length > 300 ? `${detail.slice(0, 300)}…` : detail,
      });
      if (err instanceof EgressProviderError) {
        sendFetchError(reply, 502, "upstream_error", "egress request failed");
        return;
      }
      sendFetchError(reply, 502, "upstream_error", "fetch failed");
    }
  };
}
