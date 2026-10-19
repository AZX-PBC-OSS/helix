import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema, worstHealthState } from "@azx-pbc/shared";
import { traceContextMixin } from "@azx-pbc/telemetry/correlation";
import { loggerOption, requestIdOptions } from "@azx-pbc/shared/logging";
import type { GatewayConfig } from "../config.js";
import type { RegistryFreshnessReader, RegistryReader } from "../registry/projection.js";
import { registryFreshnessCheck } from "../registry/health.js";
import { trustProxyCheck, wireTrustProxyHealth } from "../routing/trustProxyHealth.js";
import { makeLlmHandler } from "../gateway/llm.js";
import { openAiCodec } from "../gateway/openaiCodec.js";
import { makeOpenAiModelsHandler } from "../gateway/openaiModels.js";
import { makeDataHandlers } from "../gateway/data-handler.js";
import { makeFetchHandler } from "../gateway/fetch.js";
import { DenialThrottle } from "../gateway/denialThrottle.js";
import { JobsSubmissionThrottle } from "../gateway/jobsThrottle.js";
import { InMemoryCounterStore } from "../gateway/counterStore.js";
import type { LlmProvider } from "../gateway/provider.js";
import type { EgressProvider } from "../gateway/egressProvider.js";
import type { UsageStore } from "../gateway/usage.js";
import type { AppDataStore } from "../gateway/data.js";
import type { JobsForwarder } from "../jobs/forwarder.js";
import { jobsReachabilityCheck, type JobsReachabilitySnapshot } from "../jobs/reachability.js";
import { makeJobsSubmitHandler, makeJobsRecordHandler } from "../gateway/jobs.js";
import { makeJobsFetchCallbackHandler, type JobsCallbackRuntime } from "../gateway/jobsCallback.js";
import type { JobsCallbackBurnStore } from "../jobs/burns.js";
import {
  ROUTE_JOBS_CANCEL_DEV,
  ROUTE_JOBS_FETCH,
  ROUTE_JOBS_RESULT_DEV,
  ROUTE_JOBS_SNAPSHOT_DEV,
  ROUTE_JOBS_SUBMIT_DEV,
  ROUTE_OPENAI,
  SPAN_JOBS_CANCEL_DEV,
  SPAN_JOBS_FETCH_DEV,
  SPAN_JOBS_RESULT_DEV,
  SPAN_JOBS_SNAPSHOT_DEV,
  SPAN_JOBS_SUBMIT_DEV,
} from "@azx-pbc/shared/telemetry";
import { makeDevTokenResolver } from "./resolver.js";
import { makeDevConsentStartHandler } from "./consentStart.js";
import { makeDevConnectionStatusHandler } from "./connectionStatus.js";
import type { DevTokenStore } from "./devTokenStore.js";
import { deriveInternalKey } from "../internalJwt.js";
import type { PortalProvider } from "../routing/portalProvider.js";

/**
 * helix-dev-gateway (dev-mode design §3, §5.4) — the cross-origin surface a
 * foreign app (Lovable, a cloud IDE) calls to reach an app's `env=dev` partition.
 * A SEPARATE process from the edge, running as `helix_dev` only, so a compromise
 * here can never touch a prod row (the isolation thesis, §5.3). It reuses the
 * edge's `/_api/*` handler factories unchanged, swapping two seams:
 *   - `resolveCaller` → a `DevTokenResolver` (bearer dev token, not a session;
 *     yields `env: 'dev'`);
 *   - `checkOrigin` → always-true (the resolver already matched the request Origin
 *     against the token's registered allowlist).
 * The app slug rides the **path** (`/:slug/_api/*`), since the host is fixed
 * (`dev-api.<base>`). CORS is hand-rolled (no new dep — ADR-0003): a preflight
 * route + an onSend reflection of the resolver-validated origin (the LLM SSE path
 * reflects it in its own hijacked writeHead — see llm.ts).
 */

export const SERVICE_NAME = "helix-dev-gateway";
// Must cover every verb the routes accept, incl. the fetch-proxy's PATCH, or a
// browser dev app's proxied PATCH fails preflight before reaching the handler.
const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
// Fallback when the browser doesn't send Access-Control-Request-Headers; the
// preflight otherwise echoes the requested set (so conditional/forwarded headers
// the egress safelist permits — If-None-Match, etc. — aren't blocked in dev).
const DEFAULT_ALLOWED_HEADERS = "authorization, content-type";
const PREFLIGHT_MAX_AGE = "600";

/** Append `Origin` to any existing `Vary` rather than clobbering upstream directives. */
function addVaryOrigin(reply: {
  getHeader(k: string): unknown;
  header(k: string, v: string): unknown;
}): void {
  const cur = reply.getHeader("vary");
  const parts =
    typeof cur === "string"
      ? cur.split(",").map((s) => s.trim())
      : Array.isArray(cur)
        ? cur.flatMap((v) =>
            String(v)
              .split(",")
              .map((s) => s.trim()),
          )
        : [];
  const kept = parts.filter(Boolean);
  if (!kept.some((p) => p.toLowerCase() === "origin")) kept.push("Origin");
  reply.header("vary", kept.join(", "));
}

export interface DevGatewayDeps {
  config: GatewayConfig;
  registry: RegistryReader & RegistryFreshnessReader;
  devTokens: DevTokenStore;
  appData: AppDataStore | null;
  usage: UsageStore | null;
  llmProvider: LlmProvider | null;
  egress: EgressProvider | null;
  instructionKey: Buffer | null;
  /**
   * The signed jobs forwarding seam over the configured servers; null = jobs
   * is fully disabled and the route answers 503 `jobs_disabled` (the same
   * fail-closed posture the edge's surface takes).
   */
  jobsForwarder: JobsForwarder | null;
  /**
   * The jobs reachability observation, read per request — `/health`'s
   * `jobs_reachability` check grades the probe loop's snapshot, never a live
   * probe. Optional (absent = fully disabled jobs, no jobs dependency in the
   * body), the same posture the edge's own health takes.
   */
  jobsReachability?: (() => JobsReachabilitySnapshot) | null;
  /**
   * The dev tier's jobs-callback nonce burn store (`jobs_callback_jti`, the
   * `dev` RLS partition); the signed jobs→edge callback route burns through
   * it. null = the callback refuses fail-closed even with servers configured.
   */
  jobsCallbackBurns: JobsCallbackBurnStore | null;
  /**
   * Portal client for the dev tier's consent consult; null — or an unset
   * internal mint key — leaves the
   * consent start route answering a fail-closed 503, like every other seam.
   */
  portal: PortalProvider | null;
  https?: { cert: Buffer; key: Buffer } | null;
}

const DATA_ROUTES = [
  ["PUT", "/_api/data/user/:key", "putUser"],
  ["GET", "/_api/data/user/:key", "getUser"],
  ["DELETE", "/_api/data/user/:key", "deleteUser"],
  ["GET", "/_api/data/user", "listUser"],
  ["POST", "/_api/data/collections/:name", "postCollection"],
  ["GET", "/_api/data/shared", "listShared"],
  ["GET", "/_api/data/shared/:key", "getShared"],
  ["PUT", "/_api/data/shared/:key", "putShared"],
] as const;

function slugOf(req: { params: unknown }): string {
  return (req.params as { slug: string }).slug;
}

export function buildDevGateway(deps: DevGatewayDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    // Same redacting serializer as the edge (issue #20). No handoff token
    // reaches this process, but it serves `/:slug/_api/fetch/<url>` — where the
    // app-chosen target URL, credentials and all, becomes our query string.
    logger: loggerOption(undefined, { prefix: "EDGE", mixin: traceContextMixin }),
    ...requestIdOptions(),
    // The reference grammar's bound, as on the edge: job ids are legal to 128
    // characters and the router's default (100) would refuse them first.
    routerOptions: { maxParamLength: 128 },
    trustProxy: config.trustProxy,
    ...(deps.https ? { https: deps.https } : {}),
  }) as unknown as FastifyInstance;

  app.decorateRequest("devCorsOrigin", undefined);

  // Same trust-proxy self-report as the edge (ADR-0011): the dev-gateway takes
  // the same EDGE_TRUST_PROXY value, and its denial damping / audit hash key on
  // `req.ip` the same way. Local dev sends no forwarded header and so never
  // counts — the check reads "not enough proxied traffic" here, which is right.
  const trustProxyObserver = wireTrustProxyHealth(app);

  const resolveCaller = makeDevTokenResolver(deps.devTokens);
  // The DevTokenResolver already validated Origin ∈ the token's allowlist, so the
  // handlers' CSRF seam is a no-op here (the cross-origin caller can never match
  // the production exact-origin check).
  const checkOrigin = (): boolean => true;

  const llmRuntime = {
    config,
    registry: deps.registry,
    resolveCaller,
    checkOrigin,
    anonLimiter: null,
    provider: deps.llmProvider,
    usage: deps.usage,
  };
  const handleLlmChat = makeLlmHandler(llmRuntime);
  const handleOpenAiChat = makeLlmHandler(llmRuntime, openAiCodec, ROUTE_OPENAI);
  const handleOpenAiModels = makeOpenAiModelsHandler(llmRuntime);
  const dataHandlers = makeDataHandlers({
    config,
    registry: deps.registry,
    resolveCaller,
    checkOrigin,
    anonLimiter: null,
    store: deps.appData,
    usage: deps.usage,
  });
  const handleFetch = makeFetchHandler({
    config,
    registry: deps.registry,
    resolveCaller,
    checkOrigin,
    anonLimiter: null,
    // Single-process by construction, but the dev gateway writes to the same
    // ledger as the edge, so the same denial cap applies.
    denialThrottle: new DenialThrottle(new InMemoryCounterStore()),
    egress: deps.egress,
    usage: deps.usage,
    instructionKey: deps.instructionKey,
  });
  // The dev tier's jobs routes — the edge's own handler factories over the
  // dev resolver seams, so a dev submission carries `env: 'dev'` and the dev
  // principal, and never the production tier's. The reference operations
  // (poll, result, cancellation) share the runtime and the forwarding seam.
  // The throttle buckets and the refusal-denial budget run on the in-memory
  // store — single-process by construction, like the fetch denial throttle
  // below — and the ledger is the same `UsageStore` the dev tier's other
  // capabilities write.
  const jobsRuntime = {
    registry: deps.registry,
    resolveCaller,
    checkOrigin,
    forwarder: deps.jobsForwarder,
    submissionThrottle: new JobsSubmissionThrottle(new InMemoryCounterStore()),
    denialThrottle: new DenialThrottle(new InMemoryCounterStore(), {
      keyPrefix: "jobs-denial:",
    }),
    usage: deps.usage,
  };
  const handleJobsSubmit = makeJobsSubmitHandler(jobsRuntime, {
    span: SPAN_JOBS_SUBMIT_DEV,
    route: ROUTE_JOBS_SUBMIT_DEV,
  });
  const handleJobsSnapshot = makeJobsRecordHandler(
    jobsRuntime,
    { span: SPAN_JOBS_SNAPSHOT_DEV, route: ROUTE_JOBS_SNAPSHOT_DEV },
    "snapshot",
  );
  const handleJobsResult = makeJobsRecordHandler(
    jobsRuntime,
    { span: SPAN_JOBS_RESULT_DEV, route: ROUTE_JOBS_RESULT_DEV },
    "result",
  );
  const handleJobsCancel = makeJobsRecordHandler(
    jobsRuntime,
    { span: SPAN_JOBS_CANCEL_DEV, route: ROUTE_JOBS_CANCEL_DEV },
    "cancel",
  );
  // The dev tier's callback receiver — the same handler factory, `dev` tier
  // (matching the burn store's RLS pin above): the production edge's callbacks
  // and this process's never share a nonce space, and each refuses the other's
  // signed tier before any burn.
  const jobsCallbackVerificationKeys = new Map(
    Object.values(config.jobs.servers).map((s) => [s.server, s.jobsToEdgeKey]),
  );
  const jobsCallbackRuntime: JobsCallbackRuntime | null =
    deps.egress &&
    deps.usage &&
    deps.instructionKey &&
    deps.jobsCallbackBurns &&
    jobsCallbackVerificationKeys.size > 0
      ? {
          env: "dev",
          registry: deps.registry,
          verificationKeys: jobsCallbackVerificationKeys,
          burns: deps.jobsCallbackBurns,
          egress: deps.egress,
          usage: deps.usage,
          instructionKey: deps.instructionKey,
          // Single-process by construction, like the fetch denial throttle.
          denialThrottle: new DenialThrottle(new InMemoryCounterStore()),
          maxBodyBytes: config.fetch.maxBodyBytes,
        }
      : null;
  const handleJobsFetchCallback = makeJobsFetchCallbackHandler(jobsCallbackRuntime, {
    span: SPAN_JOBS_FETCH_DEV,
  });

  // The dev tier's consent entry — the bearer POST that returns
  // the single-use popup URL. Same dev resolver seam as every other route
  // here (its Origin allowlist check is the route's navigation guard, run
  // before any consult); the consult rides the same callConsult seam as the
  // prod start route.
  const handleDevConsentStart = makeDevConsentStartHandler({
    config,
    registry: deps.registry,
    resolveCaller,
    portal: deps.portal ?? null,
    internalKey: config.internalSecret ? deriveInternalKey(config.internalSecret) : null,
  });

  // ADR-0031 as amended: the dev tier's connection-status read — the same
  // resolver seam, the same fail-closed runtime shape; no nonce (a status
  // read writes nothing).
  const handleDevConnectionStatus = makeDevConnectionStatusHandler({
    config,
    registry: deps.registry,
    resolveCaller,
    portal: deps.portal ?? null,
    internalKey: config.internalSecret ? deriveInternalKey(config.internalSecret) : null,
  });

  // Reflect the resolver-validated origin on normal (non-hijacked) responses. The
  // LLM SSE path hijacks the socket and reflects it in its own writeHead instead.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.devCorsOrigin) {
      // Overwriting ACAO is correct — it defeats an upstream reflecting its own on
      // a proxied fetch. Vary is appended so upstream cache directives survive.
      reply.header("access-control-allow-origin", req.devCorsOrigin);
      // ETag is not CORS-safelisted: without this the browser hides it from
      // `res.headers.get("etag")`, and the ADR-0041 CAS loop on a cross-origin
      // dev app reads null, always takes the create-if-absent branch, succeeds
      // once, then 412s forever (review finding 1). Same-origin prod apps are
      // unaffected; this is the only cross-origin data path.
      reply.header("access-control-expose-headers", "etag");
      addVaryOrigin(reply);
    }
    return payload;
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/health",
    handler: async (_req, reply) => {
      // Same contract as the edge (ADR-0025): freshness is reported, always 200.
      const checks = [
        registryFreshnessCheck(deps.registry.freshness(), deps.config.reconcileIntervalMs),
        trustProxyCheck(trustProxyObserver.snapshot()),
        // Composed only when jobs servers are configured — a fully disabled
        // install reports no jobs dependency at all (criterion 8).
        ...(deps.jobsReachability ? [jobsReachabilityCheck(deps.jobsReachability())] : []),
      ];
      reply.header("cache-control", "no-store");
      return HealthStatusSchema.parse({
        status: worstHealthState(checks.map((c) => c.status)),
        service: SERVICE_NAME,
        uptime: process.uptime(),
        checks,
      });
    },
  });

  // CORS preflight: a preflight carries no Authorization, so authorize by the
  // app's registered origins (any live token). Reflect only a registered origin.
  app.route({
    method: "OPTIONS",
    url: "/:slug/_api/*",
    handler: async (req, reply) => {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
      const entry = deps.registry.getApp(slugOf(req));
      const allowed =
        origin !== null &&
        entry !== undefined &&
        !entry.archived &&
        (await deps.devTokens.originAllowed(entry.appId, origin));
      if (allowed) {
        // Echo the browser's requested headers (bounded by the origin allowlist),
        // falling back to the static set — so a dev app's conditional/custom
        // request headers aren't blocked at preflight.
        const requested = req.headers["access-control-request-headers"];
        const allowHeaders =
          typeof requested === "string" && requested.length > 0
            ? requested
            : DEFAULT_ALLOWED_HEADERS;
        reply
          .header("access-control-allow-origin", origin)
          .header("access-control-allow-methods", ALLOWED_METHODS)
          .header("access-control-allow-headers", allowHeaders)
          .header("access-control-max-age", PREFLIGHT_MAX_AGE)
          .header("vary", "Origin, Access-Control-Request-Headers");
        await reply.status(204).send();
        return;
      }
      await reply
        .status(403)
        .header("cache-control", "no-store")
        .type("application/json; charset=utf-8")
        .send({ error: { code: "forbidden", message: "origin not allowed" } });
    },
  });

  app.route({
    method: "POST",
    url: "/:slug/_api/llm/chat",
    handler: (req, reply) => handleLlmChat(req, reply, slugOf(req)),
  });
  app.route({
    method: "POST",
    url: "/:slug/_api/openai/v1/chat/completions",
    handler: (req, reply) => handleOpenAiChat(req, reply, slugOf(req)),
  });
  app.route({
    method: "GET",
    url: "/:slug/_api/openai/v1/models",
    handler: (req, reply) => handleOpenAiModels(req, reply, slugOf(req)),
  });

  // The dev tier's consent start — `POST /:slug/_api/connections/:ref/start`.
  // The POST is the
  // authenticated half; the returned popup URL is a GET navigation that
  // carries only the nonce.
  app.route({
    method: "POST",
    url: "/:slug/_api/connections/:ref/start",
    handler: (req, reply) => handleDevConsentStart(req, reply, slugOf(req)),
  });

  // ADR-0031 as amended: the dev tier's connection-status read — a GET JSON
  // read under the same bearer + Origin-allowlist gate as the start POST.
  app.route({
    method: "GET",
    url: "/:slug/_api/connections/:ref/status",
    handler: (req, reply) => handleDevConnectionStatus(req, reply, slugOf(req)),
  });

  for (const [method, url, name] of DATA_ROUTES) {
    app.route({
      method,
      url: `/:slug${url}`,
      handler: (req, reply) => dataHandlers[name](req, reply, slugOf(req)),
    });
  }

  // Fetch-proxy: a passthrough body parser keeps `req.raw` streamable for egress
  // (the proxy re-streams arbitrary bodies), scoped so it doesn't disturb the JSON
  // parsing the llm/data routes rely on (mirrors the edge). parseTarget finds
  // `/_api/fetch/` anywhere in the URL, so the `/:slug` prefix is harmless.
  void app.register((fetchScope, _opts, doneRegister) => {
    fetchScope.removeAllContentTypeParsers();
    fetchScope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    // No OPTIONS here: a browser preflight to the fetch endpoint is a CORS
    // preflight handled by the top-level `OPTIONS /:slug/_api/*` route, not an
    // app-intended proxied OPTIONS. (Proxying OPTIONS through egress is deferred.)
    fetchScope.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      url: "/:slug/_api/fetch/*",
      handler: (req, reply) => handleFetch(req, reply, slugOf(req)),
    });
    doneRegister();
  });

  // The dev tier's jobs routes — the same passthrough-parser encapsulation as
  // the fetch scope (the submission forward binds exact request bytes; nothing
  // may parse them first; the record operations carry no body).
  void app.register((jobsScope, _opts, doneRegister) => {
    jobsScope.removeAllContentTypeParsers();
    jobsScope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    jobsScope.route({
      method: "POST",
      url: ROUTE_JOBS_SUBMIT_DEV,
      handler: (req, reply) => handleJobsSubmit(req, reply, slugOf(req)),
    });
    for (const [method, url, handler] of [
      ["GET", ROUTE_JOBS_SNAPSHOT_DEV, handleJobsSnapshot],
      ["GET", ROUTE_JOBS_RESULT_DEV, handleJobsResult],
      ["DELETE", ROUTE_JOBS_CANCEL_DEV, handleJobsCancel],
    ] as const) {
      jobsScope.route({
        method,
        url,
        handler: (req, reply) => handler(req, reply, slugOf(req)),
      });
    }
    doneRegister();
  });

  // The dev tier's callback receiver — the same fixed internal path (the dev
  // callback URL is this process's own host, no `/:slug` prefix: the claims
  // carry the app id, and the registry resolves it). Same raw-body parser
  // scope: the instruction binds exact bytes.
  void app.register((jobsCallbackScope, _opts, doneRegister) => {
    jobsCallbackScope.removeAllContentTypeParsers();
    jobsCallbackScope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    jobsCallbackScope.route({
      method: "POST",
      url: ROUTE_JOBS_FETCH,
      handler: (req, reply) => handleJobsFetchCallback(req, reply),
    });
    doneRegister();
  });

  return app;
}
