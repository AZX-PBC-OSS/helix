import { readFileSync } from "node:fs";
import {
  developerLocalOverridesSkipped,
  installGracefulShutdown,
  resolveServicePort,
} from "@azx-pbc/shared/lifecycle";
import { startTelemetry } from "@azx-pbc/telemetry";
import { buildApp, SERVICE_NAME } from "./app.js";
import { sweepExpiredConsentAttempts } from "./connections/consent.js";
import { createPrismaClient } from "./db/client.js";
import {
  assertDeliveryTargetsMatch,
  resolveJobsCatalogueServers,
  resolvePortalJobsDeliveryConfig,
} from "./deployment.js";
import { JobsLifecycleDelivery } from "./jobs/delivery.js";
import { HttpLifecycleDelivery } from "./jobs/deliveryHttp.js";

/**
 * Dev convenience: load `apps/portal/.env.local` (gitignored) into process.env
 * before config. As a developer-local override file (the `.env.local`
 * convention), its values WIN over the inherited environment — so you can
 * repoint the portal at a different IdP (e.g. real Entra) without editing the
 * committed devcontainer env. Absent in prod/CI (it's gitignored), where this
 * is a no-op. Mirrors the edge loader (`apps/edge/src/server.ts`).
 */
function loadDotEnvLocal(): void {
  // A resolved stack boots with the stack env authoritative: the
  // developer-local override file is the dev-stack convention, and a resolved
  // stack obeying it would boot cross-wired — silently pointing this
  // service's credentials at the developer's own (the isolation the port
  // offset exists to provide). One home for the flag and its spellings.
  if (developerLocalOverridesSkipped(process.env)) return;
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

const port = resolveServicePort(process.env, ["PORTAL_PORT", "PORT"], 3001);
const host = process.env.HOST ?? "0.0.0.0";

// The boot owns the Prisma client: `buildApp()` returns before Fastify's
// plugins have registered, so `app.prisma` does not exist until `listen`
// resolves — the delivery sender below needs the client at construction (its
// first pass runs at start, before the listener comes up). Created here and
// injected into the app (the plugin then leaves its lifetime to us), it is
// one client for the process, disconnected in the onClose hook below.
const prisma = createPrismaClient();

// The lifecycle-delivery sender (ADR-0007, ADR-0009): the supervised loop
// that delivers the outbox's pending intents to each configured jobs server.
// A jobs-enabled deployment must carry the delivery credentials — a catalogue
// naming a target with no delivery path (or the reverse) is an explicit
// startup error, because a backlog that can never drain must not be created
// quietly. The holder is built before the app (whose `/health` reads it per
// request); the sender itself is built after, against the boot's Prisma
// client, started with the boot below, and stopped on both the shutdown path
// and the failed-startup path.
const delivery: { current: JobsLifecycleDelivery | null } = { current: null };
const deliveryConfig = resolvePortalJobsDeliveryConfig();
assertDeliveryTargetsMatch(resolveJobsCatalogueServers(), deliveryConfig);

const app = buildApp({ prisma, jobsDelivery: () => delivery.current?.snapshot() ?? null });

if (deliveryConfig) {
  const http = new HttpLifecycleDelivery();
  delivery.current = new JobsLifecycleDelivery({
    prisma,
    targets: deliveryConfig,
    transport: (attempt) => http.deliver(attempt),
    log: app.log,
  });
}

// GC expired consent attempts on an interval: the egress burn-sweep precedent —
// unref'd so it never holds the
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

// `buildApp()`'s plugins close the directory client (`plugins/directory.ts`)
// in this hook; the boot-owned Prisma client is disconnected here too (an
// injected client is the caller's lifetime, not the plugin's). This also
// stops the consent sweep, releases the delivery sender's timer and
// in-flight pass, and flushes telemetry (ADR-0037 decision 5). The sender
// releases before the client it uses.
app.addHook("onClose", async () => {
  await delivery.current?.stop();
  clearInterval(consentSweep);
  await prisma.$disconnect();
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
  delivery.current?.start();
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
      lifecycleDelivery: deliveryConfig !== null,
    },
    `${SERVICE_NAME} serving`,
  );
} catch (err) {
  app.log.error(err);
  // The listener never came up — the failed-partial-initialization exit. The
  // sender (if jobs is configured) has already acquired its timer and may
  // hold an in-flight pass; release it here, not only on the shutdown path.
  await delivery.current?.stop();
  process.exit(1);
}
