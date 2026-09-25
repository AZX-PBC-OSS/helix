import { readFileSync } from "node:fs";
import { installGracefulShutdown } from "@azx-pbc/shared/lifecycle";
import { startTelemetry } from "@azx-pbc/telemetry";
import { buildApp, SERVICE_NAME } from "./app.js";
import { sweepExpiredConsentAttempts } from "./connections/consent.js";

/**
 * Dev convenience: load `apps/portal/.env.local` (gitignored) into process.env
 * before config. As a developer-local override file (the `.env.local`
 * convention), its values WIN over the inherited environment — so you can
 * repoint the portal at a different IdP (e.g. real Entra) without editing the
 * committed devcontainer env. Absent in prod/CI (it's gitignored), where this
 * is a no-op. Mirrors the edge loader (`apps/edge/src/server.ts`).
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

// Inert unless an OTLP endpoint is configured (ADR-0037). Mirrors the edge:
// after the dotenv load, before the app is built.
const telemetry = startTelemetry(SERVICE_NAME);

const port = Number(process.env.PORTAL_PORT ?? process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

// GC expired consent attempts on an interval (I-02 ADR-0002 §Implementation
// Notes): the egress burn-sweep precedent — unref'd so it never holds the
// process open, cleared in the onClose hook below, and its cadence well
// inside the attempt TTL it retires. No material is involved: an attempt row
// holds protocol state only, so the sweep is a plain portal-role delete.
const CONSENT_SWEEP_INTERVAL_MS = 60_000;
const consentSweep = setInterval(() => {
  void sweepExpiredConsentAttempts(app.prisma).catch((err: unknown) =>
    app.log.warn({ err }, "connection_consent_attempts sweep failed"),
  );
}, CONSENT_SWEEP_INTERVAL_MS);
consentSweep.unref();

// `buildApp()`'s plugins already close Prisma (`plugins/prisma.ts`) and the
// directory client (`plugins/directory.ts`) in this hook; this adds the
// telemetry flush to it (ADR-0037 decision 5), and stops the consent sweep.
app.addHook("onClose", async () => {
  clearInterval(consentSweep);
  await telemetry.shutdown();
});

// SIGTERM (revision swaps, scale-in) / SIGINT (Ctrl-C): drain in-flight
// requests and run the onClose hook above (Prisma + directory close in
// buildApp's plugins), bounded by a hard deadline. Default 10 s, a third of
// Container Apps' documented 30 s SIGTERM-to-SIGKILL window; SHUTDOWN_GRACE_MS
// overrides. (`@azx-pbc/shared/lifecycle`, not the barrel — the barrel is
// browser-consumed.)
installGracefulShutdown(app, app.log);

try {
  await app.listen({ port, host });
  // The portal used to boot in silence, so the first question in any incident —
  // "did the new revision come up, and with what config?" — had no answer for
  // it at all. Its `assertDeploymentConfig()` and `assertBundleLimits()` gates
  // succeed invisibly; this is where that becomes visible.
  app.log.info(
    {
      event: "boot.serving",
      service: SERVICE_NAME,
      port,
      telemetry: telemetry.enabled,
    },
    `${SERVICE_NAME} serving`,
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
