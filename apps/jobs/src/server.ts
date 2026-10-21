import { readFileSync } from "node:fs";
import {
  developerLocalOverridesSkipped,
  installGracefulShutdown,
  resolveServicePort,
} from "@azx-pbc/shared/lifecycle";
import { JOBS_DIAGNOSTIC_QUALIFIED_TYPE, JOBS_FETCH_QUALIFIED_TYPE } from "@azx-pbc/shared";
import { startTelemetry } from "@azx-pbc/telemetry";
import { buildApp, SERVICE_NAME } from "./app.js";
import { JobsAcceptanceStore } from "./acceptance.js";
import { JobsInstructionBurns } from "./burns.js";
import { JobsCancellationStore } from "./cancellation.js";
import { JobsCleanup } from "./cleanup.js";
import { loadJobsConfig } from "./config.js";
import { jobsInstalledTypePolicies, makeDiagnosticJobHandler } from "./diagnostics.js";
import { describeDsn } from "./dsn.js";
import { JobsExecution, JobsHandlerRegistry } from "./execution.js";
import { makeFetchJobHandler } from "./fetchJob.js";
import { JobsIntake } from "./intake.js";
import { createJobsInstructionAuth } from "./instructionAuth.js";
import { JobsLifecycleStore } from "./lifecycle.js";
import { JobsObservationStore } from "./observation.js";
import { JobsRunner } from "./runner.js";
import { JobsRecovery } from "./recovery.js";
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
const lateLog = {
  info: (obj: Record<string, unknown>, msg: string) => logRef.current.info(obj, msg),
  warn: (obj: Record<string, unknown>, msg: string) => logRef.current.warn(obj, msg),
  error: (obj: Record<string, unknown>, msg: string) => logRef.current.error(obj, msg),
};
const storage = new JobsStorage({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  log: lateLog,
});

// The durable nonce store for instruction replay protection — this service's
// own database, its own sweep loop. Same late-bound logger.
const burns = new JobsInstructionBurns({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  log: lateLog,
});

// The durable app-lifecycle authority — the admission/start gate's state and
// the lifecycle delivery's apply-before-acknowledge receiver. Same late-bound
// logger; no loop of its own.
const lifecycle = new JobsLifecycleStore({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  log: lateLog,
});

// The installed policy set — the composition's one registry of execution
// policies, read by registration, dispatch, admission, the start gate and
// the recovery sweeper alike. Production installs the outbound fetch type
// only; when `JOBS_DIAGNOSTICS` is on (impossible in production — the config
// loader refuses it), the non-production diagnostic type joins the set and
// its handler is registered below.
const typePolicies = jobsInstalledTypePolicies({ diagnostics: config.diagnostics });

// The handler registry — the dispatch's repertoire, screened against the
// installed policy set. The fetch handler gets this server's minting key and
// the two signed callback destinations (selected by the job's signed
// environment tier at dispatch time); a dispatched job with no handler is
// answered with the terminal platform error.
const handlers = new JobsHandlerRegistry(typePolicies);
handlers.register(
  JOBS_FETCH_QUALIFIED_TYPE,
  makeFetchJobHandler({
    serverId: config.serverId,
    prodCallbackUrl: config.edgeProdCallbackUrl,
    devCallbackUrl: config.edgeDevCallbackUrl,
    jobsToEdgeKey: config.jobsToEdgeKey,
    log: lateLog,
  }),
);
if (config.diagnostics) {
  handlers.register(JOBS_DIAGNOSTIC_QUALIFIED_TYPE, makeDiagnosticJobHandler());
}

// The execution seam — the worker registration and the attempt projection
// (progress, outcomes, results) into the wrapper record. Its pool serves the
// attempts' writes; the worker itself lives on the runner's instance.
const execution = new JobsExecution({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  handlers,
  limits: config.limits,
  log: lateLog,
});

// The runtime runner — the one pg-boss instance, whose supervised start
// converges once the store is usable. Its enqueue rides the acceptance
// transaction; its worker registration is the execution seam's.
const runner = new JobsRunner({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  registerWorker: async (boss) => {
    await execution.registerOn(boss);
  },
  log: lateLog,
});

// The recovery sweeper — the interruption-recovery loop that reconciles the
// non-terminal wrapper records against the runner rows' own state, enforces
// the absolute deadline and carries a pending owner/lifecycle cancellation
// to its terminal outcome. Its runner-row reads ride the runner's instance
// through the jobState seam; its re-drives of a pending cancellation ride
// the same instance through the runner's fenced cancel; its writes ride its
// own pool.
const recovery = new JobsRecovery({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  readRunnerJob: (runnerJobId) => runner.jobState(runnerJobId),
  cancelRunnerJob: (runnerJobId) => runner.cancelJob(runnerJobId),
  typePolicies,
  log: lateLog,
});

// The owner-cancellation store — the durable intent write (the
// acknowledgement's basis) plus the runner drive, in that order. Its runner
// cancel rides the runner's instance through the same fenced seam the
// sweeper re-drives through.
const cancellation = new JobsCancellationStore({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  cancelRunnerJob: (runnerJobId) => runner.cancelJob(runnerJobId),
  log: lateLog,
});

// The intake applier — the configured intake posture made durable: one
// apply at boot (retried while the store is down) that closes or opens new
// work under the same admission lock the enqueues take, so no in-flight
// enqueue is retroactively refused. Its snapshot is the jobs_intake health
// check's input.
const intake = new JobsIntake({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  serverId: config.serverId,
  accepting: config.accepting,
  log: lateLog,
});

// The acceptance store — the durable retry identity, the capacity limits'
// enforcement and the transaction that commits the wrapper record with the
// runner's enqueue (ADR-0003). Its new-work decisions honor both this
// process's configured posture and the durable intake row the applier above
// writes.
const admission = new JobsAcceptanceStore({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  limits: config.limits,
  accepting: config.accepting,
  typePolicies,
  enqueuer: runner.enqueuer,
  log: lateLog,
});

// The observation store — the owner-scoped status/result reads, projected
// against the logical public-read horizons. Read-only: polling never
// mutates execution.
const observation = new JobsObservationStore({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  log: lateLog,
});

// The cleanup loop — the retention contract's physical half: expired results
// removed from live storage at the seven-day horizon, terminal records
// retired together with their runner rows and retry mappings at the
// thirty-day horizon, each within the 48-hour removal bound (including after
// a restoration). Its record arm's runner-row deletes ride the runner's
// instance through the borrowed-connection adapter; its measurement feeds
// the jobs_capacity and jobs_cleanup health checks.
const cleanup = new JobsCleanup({
  databaseUrl: config.databaseUrl,
  statementTimeoutMs: config.statementTimeoutMs,
  deleteRunnerRows: runner.deleter,
  log: lateLog,
});

const app = buildApp({
  storage,
  instructions: createJobsInstructionAuth({
    serverId: config.serverId,
    keys: { edgeToJobs: config.edgeToJobsKey, portalToJobs: config.portalToJobsKey },
    burns,
    log: lateLog,
  }),
  lifecycle,
  admission,
  cancellation,
  observation,
  worker: () => runner.snapshot,
  recovery: () => recovery.snapshot(),
  cleanup: () => cleanup.snapshot(),
  intake: () => intake.snapshot(),
  capacityLimits: config.limits,
});
logRef.current = app.log;

if (config.diagnostics) {
  app.log.warn(
    { event: "jobs.diagnostics.enabled", type: JOBS_DIAGNOSTIC_QUALIFIED_TYPE },
    "the non-production diagnostic job type is registered",
  );
}

// The health-first boot contract: the listener comes up before the store is
// usable, `/health` reports the store's state honestly while the bounded
// retries continue, and shutdown releases what startup acquired — the
// recovery sweeper's pool and timer, the cancellation store's pool, the
// cleanup loop's pool and timer, the observation store's pool, the runner
// instance and its retry timer, the execution store's pool, the intake
// applier's pool and timer, the acceptance store's pool, the lifecycle pool,
// the sweep timer and pool, the probes' timer and pool, then the telemetry
// flush (ADR-0009). The sweeper, the cancellation store and the cleanup loop
// release before the runner: all three drive runner operations through the
// runner's instance.
app.addHook("onClose", async () => {
  await recovery.stop();
  await cancellation.stop();
  await cleanup.stop();
  await runner.stop();
  await execution.stop();
  await intake.stop();
  await admission.stop();
  await observation.stop();
  await lifecycle.stop();
  await burns.stop();
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
  burns.start();
  lifecycle.start();
  execution.start();
  runner.start();
  recovery.start();
  cancellation.start();
  cleanup.start();
  intake.start();
  admission.start();
  observation.start();
  await app.listen({ port, host });
  app.log.info(
    {
      event: "boot.serving",
      service: SERVICE_NAME,
      port,
      serverId: config.serverId,
      accepting: config.accepting,
      diagnostics: config.diagnostics,
      store: describeDsn(config.databaseUrl),
      telemetry: telemetry.enabled,
    },
    `${SERVICE_NAME} serving`,
  );
} catch (err) {
  app.log.error(err);
  // The listener never came up — the failed-partial-initialization exit.
  // storage.start(), burns.start(), lifecycle.start(), execution.start(),
  // runner.start(), recovery.start(), cancellation.start(), cleanup.start(),
  // intake.start(), admission.start() and observation.start() have already
  // acquired their resources; release them here, not only on the shutdown
  // path, bounded by each pool's own connect timeout.
  await recovery.stop();
  await cancellation.stop();
  await cleanup.stop();
  await runner.stop();
  await execution.stop();
  await intake.stop();
  await admission.stop();
  await observation.stop();
  await lifecycle.stop();
  await burns.stop();
  await storage.stop();
  process.exit(1);
}
