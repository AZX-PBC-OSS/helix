import Fastify, { type FastifyInstance } from "fastify";
import { HealthStatusSchema } from "@helix/shared";
import type { EdgeConfig } from "./config.js";
import type { BlobReader } from "./blob/client.js";
import type { RegistryReader } from "./registry/projection.js";
import { classifyHost, type HostClass } from "./routing/hosts.js";
import { makeAssetHandler } from "./serving/assets.js";
import { sendMethodNotAllowed, sendNotFound, sendUnavailable } from "./errors.js";
import { normalizeRequestPath } from "./serving/paths.js";
import { deriveAuthKeys } from "./auth/secrets.js";
import type { OidcClient } from "./auth/oidc.js";
import type { SessionStore } from "./auth/sessions.js";
import { makeCallbackHandler, makeStartHandler } from "./auth/routes/authHost.js";
import {
  makeAuthCompleteHandler,
  makeLogoutHandler,
  makeMeHandler,
} from "./auth/routes/appHost.js";
import { makeSessionGate } from "./auth/gate.js";
import { makeLlmHandler } from "./gateway/llm.js";
import type { LlmProvider } from "./gateway/provider.js";
import type { UsageStore } from "./gateway/usage.js";

/**
 * azx-edge — the data plane (architecture §3). Stateless; terminates all
 * `*.azx-labs.com` traffic. **Hard rule: dependency-minimal** — every npm
 * package here is code inside the trusted path, so additions need review
 * (project plan §6).
 *
 * M2: host routing, registry projection, asset streaming, baseline CSP.
 * Sessions/OIDC (M3) and the `/_api/*` gateway (M4) come later.
 */
const SERVICE_NAME = "azx-edge";

export interface EdgeDeps {
  config: EdgeConfig;
  registry: RegistryReader;
  blob: BlobReader;
  /** Session persistence; required for the auth routes to exist. */
  sessions?: SessionStore | null;
  /** IdP client; required for the auth routes to exist. */
  oidc?: OidcClient | null;
  /** LLM vendor provider (M4); null = no vendor key, capability 503s. */
  llmProvider?: LlmProvider | null;
  /** Gateway metering/budget ledger (M4); null disables the LLM capability. */
  usage?: UsageStore | null;
  /** Dev TLS material (server.ts reads the mkcert files); tests omit it. */
  https?: { cert: Buffer; key: Buffer } | null;
}

/**
 * Platform path namespaces on app hosts — never composed into blob keys.
 * Checked against BOTH the raw URL and the percent-decoded path the asset
 * handler will actually resolve (`/_api%2fme` decodes to `/_api/me` and must
 * be reserved too, not fall through to a blob named `_api/me`).
 */
function isReservedAppPath(rawUrl: string): boolean {
  const raw = rawUrl.split("?", 1)[0] ?? "";
  const decoded = normalizeRequestPath(rawUrl);
  for (const pathname of decoded === null ? [raw] : [raw, decoded]) {
    if (
      pathname === "/_auth" ||
      pathname.startsWith("/_auth/") ||
      pathname === "/_api" ||
      pathname.startsWith("/_api/")
    ) {
      return true;
    }
  }
  return false;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set once per request by the host-classification hook. */
    hostClass: HostClass;
  }
}

export function buildApp(deps: EdgeDeps): FastifyInstance {
  const { config } = deps;
  // The https/http generics differ; the instance is used identically, so the
  // assertion keeps one return type rather than a generic explosion.
  const app = Fastify({
    // Quiet during tests; structured JSON logs otherwise.
    logger: process.env.NODE_ENV !== "test",
    ...(deps.https ? { https: deps.https } : {}),
  }) as unknown as FastifyInstance;

  // Auth routes exist only when the whole auth stack is wired (config block +
  // session store + OIDC client); otherwise they fail closed below.
  const authRuntime =
    config.auth && deps.sessions && deps.oidc
      ? {
          config,
          auth: config.auth,
          keys: deriveAuthKeys(config.auth.secret),
          registry: deps.registry,
          sessions: deps.sessions,
          oidc: deps.oidc,
        }
      : null;
  const gate = authRuntime
    ? makeSessionGate({ config, auth: authRuntime.auth, sessions: authRuntime.sessions })
    : null;
  const serveAsset = makeAssetHandler({ ...deps, gate });

  const handleStart = authRuntime ? makeStartHandler(authRuntime) : null;
  const handleCallback = authRuntime ? makeCallbackHandler(authRuntime) : null;
  const handleAuthComplete = authRuntime ? makeAuthCompleteHandler(authRuntime) : null;
  const appApiRuntime =
    authRuntime && gate
      ? { config, registry: deps.registry, sessions: authRuntime.sessions, gate }
      : null;
  const handleMe = appApiRuntime ? makeMeHandler(appApiRuntime) : null;
  const handleLogout = appApiRuntime ? makeLogoutHandler(appApiRuntime) : null;
  // The LLM gateway needs a session (gate) to attribute calls; provider/usage
  // may still be null (no vendor key), in which case the handler returns 503.
  const handleLlmChat =
    appApiRuntime && gate
      ? makeLlmHandler({
          config,
          registry: deps.registry,
          gate,
          provider: deps.llmProvider ?? null,
          usage: deps.usage ?? null,
        })
      : null;

  // The two-router discipline (architecture §3, decision 12): every request
  // is classified by hostname exactly once, and the two worlds never mix —
  // platform handlers are unreachable on app hosts and vice versa. Explicit
  // dispatch instead of find-my-way host constraints: the fallback semantics
  // between constrained and unconstrained routes are non-obvious, and this
  // way the boundary is one readable hook.
  app.decorateRequest("hostClass");
  app.addHook("onRequest", async (req) => {
    req.hostClass = classifyHost(req.headers.host, config.baseDomain);
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/health",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app") {
        // App hosts serve only app content — a deployed file named /health
        // (or the SPA fallback) answers, never the platform health JSON.
        await serveAsset(req, reply, req.hostClass.slug);
        return;
      }
      return HealthStatusSchema.parse({
        status: "ok",
        service: SERVICE_NAME,
        uptime: process.uptime(),
      });
    },
  });

  // Appendix A steps 1–7 live on the auth host; on app hosts these are just
  // asset paths (an app may legitimately ship /start.html etc. — the asset
  // handler sees the same URL it always did).
  for (const [url, handler] of [
    ["/start", handleStart],
    ["/callback", handleCallback],
  ] as const) {
    app.route({
      method: "GET",
      url,
      handler: async (req, reply) => {
        if (req.hostClass.kind === "auth") {
          if (handler) {
            await handler(req, reply);
          } else {
            sendUnavailable(reply, "Sign-in is not configured on this edge.");
          }
          return;
        }
        if (req.hostClass.kind === "app") {
          await serveAsset(req, reply, req.hostClass.slug);
          return;
        }
        sendNotFound(reply);
      },
    });
  }

  // Appendix A step 8: handoff redemption, on app hosts only.
  app.route({
    method: "GET",
    url: "/_auth/complete",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app" && handleAuthComplete) {
        await handleAuthComplete(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });

  app.route({
    method: "POST",
    url: "/_auth/logout",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app" && handleLogout) {
        await handleLogout(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });

  // Appendix A.6: the one thing an app may ask about its user.
  app.route({
    method: "GET",
    url: "/_api/me",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app" && handleMe) {
        await handleMe(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });

  // M4 gateway: the LLM capability (architecture §6.1). App hosts only.
  app.route({
    method: "POST",
    url: "/_api/llm/chat",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app" && handleLlmChat) {
        await handleLlmChat(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app") {
        // `/_auth/*` and `/_api/*` are platform namespaces — anything not
        // explicitly routed above 404s rather than reaching the blob store.
        if (isReservedAppPath(req.raw.url ?? "/")) {
          sendNotFound(reply);
          return;
        }
        await serveAsset(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });

  // Unmatched methods (POST/PUT/… have no routes above) land here.
  app.setNotFoundHandler((req, reply) => {
    if (req.hostClass.kind === "app" && req.method !== "GET" && req.method !== "HEAD") {
      sendMethodNotAllowed(reply);
      return;
    }
    sendNotFound(reply);
  });

  return app;
}
