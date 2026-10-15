import { readFileSync } from "node:fs";
import { installGracefulShutdown, resolveServicePort } from "@azx-pbc/shared/lifecycle";
import { startTelemetry } from "@azx-pbc/telemetry";
import { buildApp, SERVICE_NAME } from "./app.js";
import { loadJobsConfig } from "./config.js";
import { describeDsn } from "./dsn.js";
import type { JobsStorageLogger } from "./storage.js";
import { JobsStorage } from "./storage.js";

/**
 * Dev convenience: load `apps/jobs/.env.local` (gitignored) into process.env
 * before config. As a developer-local override file (the `.env.local`
 * convention), its values WIN over the inherited environment. Absent in
 * prod/CI (it's gitignored), where this is a no-op. Mirrors the edge loader
 * (`apps/edge/src/server.ts`).
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

// Inert unless an OTLP endpoint is configured (ADR-0037). Mirrors the siblings:
// after the dotenv load, before anything it might instrument. Inject-only —
// extracting a caller's trace context waits until a caller is authenticated
// (background-jobs-plane §9); nothing here is authenticated yet.
const telemetry = startTelemetry(SERVICE_NAME);

// Bind 0.0.0.0 — inside the container the port is reached across the Docker
// network / forwarded to the host.
const port = resolveServicePort(process.env, ["JOBS_PORT", "PORT"], 3003);
const host = process.env.HOST ?? "0.0.0.0";

// An invalid or missing credential is an explicit startup error: the throw
// crashes the boot with the key named (design §8), before anything listens.
const config = loadJobsConfig();

// The storage lifecycle owns the store connection and its readiness probes.
// Its logging rides a late-bound ref, like the edge's registry: the logger the
// supervisor reports through does not exist until buildApp creates it, and the
// ref is rebound before the first probe can complete a transition.
const logRef: { current: JobsStorageLogger } = {
  current: { info: () => {}, warn: () => {}, error: () => {} },
};
const storage = new JobsStorage({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  log: {
    info: (obj, msg) => logRef.current.info(obj, msg),
    warn: (obj, msg) => logRef.current.warn(obj, msg),
    error: (obj, msg) => logRef.current.error(obj, msg),
  },
});

const app = buildApp({ storage });
logRef.current = app.log;

// The health-first boot contract: the listener comes up before the store is
// usable, `/health` reports the store's state honestly while the bounded
// retries continue, and shutdown releases what startup acquired — the probes'
// timer, the pool, then the telemetry flush (ADR-0009).
app.addHook("onClose", async () => {
  await storage.stop();
  await telemetry.shutdown();
});

// SIGTERM (revision swaps, scale-in) / SIGINT (Ctrl-C): drain in-flight
// requests and run the onClose hook above, bounded by a hard deadline. Default
// 10 s, a third of Container Apps' documented 30 s SIGTERM-to-SIGKILL window;
// SHUTDOWN_GRACE_MS overrides. (`@azx-pbc/shared/lifecycle`, not the barrel —
// that one is browser-consumed.)
installGracefulShutdown(app, app.log);

try {
  storage.start();
  await app.listen({ port, host });
  app.log.info(
    {
      event: "boot.serving",
      service: SERVICE_NAME,
      port,
      serverId: config.serverId,
      store: describeDsn(config.databaseUrl),
      telemetry: telemetry.enabled,
    },
    `${SERVICE_NAME} serving`,
  );
} catch (err) {
  app.log.error(err);
  // The listener never came up — the failed-partial-initialization exit.
  // storage.start() has already acquired the pool; release it here, not
  // only on the shutdown path, bounded by the pool's own connect timeout.
  await storage.stop();
  process.exit(1);
}
