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
import {
  makePasswordLoginPageHandler,
  makePasswordLoginSubmitHandler,
} from "./auth/routes/passwordLogin.js";
import { LoginThrottle } from "./auth/loginThrottle.js";
import { makeCallerResolver, makeSessionGate } from "./auth/gate.js";
import { makeLlmHandler } from "./gateway/llm.js";
import { makeDataHandlers } from "./gateway/data-handler.js";
import type { LlmProvider } from "./gateway/provider.js";
import type { UsageStore } from "./gateway/usage.js";
import type { AppDataStore } from "./gateway/data.js";

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
  /** App-data store (M4/M5); null = the data capability 503s. */
  appData?: AppDataStore | null;
  /** Shared-password login throttle; tests inject a low-threshold one. */
  loginThrottle?: LoginThrottle | null;
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
  // The gateway keys identity off a Caller (authenticated session, or anon for
  // `public` apps — app-data design §6). The resolver wraps the gate with the
  // public-app short-circuit; asset serving keeps its own public bypass.
  const resolveCaller = gate ? makeCallerResolver(gate) : null;
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
  // The shared-password challenge (`password` visibility). Same-origin on the
  // app host — no auth host, no handoff — so it lives outside authRuntime's
  // OIDC surface. One throttle instance backs every app's login.
  const passwordLoginRuntime = authRuntime
    ? {
        config,
        auth: authRuntime.auth,
        registry: deps.registry,
        sessions: authRuntime.sessions,
        throttle: deps.loginThrottle ?? new LoginThrottle(),
      }
    : null;
  const handleLoginPage = passwordLoginRuntime
    ? makePasswordLoginPageHandler(passwordLoginRuntime)
    : null;
  const handleLoginSubmit = passwordLoginRuntime
    ? makePasswordLoginSubmitHandler(passwordLoginRuntime)
    : null;
  // The LLM gateway needs a session (gate) to attribute calls; provider/usage
  // may still be null (no vendor key), in which case the handler returns 503.
  const handleLlmChat =
    appApiRuntime && resolveCaller
      ? makeLlmHandler({
          config,
          registry: deps.registry,
          resolveCaller,
          provider: deps.llmProvider ?? null,
          usage: deps.usage ?? null,
        })
      : null;
  // The data gateway needs a caller (session, or anon on public apps); the
  // store may be null (capability 503s), like the LLM provider.
  const dataHandlers =
    appApiRuntime && resolveCaller
      ? makeDataHandlers({
          config,
          registry: deps.registry,
          resolveCaller,
          store: deps.appData ?? null,
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

  // The shared-password login form posts urlencoded. Hand-rolled parser (no
  // @fastify/formbody — dep-minimal rule): URLSearchParams into a flat object.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const out: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(body as string)) out[k] = v;
        done(null, out);
      } catch (err) {
        done(err as Error);
      }
    },
  );

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

  // Shared-password challenge (`password` visibility), on app hosts only. GET
  // serves the login page; POST verifies and mints the session. Non-password
  // apps 404 inside the handler (no signal).
  app.route({
    method: "GET",
    url: "/_auth/login",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app" && handleLoginPage) {
        await handleLoginPage(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });
  app.route({
    method: "POST",
    url: "/_auth/login",
    handler: async (req, reply) => {
      if (req.hostClass.kind === "app" && handleLoginSubmit) {
        await handleLoginSubmit(req, reply, req.hostClass.slug);
        return;
      }
      sendNotFound(reply);
    },
  });

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

  // M4/M5 gateway: the app-data capability (app-data design §5.1). App hosts
  // only. NOTE the deliberate absence of any collection read/list/delete verb —
  // §3.2's write-only property is enforced by the route table AND the store
  // type, and is covered by an adversarial test.
  for (const [method, url, name] of [
    ["PUT", "/_api/data/user/:key", "putUser"],
    ["GET", "/_api/data/user/:key", "getUser"],
    ["DELETE", "/_api/data/user/:key", "deleteUser"],
    ["GET", "/_api/data/user", "listUser"],
    ["POST", "/_api/data/collections/:name", "postCollection"],
    ["GET", "/_api/data/shared/:key", "getShared"],
    ["PUT", "/_api/data/shared/:key", "putShared"],
  ] as const) {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        if (req.hostClass.kind === "app" && dataHandlers) {
          await dataHandlers[name](req, reply, req.hostClass.slug);
          return;
        }
        sendNotFound(reply);
      },
    });
  }

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
