import { readFileSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig, publicOrigin } from "./config.js";
import { createBlobReader } from "./blob/client.js";
import { LiveRegistry, type RegistryLogger } from "./registry/listener.js";
import { OpenIdConnectClient } from "./auth/oidc.js";
import { PgSessionStore, startSessionSweeper } from "./auth/sessions.js";
import { EnvSecretProvider } from "./gateway/secrets-provider.js";
import { AnthropicProvider, type LlmProvider } from "./gateway/provider.js";
import { PgUsageStore, type UsageStore } from "./gateway/usage.js";
import { PgAppDataStore, type AppDataStore } from "./gateway/data.js";
import { IpRateLimiter } from "./gateway/ipRateLimiter.js";
import { PgCspReportStore } from "./serving/cspReport.js";

/**
 * Dev convenience: load `apps/edge/.env.local` (gitignored) into process.env
 * before config, so the vendor key need not be exported by hand. Real env wins
 * — a value already set is never overwritten. Hand-rolled (no `dotenv`): the
 * edge is dependency-minimal (project plan §6).
 */
function loadDotEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    return; // absent is normal (prod, CI)
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnvLocal();

// Bind 0.0.0.0 — inside the container the port is reached across the Docker
// network / forwarded to the host.
const port = Number(process.env.EDGE_PORT ?? process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const config = loadConfig();
const blob = createBlobReader(config.blob);

// Dev TLS termination (mkcert): `__Host-` cookies require Secure, so the real
// cookie model must run locally (project plan §3). Prod stays plain HTTP
// behind Azure ingress and leaves `tls` unset.
let https: { cert: Buffer; key: Buffer } | null = null;
if (config.tls) {
  try {
    https = {
      cert: readFileSync(config.tls.certFile),
      key: readFileSync(config.tls.keyFile),
    };
  } catch (err) {
    throw new Error(
      "EDGE_TLS_* points at unreadable files — re-run .devcontainer/post-create.sh " +
        "to generate the mkcert certs",
      { cause: err },
    );
  }
}

// The registry logs through the app's logger, but buildApp needs the registry
// — bridge the cycle with a late-bound reference.
const logRef: { current: RegistryLogger } = {
  current: { info: () => {}, warn: () => {} },
};
const registry = new LiveRegistry({
  databaseUrl: config.databaseUrl,
  reconcileIntervalMs: config.reconcileIntervalMs,
  log: {
    info: (msg) => logRef.current.info(msg),
    warn: (obj, msg) => logRef.current.warn(obj, msg),
  },
});

// Auth stack — only when the config block is present (fail-closed otherwise).
const sessions = config.auth ? new PgSessionStore(config.databaseUrl) : null;
const oidc = config.auth
  ? new OpenIdConnectClient(config.auth, `${publicOrigin(config, "auth")}/callback`, {
      info: (msg) => logRef.current.info(msg),
      warn: (obj, msg) => logRef.current.warn(obj, msg),
    })
  : null;

// LLM gateway (M4). The metering/budget ledger comes up with the auth stack
// (the capability requires a session); the vendor provider only when a key is
// configured (otherwise the capability 503s — fail-closed, like auth).
const usage: UsageStore | null = config.auth ? new PgUsageStore(config.databaseUrl) : null;
// App-data capability (app-data design §3): comes up with the auth stack, like
// the meter — every data verb is gated and caller-scoped.
const appData: AppDataStore | null = config.auth ? new PgAppDataStore(config.databaseUrl) : null;
// CSP report sink (§6.2) — append-only, no auth needed; always on (the edge
// always has a DB connection for the registry).
const cspReports = new PgCspReportStore(config.databaseUrl);
const secrets = new EnvSecretProvider();
const llmProvider: LlmProvider | null = secrets.has("anthropic")
  ? new AnthropicProvider({
      endpoint: config.llm.endpoint,
      anthropicVersion: config.llm.anthropicVersion,
      apiKey: secrets.vendorKey("anthropic"),
    })
  : null;

// Anonymous-tier per-IP gateway limiter (app-data design §7). Owned here so it
// can be swept on an interval; passed into the app for both gateway handlers.
const anonRateLimiter = new IpRateLimiter(config.anonRateLimit);

const app = buildApp({
  config,
  registry,
  blob,
  sessions,
  oidc,
  llmProvider,
  usage,
  appData,
  cspReports,
  anonRateLimiter,
  https,
});
logRef.current = {
  info: (msg) => app.log.info(msg),
  warn: (obj, msg) => app.log.warn(obj, msg),
};
const sweeper = sessions
  ? startSessionSweeper(sessions, {
      log: {
        info: (msg) => app.log.info(msg),
        warn: (obj, msg) => app.log.warn(obj, msg),
      },
    })
  : null;
// Drop elapsed per-IP buckets once per window so the map can't grow under a
// flood of distinct source IPs. `unref` so it never holds the process open.
const anonSweep =
  anonRateLimiter.enabled && config.anonRateLimit.windowMs > 0
    ? setInterval(() => anonRateLimiter.sweep(), config.anonRateLimit.windowMs)
    : null;
anonSweep?.unref();
app.addHook("onClose", async () => {
  sweeper?.stop();
  if (anonSweep) clearInterval(anonSweep);
  oidc?.stop();
  await registry.stop();
  await sessions?.close();
  await usage?.close();
  await appData?.close();
  await cspReports.close();
  await llmProvider?.close();
  await blob.close();
});

try {
  // First load attempt completes before we accept traffic; a down DB logs and
  // retries rather than blocking boot (LiveRegistry.start never throws, and
  // neither does OIDC discovery — auth routes 503 until it lands).
  await registry.start();
  await oidc?.start();
  await app.listen({ port, host });
  app.log.info(
    {
      baseDomain: config.baseDomain,
      allowUnauthenticated: config.allowUnauthenticated,
      tls: https !== null,
    },
    "azx-edge serving",
  );
  if (config.allowUnauthenticated) {
    app.log.warn("EDGE_DEV_ALLOW_UNAUTHENTICATED is set — app content is served without sessions");
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
