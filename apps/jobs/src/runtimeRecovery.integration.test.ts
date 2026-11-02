import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  HealthStatusSchema,
  JOBS_DATABASE_CHECK,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_INTAKE_CHECK,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_REACHABILITY_CHECK,
  JOBS_SERVICE_NAME,
  JOBS_SWEEPER_CHECK,
  JOB_TERMINAL_STATUSES,
  JOBS_WORKER_CHECK,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type App,
  type HealthCheck,
  type HealthStatus,
  type JobAccepted,
  type JobSnapshot,
} from "@azx-pbc/shared";
import {
  ATTR_OUTCOME,
  INSTR_JOBS_STORAGE_PROBES,
  SPAN_JOBS_EXECUTE,
} from "@azx-pbc/shared/telemetry";

import { type DiagnosticJobInput } from "./diagnostics.js";
import { JOBS_INTAKE_QUALIFIED, JOBS_SCHEMA } from "./policy.js";
import {
  createLiveApp,
  serviceLaunch,
  startJsonOrigin,
  startRealStack,
  startTcpFaultRelay,
  waitFor,
  type AppSession,
  type ControlledJsonOrigin,
  type HttpReply,
  type PortalClient,
  type RealStack,
  type StackServiceName,
  type TcpFaultRelay,
} from "./test/realStack.js";

/**
 * Runtime recovery for the jobs plane, through the REAL running platform (dev
 * IdP, portal, egress, jobs, edge — all child processes; real Postgres; real
 * signed HTTP hops):
 *
 * 1. missing/invalid configuration is an explicit startup error naming the
 *    key, a failed partial startup releases what it acquired (proved with the
 *    exit-audit preload — with a leak the process reports `held`, never
 *    `drained`), and a fully disabled installation keeps ordinary hosting
 *    working with no jobs surface at all;
 * 2. storage absent, then schema-incompatible, at startup: honest `/health`
 *    bodies (always HTTP 200, the BODY carries the failure), bounded 503s on
 *    the edge, and recovery WITHOUT a restart and WITHOUT losing accepted
 *    work;
 * 3. a store that dies under a running service is reported within seconds of
 *    the first failed request (the request-driven re-probe, not the 30 s
 *    steady cadence), the maintenance loops go stale and say so, delivery lag
 *    degrades the PORTAL's check after 60 s while the jobs-side check only
 *    ever speaks for staleness — and all of it recovers;
 * 4. closed intake refuses new work 503 `jobs_disabled` while reads, the
 *    health body and the reopened intake stay honest;
 * 5. configured OTLP, an unreachable endpoint, no endpoint and
 *    `OTEL_SDK_DISABLED=1` all execute work, report honest health and shut
 *    down clean;
 * 6. SIGTERM of the jobs process, launched exactly as the production image
 *    launches it, drains inside the 10 s grace window with work in flight and
 *    leaves nothing holding the event loop.
 *
 * The bounds are the measured ones from this stack: the edge's reachability
 * probe runs every 30 s, the recovery sweeper's staleness bound is 45 s, the
 * portal's delivery cadence is 15 s with a 60 s overdue bound, the store's
 * retry backoff is 1 s doubling capped at 30 s, and every stop's grace is
 * 10 s. Each wait is bounded through the harness's `waitFor`; no wait depends
 * on a bare sleep. The per-app edge submission throttle (10 per minute,
 * refusals included) is budgeted: one submission per test that submits, per
 * phase, never a submit loop.
 *
 * The tests run sequentially in file order and share one stack; each leaves
 * the stack healthy (services running, env overrides restored) for the next.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let bob: PortalClient;
let alice: PortalClient;
/** Jobs-owner pool for the durable facts no route exposes (the intake rename). */
let jobsDb: Pool;
let origin: ControlledJsonOrigin;
let relay: TcpFaultRelay | null = null;

type AppKey = "boot" | "outage" | "archive" | "modes" | "image";
const apps = {} as Record<AppKey, { app: App; slug: string }>;
const sessions = {} as Record<AppKey, AppSession>;

/** Job B from the outage test — its snapshot is the read that keeps working while intake is closed. */
let jobBId: string | undefined;

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── small helpers ────────────────────────────────────────────────────────────

const SUBMIT_PATH_DIAGNOSTIC = "/_api/jobs/jobs/types/diagnostic";
const SUBMIT_PATH_FETCH = "/_api/jobs/jobs/types/fetch";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

/** The app-host session is the only client kind this suite submits through. */
type ApiClient = AppSession;

/** The exit-audit marker literal — exitAudit.ts is never imported (importing it would patch THIS process's process.exit). */
const EXIT_AUDIT_MARKER = "[helix-exit-audit]";

const exitAuditPath = fileURLToPath(new URL("./test/exitAudit.ts", import.meta.url));

/** The NODE_OPTIONS value that preloads the exit audit into a service's next start. */
const auditNodeOptions = (): string => `--import=${exitAuditPath}`;

interface ExitAuditRecord {
  outcome: "drained" | "held" | "exited";
  code?: number;
  requested?: number | null;
  resources?: string[];
}

/** The LAST `[helix-exit-audit]` record in the service's log — the most recent audited run's outcome. */
function exitAuditRecord(name: StackServiceName): ExitAuditRecord {
  const tail = stack.logTail(name, 400);
  const lines = tail.split("\n").filter((line) => line.includes(EXIT_AUDIT_MARKER));
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error(`the ${name} log tail carries no ${EXIT_AUDIT_MARKER} marker`);
  }
  const json = last.slice(last.indexOf(EXIT_AUDIT_MARKER) + EXIT_AUDIT_MARKER.length).trim();
  return JSON.parse(json) as ExitAuditRecord;
}

/** One health read, asserting the always-200 contract EVERY time — the body alone carries the state. */
async function healthOf(name: "jobs" | "portal" | "edge"): Promise<HealthStatus> {
  const url =
    name === "jobs"
      ? `http://localhost:${stack.ports.jobs}/health`
      : name === "portal"
        ? `${stack.portalUrl}/health`
        : `https://${stack.baseDomain}:${stack.ports.edge}/health`;
  const res = await stack.request(url);
  expect(res.status, `the ${name} /health answers HTTP 200 in every state`).toBe(200);
  return HealthStatusSchema.parse(res.json());
}

/** One named sub-check of a health body — throws when absent, never a silent undefined. */
function check(body: HealthStatus, name: string): HealthCheck {
  const found = body.checks?.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(
      `the ${body.service} health body carries no ${name} check: ${JSON.stringify(body.checks)}`,
    );
  }
  return found;
}

/** The jobs service's runtime DSN repointed at the relay: same credentials and database, the relay's loopback port. */
function relayDsn(faultRelay: TcpFaultRelay): string {
  const dsn = new URL(stack.jobsRuntimeDsn);
  dsn.hostname = "127.0.0.1";
  dsn.port = String(faultRelay.port);
  return dsn.toString();
}

/** Run one call and report how long it took — for the bounded-refusal measurements. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - startedAt };
}

/** One free loopback port nothing listens on (claimed by binding port 0, then released). */
async function claimDeadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

// ── OTLP/JSON capture parsing ────────────────────────────────────────────────

/**
 * The resource-attribute key the exporters emit for the service identity. It
 * is the OTLP wire key (the semantic-conventions name), not a platform
 * constant — the platform constant is its VALUE, `JOBS_SERVICE_NAME`.
 */
const SERVICE_NAME_WIRE_KEY = "service.name";

type OtlpAttributes = ReadonlyArray<{ key?: unknown; value?: { stringValue?: unknown } }>;

function attrText(attributes: unknown, key: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const entry of attributes as OtlpAttributes) {
    if (entry.key === key && typeof entry.value?.stringValue === "string") {
      return entry.value.stringValue;
    }
  }
  return undefined;
}

/** The `service.name` resource attribute an OTLP/JSON payload carries, of either signal. */
function payloadServiceName(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = parsed as {
    resourceSpans?: Array<{ resource?: { attributes?: unknown } }>;
    resourceMetrics?: Array<{ resource?: { attributes?: unknown } }>;
  };
  for (const rs of record.resourceSpans ?? []) {
    const name = attrText(rs.resource?.attributes, SERVICE_NAME_WIRE_KEY);
    if (name !== undefined) return name;
  }
  for (const rm of record.resourceMetrics ?? []) {
    const name = attrText(rm.resource?.attributes, SERVICE_NAME_WIRE_KEY);
    if (name !== undefined) return name;
  }
  return undefined;
}

function spanNamesIn(body: string): string[] {
  const parsed = JSON.parse(body) as {
    resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ name?: unknown }> }> }>;
  };
  const names: string[] = [];
  for (const rs of parsed.resourceSpans ?? []) {
    for (const scope of rs.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        if (typeof span.name === "string") names.push(span.name);
      }
    }
  }
  return names;
}

/** Does one OTLP/JSON metrics payload carry the instrument with a data point attributed `key = value`? */
function metricHasDataPoint(body: string, instrument: string, key: string, value: string): boolean {
  const parsed = JSON.parse(body) as {
    resourceMetrics?: Array<{
      scopeMetrics?: Array<{
        metrics?: Array<{
          name?: unknown;
          sum?: { dataPoints?: Array<{ attributes?: unknown }> };
        }>;
      }>;
    }>;
  };
  for (const rm of parsed.resourceMetrics ?? []) {
    for (const scope of rm.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        if (metric.name !== instrument) continue;
        for (const point of metric.sum?.dataPoints ?? []) {
          if (attrText(point.attributes, key) === value) return true;
        }
      }
    }
  }
  return false;
}

/**
 * The running count of captured payloads whose resource names the jobs
 * service. Each payload is parsed exactly once (a cursor over the capture's
 * live array), so per-mode baselines never re-scan the whole capture.
 */
let jobsPayloadCursor = 0;
let jobsPayloadTotal = 0;
function jobsPayloadsSoFar(): number {
  const capture = stack.telemetry;
  if (capture === null) throw new Error("the stack was not started with a telemetry capture");
  while (jobsPayloadCursor < capture.payloads.length) {
    const payload = capture.payloads[jobsPayloadCursor];
    jobsPayloadCursor += 1;
    if (payload !== undefined && payloadServiceName(payload.body) === JOBS_SERVICE_NAME) {
      jobsPayloadTotal += 1;
    }
  }
  return jobsPayloadTotal;
}

// ── drivers over the harness clients (copied from lifecycleCancellation) ─────

/** One submission attempt — the exact bytes and key a retry of this submit would reuse. */
function submitOnce(
  client: ApiClient,
  path: string,
  input: unknown,
  key: string,
): Promise<HttpReply> {
  return client.api("POST", path, {
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(input),
  });
}

/**
 * Submit until the acceptance commits: a retryable 503 keeps polling (the
 * same key and bytes every time — the keyed-retry rule), anything else
 * non-202 fails loudly quoting the status and body.
 */
async function submitDiagnostic(
  client: ApiClient,
  input: DiagnosticJobInput,
): Promise<JobAccepted> {
  const key = `rr-${randomUUID()}`;
  let last = "<none>";
  return waitFor(
    stack,
    () => `the diagnostic submission to be accepted — last answer: ${last}`,
    // One attempt per 7 s: refusals count against the per-app throttle of 10
    // submissions a minute.
    { timeoutMs: 60_000, pollMs: 7_000 },
    async () => {
      const res = await submitOnce(client, SUBMIT_PATH_DIAGNOSTIC, input, key);
      last = `${res.status} ${res.text.slice(0, 300)}`;
      if (res.status === 503) return undefined;
      if (res.status !== 202) {
        throw new Error(
          `the diagnostic submission was refused: ${res.status} ${res.text.slice(0, 400)}`,
        );
      }
      return JobAcceptedSchema.parse(res.json());
    },
  );
}

/**
 * Poll the snapshot until `until` holds. Every poll is parsed against the
 * wire schema; a retryable 503 keeps polling inside the same bound (an
 * observation failure is never an execution failure); anything else non-200
 * fails loudly.
 */
async function pollSnapshot(
  api: AppSession["api"],
  jobId: string,
  until: (snapshot: JobSnapshot) => boolean,
  timeoutMs: number,
): Promise<JobSnapshot> {
  let last: JobSnapshot | undefined;
  return waitFor(
    stack,
    () => `job ${jobId} — last snapshot: ` + (last === undefined ? "<none>" : JSON.stringify(last)),
    { timeoutMs },
    async () => {
      const res = await api("GET", statusPath(jobId));
      if (res.status === 503) return undefined;
      expect(res.status, `status poll of job ${jobId}`).toBe(200);
      last = JobSnapshotSchema.parse(res.json());
      return until(last) ? last : undefined;
    },
  );
}

/** Wait until the job runs with at least one reported step. */
async function pollUntilRunning(
  api: AppSession["api"],
  jobId: string,
  minStep: number,
): Promise<JobSnapshot> {
  return pollSnapshot(
    api,
    jobId,
    (s) => s.status === "running" && (s.progress?.step ?? 0) >= minStep,
    60_000,
  );
}

// ── setup helpers (copied from lifecycleCancellation) ────────────────────────

/**
 * Save an app's capabilities with exactly the jobs types given (and no fetch
 * origins) — the SPA capability editor's save body for these choices. A jobs
 * type is a baseline grant, so the save applies directly with no pending
 * approval.
 */
async function saveCapabilities(slug: string, jobTypes: readonly string[]): Promise<void> {
  const capabilities: {
    mcp: string[];
    externalOrigins: string[];
    fetch: { shim: boolean; origins: string[] };
    jobs?: { types: string[] };
  } = { mcp: [], externalOrigins: [], fetch: { shim: false, origins: [] } };
  if (jobTypes.length > 0) capabilities.jobs = { types: [...jobTypes] };
  const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, { capabilities });
  expect(saved.status, `the manifest save for ${slug}`).toBe(200);
  const saveResult = ManifestUpdateResultSchema.parse(saved.json());
  expect(saveResult.pending ?? null, `the manifest save for ${slug} applied directly`).toBeNull();
}

/** Create, deploy and promote an app, then grant it ONLY the diagnostic type. */
async function createDiagnosticApp(purpose: AppKey): Promise<{ app: App; slug: string }> {
  const slug = `rr-${purpose}-${randomUUID().slice(0, 8)}`;
  const app = await createLiveApp(stack, bob, {
    slug,
    files: {
      "index.html":
        '<!doctype html><html><head><meta charset="utf-8"><title>runtime recovery</title></head>' +
        `<body><p>recovery-${purpose}</p></body></html>`,
    },
  });
  await saveCapabilities(slug, [JOBS_DIAGNOSTIC_QUALIFIED_TYPE]);
  return { app, slug };
}

/** Create the test-6 image app: the fetch type (baseline) plus a keyless fetch origin (elevated — alice approves). */
async function createImageApp(): Promise<{ app: App; slug: string }> {
  const slug = `rr-image-${randomUUID().slice(0, 8)}`;
  const app = await createLiveApp(stack, bob, {
    slug,
    files: {
      "index.html":
        '<!doctype html><html><head><meta charset="utf-8"><title>runtime recovery image</title></head>' +
        "<body><p>recovery-image</p></body></html>",
    },
  });
  const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, {
    capabilities: {
      mcp: [],
      externalOrigins: [],
      fetch: { shim: false, origins: [{ origin: origin.origin }] },
      jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] },
    },
  });
  expect(saved.status, "the image app's grant save").toBe(200);
  const saveResult = ManifestUpdateResultSchema.parse(saved.json());
  const pendingId = must(saveResult.pending ?? null, "the image app's pending approval id");
  const approved = await alice.post(`/api/v1/approvals/${pendingId}/approve`);
  expect(approved.status, "alice's approval of the image app's fetch origin").toBe(200);
  return { app, slug };
}

// ── lifecycle-delivery waits (the admission gate's precondition) ─────────────

/** The portal `/health` body's lifecycle-delivery check — its graded status and metrics. */
async function deliveryCheckReading(): Promise<HealthCheck> {
  return check(await healthOf("portal"), JOBS_LIFECYCLE_DELIVERY_CHECK);
}

/**
 * Wait — bounded — for the portal's lifecycle-delivery check to read `ok`
 * with every configured target synchronized, from a pass that ended after
 * `passesAfter` was read (so the reading cannot predate new apps). After a
 * portal restart the counter starts again at zero, so callers there omit it.
 */
async function waitForDeliverySynchronized(
  what: string,
  timeoutMs: number,
  passesAfter = -1,
): Promise<void> {
  await waitFor(stack, what, { timeoutMs }, async () => {
    const reading = await deliveryCheckReading();
    const targets = reading.metrics?.targets ?? 0;
    return reading.status === "ok" &&
      (reading.metrics?.passes ?? 0) > passesAfter &&
      targets > 0 &&
      reading.metrics?.synchronizedTargets === targets
      ? true
      : undefined;
  });
}

// ── the suite ────────────────────────────────────────────────────────────────

describe("runtime recovery of the jobs plane, through the real stack", () => {
  beforeAll(async () => {
    stack = await startRealStack({ label: "recovery", diagnostics: true, telemetry: true });
    if (stack.jobsRoots === null)
      throw new Error("the stack never resolved its jobs signing roots");
    if (stack.telemetry === null) throw new Error("the stack never started its telemetry capture");

    bob = await stack.portalAs("bob@azx.dev");
    alice = await stack.portalAs("alice@azx.dev");

    origin = await startJsonOrigin();
    const passesBefore = (await deliveryCheckReading()).metrics?.passes ?? 0;

    for (const key of ["boot", "outage", "archive", "modes"] as const) {
      apps[key] = await createDiagnosticApp(key);
    }
    apps.image = await createImageApp();

    // The jobs service admits an app's work only after the portal delivered
    // that app's lifecycle state to it — wait once, after all the apps exist.
    await waitForDeliverySynchronized(
      "the portal's first delivery pass after the apps' creation to synchronize every target",
      90_000,
      passesBefore,
    );

    for (const key of Object.keys(apps) as AppKey[]) {
      sessions[key] = await stack.appSession(apps[key].slug, "bob@azx.dev");
    }

    jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 2 });
  }, 420_000);

  afterAll(async () => {
    await jobsDb?.end();
    await origin?.close();
    await relay?.close();
    if (stack) await stack.close();
  }, 120_000);

  test(
    "missing or invalid configuration stops each service's boot with the key named, and a failed partial startup releases what it acquired",
    { timeout: 240_000 },
    async () => {
      await stack.stop("jobs");

      // Each misconfiguration is an explicit boot error naming the key — and
      // the error never echoes the OTHER roots' real secret values.
      const roots = must(stack.jobsRoots, "the stack's jobs signing roots");
      const failedBoots: ReadonlyArray<{
        what: string;
        overrides: Record<string, string | null>;
        keyName: string;
      }> = [
        {
          what: "a missing portal→jobs root",
          overrides: { JOBS_PORTAL_TO_JOBS_SECRET: null },
          keyName: "JOBS_PORTAL_TO_JOBS_SECRET",
        },
        {
          what: "a malformed edge→jobs root",
          overrides: { JOBS_EDGE_TO_JOBS_SECRET: "not-a-root" },
          keyName: "JOBS_EDGE_TO_JOBS_SECRET",
        },
        {
          what: "a missing store DSN",
          overrides: { JOBS_DATABASE_URL: null },
          keyName: "JOBS_DATABASE_URL",
        },
      ];
      for (const leg of failedBoots) {
        stack.setServiceEnv("jobs", leg.overrides);
        const boot = await stack.startExpectingExit("jobs", 30_000);
        expect(boot.exitCode, `${leg.what}: the boot's exit code is non-zero`).not.toBe(0);
        expect(boot.exitCode, `${leg.what}: the process exited, it was not killed`).not.toBeNull();
        expect(boot.output, `${leg.what}: the error names the key`).toContain(leg.keyName);
        for (const [direction, root] of Object.entries(roots)) {
          expect(
            boot.output,
            `${leg.what}: the ${direction} root's value is not echoed`,
          ).not.toContain(root);
        }
        await expect(
          stack.request(`http://localhost:${stack.ports.jobs}/health`),
          `${leg.what}: no listener answers after the failed boot`,
        ).rejects.toThrow();
      }

      // A failed PARTIAL initialization — the listener's bind fails after
      // every store started — must release what it acquired. With the exit
      // audit preloaded, a leak reads `held` (resources listed, exit 97);
      // a clean release reads `drained` with the requested code.
      stack.setServiceEnv("jobs", {
        JOBS_PORT: String(stack.ports.portal),
        NODE_OPTIONS: auditNodeOptions(),
      });
      const partial = await stack.startExpectingExit("jobs", 30_000);
      expect(partial.exitCode, "the failed partial startup's exit code").toBe(1);
      const partialAudit = exitAuditRecord("jobs");
      expect(partialAudit.outcome, "the failed partial startup released what it acquired").toBe(
        "drained",
      );
      expect(partialAudit.requested, "the failed partial startup's requested exit code").toBe(1);

      // The same explicitness for the consumers' boot documents.
      await stack.stop("edge");
      stack.setServiceEnv("edge", { EDGE_JOBS_CONFIG: "{not json" });
      const edgeBoot = await stack.startExpectingExit("edge", 30_000);
      expect(edgeBoot.exitCode, "the edge's bad jobs document: non-zero exit").not.toBe(0);
      expect(edgeBoot.output, "the edge's error names EDGE_JOBS_CONFIG").toContain(
        "EDGE_JOBS_CONFIG",
      );

      await stack.stop("portal");
      stack.setServiceEnv("portal", { PORTAL_JOBS_CONFIG: "{not json" });
      const portalBoot = await stack.startExpectingExit("portal", 30_000);
      expect(portalBoot.exitCode, "the portal's bad jobs document: non-zero exit").not.toBe(0);
      expect(portalBoot.output, "the portal's error names PORTAL_JOBS_CONFIG").toContain(
        "PORTAL_JOBS_CONFIG",
      );

      // The fully disabled installation: no jobs documents at all. Started to
      // the listener only — the disabled premise means no jobs check ever
      // appears, so the jobs-keyed readiness predicates never fire.
      stack.setServiceEnv("edge", { EDGE_JOBS_CONFIG: null });
      stack.setServiceEnv("portal", { PORTAL_JOBS_CONFIG: null, PORTAL_JOBS_CATALOGUE: null });
      await stack.start("edge", { until: "listener" });
      await stack.start("portal", { until: "listener" });

      const edgeBody = await healthOf("edge");
      const portalBody = await healthOf("portal");
      for (const [what, body] of [
        ["the edge", edgeBody],
        ["the portal", portalBody],
      ] as const) {
        const jobsChecks = (body.checks ?? []).filter((c) => c.name.startsWith("jobs_"));
        expect(
          jobsChecks.map((c) => c.name),
          `${what}: a disabled installation reports no jobs check at all`,
        ).toEqual([]);
      }
      expect(
        (edgeBody.checks ?? []).some((c) => c.name === JOBS_REACHABILITY_CHECK),
        "the edge body has no jobs_reachability check",
      ).toBe(false);
      expect(
        (portalBody.checks ?? []).some((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK),
        "the portal body has no jobs_lifecycle_delivery check",
      ).toBe(false);

      // Ordinary hosting needs no jobs: the boot app still serves its page…
      const page = await sessions.boot.navigate("/");
      expect(page.status, "the disabled installation still hosts the app").toBe(200);

      // …and the ONE submission a disabled installation accepts is the fixed
      // refusal — 503, never a fabricated acceptance.
      const disabled = await submitOnce(
        sessions.boot,
        SUBMIT_PATH_DIAGNOSTIC,
        { steps: 1 } satisfies DiagnosticJobInput,
        `rr-${randomUUID()}`,
      );
      expect(disabled.status, `the disabled submission: ${disabled.text}`).toBe(503);
      expect(JobRequestErrorSchema.parse(disabled.json()).code).toBe("jobs_disabled");

      // Restore the whole stack for the next tests: the running edge and
      // portal hold the disabled configs, so they must be restarted on the
      // defaults; jobs starts again on its own DSN.
      await stack.stop("edge");
      await stack.stop("portal");
      stack.setServiceEnv("jobs", null);
      stack.setServiceEnv("edge", null);
      stack.setServiceEnv("portal", null);
      await Promise.all([stack.start("jobs"), stack.start("portal")]);
      await stack.start("edge");
      await waitForDeliverySynchronized(
        "the portal's lifecycle delivery check to read synchronized again after the restore",
        90_000,
      );
    },
  );

  test(
    "a temporary stop and a store that is absent, then incompatible, at startup: honest bodies, bounded 503s, recovery without a restart, accepted work kept",
    { timeout: 300_000 },
    async () => {
      const session = sessions.outage;

      // Accepted work in flight before anything fails.
      const a = await submitDiagnostic(session, { steps: 20, stepDelayMs: 1000 });
      await pollUntilRunning(session.api, a.jobId, 1);

      // The temporary stop: a clean drain inside the grace, with the job
      // running — the graceful shutdown's own measured envelope.
      const stopped = await stack.stop("jobs");
      expect(stopped.exitCode, "the temporary stop's exit code").toBe(0);
      expect(stopped.killed, "the temporary stop never needed the grace's SIGKILL").toBe(false);
      expect(stopped.elapsedMs, "the temporary stop drained inside the grace window").toBeLessThan(
        10_000,
      );

      // While stopped, the edge's forwards answer the bounded 503 — never a
      // fabricated 404: a configured outage is not a missing job.
      const down = await timed(() => session.api("GET", statusPath(a.jobId)));
      expect(down.value.status, `the snapshot while stopped: ${down.value.text}`).toBe(503);
      expect(JobRequestErrorSchema.parse(down.value.json()).code).toBe("jobs_unavailable");
      expect(down.ms, "the refusal while stopped answers immediately").toBeLessThan(15_000);

      // The edge's own probe saw the stop.
      await waitFor(
        stack,
        "the edge's jobs_reachability check to read degraded with one unreachable server",
        { timeoutMs: 60_000 },
        async () => {
          const reach = check(await healthOf("edge"), JOBS_REACHABILITY_CHECK);
          return reach.status === "degraded" && reach.metrics?.unreachable === 1 ? true : undefined;
        },
      );

      // Store absent at boot: jobs comes up UNHEALTHY, answering honestly.
      const runtime = new URL(stack.jobsRuntimeDsn);
      relay = await startTcpFaultRelay({
        host: runtime.hostname,
        port: Number(runtime.port),
      });
      relay.cut();
      stack.setServiceEnv("jobs", { JOBS_DATABASE_URL: relayDsn(relay) });
      await stack.start("jobs", { until: "listener" });

      await waitFor(
        stack,
        "the jobs body to name the unreachable store",
        { timeoutMs: 60_000 },
        async () => {
          const body = await healthOf("jobs");
          const db = check(body, JOBS_DATABASE_CHECK);
          return db.status === "error" && (db.detail ?? "").includes("did not answer")
            ? true
            : undefined;
        },
      );
      const absentBody = await healthOf("jobs");
      expect(absentBody.status, "the absent-store body's roll-up").toBe("error");
      expect(check(absentBody, JOBS_DATABASE_CHECK).status).toBe("error");
      expect(check(absentBody, JOBS_WORKER_CHECK).status).toBe("error");

      // The bounded retries are visible and continuing.
      const probesBefore = check(await healthOf("jobs"), JOBS_DATABASE_CHECK).metrics?.probes ?? 0;
      await sleep(3_000);
      const probesAfter = check(await healthOf("jobs"), JOBS_DATABASE_CHECK).metrics?.probes ?? 0;
      expect(
        probesAfter,
        "the storage supervisor's probe count kept increasing while the store was absent",
      ).toBeGreaterThan(probesBefore);

      const absentSnapshot = await timed(() => session.api("GET", statusPath(a.jobId)));
      expect(absentSnapshot.value.status, `the snapshot against the absent store`).toBe(503);
      expect(JobRequestErrorSchema.parse(absentSnapshot.value.json()).code).toBe(
        "jobs_unavailable",
      );
      expect(
        absentSnapshot.ms,
        "the refusal against the absent store answers immediately",
      ).toBeLessThan(15_000);
      // No submission here: the throttle budget is spent on the recovery legs.

      // Schema-incompatible store: the intake table gone by rename — the
      // startup compatibility check's intake_missing verdict, reached through
      // the running service's own probes, with no restart and no route.
      await jobsDb.query(`ALTER TABLE ${JOBS_INTAKE_QUALIFIED} RENAME TO intake_t0046`);
      relay.restore();
      await waitFor(
        stack,
        "the jobs body to name the absent intake store and the migration remedy",
        { timeoutMs: 60_000 },
        async () => {
          const body = await healthOf("jobs");
          const db = check(body, JOBS_DATABASE_CHECK);
          const detail = db.detail ?? "";
          return db.status === "error" &&
            detail.includes("intake store is absent") &&
            detail.includes("run the migration command")
            ? true
            : undefined;
        },
      );
      // The job routes answer 503 while the store reads incompatible, even
      // though the record table this read uses is intact: an operation must
      // not run against a partial schema while /health reports it unusable.
      const incompatibleSnapshot = await timed(() => session.api("GET", statusPath(a.jobId)));
      expect(incompatibleSnapshot.value.status, "the snapshot against the incompatible store").toBe(
        503,
      );
      expect(JobRequestErrorSchema.parse(incompatibleSnapshot.value.json()).code).toBe(
        "jobs_unavailable",
      );
      expect(incompatibleSnapshot.ms).toBeLessThan(15_000);

      // Recovery WITHOUT a restart: rename the table back, and the service's
      // own probes bring it back to ok. The uptime proves the process never
      // restarted — a restarted process's uptime would be near zero.
      const uptimeBeforeRestore = (await healthOf("jobs")).uptime;
      await jobsDb.query(`ALTER TABLE ${JOBS_SCHEMA}.intake_t0046 RENAME TO intake`);
      await waitFor(
        stack,
        "the jobs body to read ok again without a restart",
        { timeoutMs: 90_000 },
        async () => ((await healthOf("jobs")).status === "ok" ? true : undefined),
      );
      const uptimeAfterRestore = (await healthOf("jobs")).uptime;
      expect(
        uptimeAfterRestore,
        "the jobs process was never restarted across the outage and repair",
      ).toBeGreaterThan(uptimeBeforeRestore);

      // Accepted work kept: the interrupted job recovers and completes.
      const aFinal = await pollSnapshot(
        session.api,
        a.jobId,
        (s) => s.status === "succeeded",
        120_000,
      );
      expect(
        aFinal.attempt ?? 0,
        "the interrupted attempt was recovered, not resumed in place",
      ).toBeGreaterThanOrEqual(2);
      const aResult = await session.api("GET", resultPath(a.jobId));
      expect(aResult.status, "the recovered job's result read").toBe(200);

      // A fresh submission is accepted and succeeds on the restored store.
      const b = await submitDiagnostic(session, { steps: 1, stepDelayMs: 0 });
      await pollSnapshot(session.api, b.jobId, (s) => s.status === "succeeded", 60_000);
      jobBId = b.jobId;

      // Leave jobs running on the relay — the next test cuts the same relay.
    },
  );

  test(
    "the store dying under a running service: honest health from the first failed request, stale maintenance, overdue delivery on the portal, and recovery",
    { timeout: 300_000 },
    async () => {
      const session = sessions.outage;
      const faultRelay = must(relay, "the store relay from the previous test");

      await waitFor(
        stack,
        "the jobs body to read ok at the start of the outage",
        { timeoutMs: 60_000 },
        async () => ((await healthOf("jobs")).status === "ok" ? true : undefined),
      );

      const c = await submitDiagnostic(session, { steps: 20, stepDelayMs: 1000 });
      await pollUntilRunning(session.api, c.jobId, 1);
      expect((await healthOf("jobs")).status, "the jobs body before the cut").toBe("ok");

      const cutAt = Date.now();
      faultRelay.cut();

      // ONE failing request — its 503 is what makes the supervisor re-probe
      // at once, so the honest flip comes from the failed request, not from
      // the 30 s steady probe.
      const dKey = `rr-${randomUUID()}`;
      const dInput: DiagnosticJobInput = { steps: 1, stepDelayMs: 0 };
      const dReply = await timed(() => submitOnce(session, SUBMIT_PATH_DIAGNOSTIC, dInput, dKey));
      expect(dReply.value.status, `the cut-store submission: ${dReply.value.text}`).toBe(503);
      expect(JobRequestErrorSchema.parse(dReply.value.json()).code).toBe("jobs_unavailable");
      expect(dReply.ms, "the cut-store submission answers immediately").toBeLessThan(15_000);

      const dRepliedAt = Date.now();
      let flipMs = 0;
      await waitFor(
        stack,
        () =>
          `the jobs body to flip to error within 10 s of the failed request (replied at ${dRepliedAt})`,
        { timeoutMs: 15_000, pollMs: 250 },
        async () => {
          const body = await healthOf("jobs");
          if (body.status !== "error") return undefined;
          flipMs = Date.now() - dRepliedAt;
          return true;
        },
      );
      expect(
        flipMs,
        "the honest flip after the first failed request came from the request-driven re-probe, not the 30 s cadence",
      ).toBeLessThan(10_000);
      expect(check(await healthOf("jobs"), JOBS_DATABASE_CHECK).status).toBe("error");

      // The edge distinguishes "reachable but cannot execute" from "unreachable":
      // the server still answers the health contract, so reachability stays ok
      // while the detail names the error body.
      await waitFor(
        stack,
        "the edge's reachability detail to name the jobs server's own error body",
        { timeoutMs: 45_000 },
        async () => {
          const reach = check(await healthOf("edge"), JOBS_REACHABILITY_CHECK);
          return reach.status === "ok" && (reach.detail ?? "").includes("reports error")
            ? true
            : undefined;
        },
      );

      // An archive delivered while the store is cut cannot be applied: the
      // portal first reads young-and-outstanding, then overdue.
      const archiveAt = Date.now();
      const archived = await bob.post(`/api/v1/apps/${apps.archive.slug}/archive`);
      expect(archived.status, "the archive of the archive app").toBe(200);

      await waitFor(
        stack,
        "the portal's delivery check to show the undelivered archive (outstanding >= 1, unsynchronized)",
        { timeoutMs: 60_000 },
        async () => {
          const reading = await deliveryCheckReading();
          return reading.status === "ok" &&
            (reading.metrics?.outstanding ?? 0) >= 1 &&
            (reading.metrics?.synchronizedTargets ?? 0) < (reading.metrics?.targets ?? 0)
            ? true
            : undefined;
        },
      );
      const overdue = await waitFor(
        stack,
        () =>
          `the portal's delivery check to read overdue (archived at ${archiveAt}, overdue bound 60 s)`,
        { timeoutMs: 120_000 },
        async () => {
          const reading = await deliveryCheckReading();
          return reading.status === "degraded" &&
            (reading.detail ?? "").startsWith("lifecycle delivery is overdue") &&
            (reading.detail ?? "").includes("jobs:")
            ? reading
            : undefined;
        },
      );

      // Delivery lag is the PORTAL's overdue detail; the jobs-side recovery
      // check speaks only for its own staleness — the two never report for
      // each other.
      const jobsRecovery = check(await healthOf("jobs"), JOBS_LIFECYCLE_RECOVERY_CHECK);
      expect(
        jobsRecovery.detail,
        "the jobs-side recovery check's detail is not the portal's",
      ).not.toBe(overdue.detail);
      expect(
        jobsRecovery.detail ?? "",
        "the jobs-side recovery check degrades on stale sweeper evidence, never on delivery lag",
      ).toMatch(/backlog evidence is stale/);

      // Stale maintenance: both loop checks degrade, anchored at the last
      // successful pass from BEFORE the cut.
      const stale = await waitFor(
        stack,
        () => `the jobs sweeper and lifecycle-recovery checks to go stale (cut at ${cutAt})`,
        { timeoutMs: 90_000 },
        async () => {
          const body = await healthOf("jobs");
          const sweeper = check(body, JOBS_SWEEPER_CHECK);
          const recovery = check(body, JOBS_LIFECYCLE_RECOVERY_CHECK);
          return sweeper.status === "degraded" && recovery.status === "degraded"
            ? { sweeper, recovery }
            : undefined;
        },
      );
      expect(
        Date.parse(must(stale.sweeper.lastSuccessAt, "the sweeper's lastSuccessAt")),
        "the sweeper's last successful pass predates the cut",
      ).toBeLessThan(cutAt);
      expect(
        Date.parse(must(stale.recovery.lastSuccessAt, "the recovery check's lastSuccessAt")),
        "the recovery check's last successful pass predates the cut",
      ).toBeLessThan(cutAt);

      // Recovery, without a restart, on every side.
      faultRelay.restore();
      await waitFor(
        stack,
        "the jobs body to read ok again with fresh sweeper and recovery evidence",
        { timeoutMs: 90_000 },
        async () => {
          const body = await healthOf("jobs");
          return body.status === "ok" &&
            check(body, JOBS_SWEEPER_CHECK).status === "ok" &&
            check(body, JOBS_LIFECYCLE_RECOVERY_CHECK).status === "ok"
            ? true
            : undefined;
        },
      );
      await waitFor(
        stack,
        "the portal's delivery check to drain the archive backlog",
        { timeoutMs: 90_000 },
        async () => {
          const reading = await deliveryCheckReading();
          const targets = reading.metrics?.targets ?? 0;
          return reading.status === "ok" &&
            targets > 0 &&
            reading.metrics?.outstanding === 0 &&
            reading.metrics?.synchronizedTargets === targets
            ? true
            : undefined;
        },
      );

      // The running job was recovered, not lost.
      const cFinal = await pollSnapshot(
        session.api,
        c.jobId,
        (s) => s.status === "succeeded",
        120_000,
      );
      expect(
        cFinal.attempt ?? 0,
        "the interrupted attempt was recovered, not resumed in place",
      ).toBeGreaterThanOrEqual(2);

      // The failed submission created nothing: the same key and bytes is a
      // NEW acceptance once the store is back.
      const dRetried = await submitOnce(session, SUBMIT_PATH_DIAGNOSTIC, dInput, dKey);
      expect(dRetried.status, `the retry of the failed submission: ${dRetried.text}`).toBe(202);
      const dAccepted = JobAcceptedSchema.parse(dRetried.json());
      await pollSnapshot(session.api, dAccepted.jobId, (s) => s.status === "succeeded", 60_000);

      // Leave the stack tidy: the archive app back open.
      const unarchived = await bob.post(`/api/v1/apps/${apps.archive.slug}/unarchive`);
      expect(unarchived.status, "the unarchive of the archive app").toBe(200);

      await faultRelay.close();
      relay = null;
      stack.setServiceEnv("jobs", null);
      await stack.restart("jobs");
    },
  );

  test(
    "closed intake: new work answers 503 jobs_disabled while reads, the health body and drain evidence stay honest",
    { timeout: 180_000 },
    async () => {
      // Full readiness can lag the boot: a closed intake reads degraded until
      // the first cleanup evidence, so start to the listener and wait for the
      // intake check's own honest reading.
      stack.setServiceEnv("jobs", { JOBS_ACCEPTING: "false" });
      await stack.stop("jobs");
      await stack.start("jobs", { until: "listener" });

      await waitFor(
        stack,
        "the closed intake to be applied with fresh drain evidence",
        { timeoutMs: 120_000 },
        async () => {
          const intake = check(await healthOf("jobs"), JOBS_INTAKE_CHECK);
          return intake.status === "ok" &&
            intake.metrics?.unfinishedServer !== undefined &&
            intake.metrics?.retainedServer !== undefined
            ? intake
            : undefined;
        },
      );

      // New work is refused with the closed-intake code…
      const refused = await submitOnce(
        sessions.modes,
        SUBMIT_PATH_DIAGNOSTIC,
        { steps: 1, stepDelayMs: 0 } satisfies DiagnosticJobInput,
        `rr-${randomUUID()}`,
      );
      expect(refused.status, `the closed-intake submission: ${refused.text}`).toBe(503);
      expect(JobRequestErrorSchema.parse(refused.json()).code).toBe("jobs_disabled");

      // …while reads keep working: job B (accepted before the closure) still
      // reports its succeeded state.
      const bSnapshot = await sessions.outage.api(
        "GET",
        statusPath(must(jobBId, "job B from the outage test")),
      );
      expect(bSnapshot.status, "the snapshot read while intake is closed").toBe(200);
      expect(JobSnapshotSchema.parse(bSnapshot.json()).status).toBe("succeeded");

      // Reopening: the same store, the same seam.
      stack.setServiceEnv("jobs", null);
      await stack.restart("jobs");
      const reopened = await submitOnce(
        sessions.modes,
        SUBMIT_PATH_DIAGNOSTIC,
        { steps: 1, stepDelayMs: 0 } satisfies DiagnosticJobInput,
        `rr-${randomUUID()}`,
      );
      expect(reopened.status, `the reopened intake's submission: ${reopened.text}`).toBe(202);
    },
  );

  test(
    "configured OTLP, an unreachable endpoint, no endpoint and a disabled SDK all execute work, report honest health and shut down clean",
    { timeout: 300_000 },
    async () => {
      const capture = must(stack.telemetry, "the stack's telemetry capture");
      const deadPort = await claimDeadPort();

      // Each mode: start clean, run one diagnostic job to `succeeded` on a
      // healthy body, stop, and read the exit audit. The throttle budget:
      // five `modes` submissions in this test (four modes plus the
      // cancellation leg), each separated by a restart — well inside ten per
      // minute.
      const modes: ReadonlyArray<{ name: string; env: Record<string, string | null> }> = [
        { name: "configured", env: {} },
        {
          name: "unreachable endpoint",
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${deadPort}` },
        },
        { name: "no endpoint", env: { OTEL_EXPORTER_OTLP_ENDPOINT: null } },
        { name: "disabled", env: { OTEL_SDK_DISABLED: "1" } },
      ];

      for (const mode of modes) {
        stack.setServiceEnv("jobs", { ...mode.env, NODE_OPTIONS: auditNodeOptions() });
        await stack.restart("jobs");
        const baselineJobsPayloads = jobsPayloadsSoFar();
        const baselinePayloadIndex = capture.payloads.length;

        const job = await submitDiagnostic(sessions.modes, { steps: 2, stepDelayMs: 100 });
        await pollSnapshot(sessions.modes.api, job.jobId, (s) => s.status === "succeeded", 60_000);
        expect(
          (await healthOf("jobs")).status,
          `${mode.name}: the jobs body is honest while telemetry is ${mode.name}`,
        ).toBe("ok");

        // In the disabled mode only: cancellation releasing its resources —
        // a running job cancelled to its terminal outcome BEFORE the stop, so
        // the drained audit below covers a process that just settled work.
        if (mode.name === "disabled") {
          const long = await submitDiagnostic(sessions.modes, { steps: 20, stepDelayMs: 1000 });
          await pollUntilRunning(sessions.modes.api, long.jobId, 1);
          const cancelled = await sessions.modes.api("DELETE", statusPath(long.jobId));
          expect(cancelled.status, `the cancellation: ${cancelled.text}`).toBe(202);
          await pollSnapshot(
            sessions.modes.api,
            long.jobId,
            (s) => s.status === "cancelled",
            90_000,
          );
        }

        const stopped = await stack.stop("jobs");
        expect(stopped.exitCode, `${mode.name}: the stop's exit code`).toBe(0);
        expect(stopped.killed, `${mode.name}: the stop never needed the grace's SIGKILL`).toBe(
          false,
        );
        expect(stopped.elapsedMs, `${mode.name}: the stop drained inside the grace`).toBeLessThan(
          10_000,
        );
        expect(exitAuditRecord("jobs").outcome, `${mode.name}: the exit audit`).toBe("drained");

        if (mode.name === "configured") {
          const newJobsPayloads = capture.payloads
            .slice(baselinePayloadIndex)
            .filter((p) => payloadServiceName(p.body) === JOBS_SERVICE_NAME);
          expect(
            newJobsPayloads.length,
            "the configured stop flushed new jobs payloads",
          ).toBeGreaterThan(0);
          expect(
            newJobsPayloads.some(
              (p) => p.signal === "traces" && spanNamesIn(p.body).includes(SPAN_JOBS_EXECUTE),
            ),
            "the exported traces carry the execute span",
          ).toBe(true);
          // The outage probes' unavailable points were accumulated by the
          // EARLIER jobs processes and flushed at THEIR stops; the fresh
          // process in this mode only probed ok. The new payloads carry the
          // instrument regardless; the unavailable point is found by scanning
          // everything since the suite start.
          const unavailablePointIn = (
            payloads: ReadonlyArray<{ signal: string; body: string }>,
          ): boolean =>
            payloads.some(
              (p) =>
                p.signal === "metrics" &&
                metricHasDataPoint(p.body, INSTR_JOBS_STORAGE_PROBES, ATTR_OUTCOME, "unavailable"),
            );
          const metricInNew = unavailablePointIn(newJobsPayloads);
          const metricAnywhere = metricInNew || unavailablePointIn(capture.payloads);
          expect(
            metricAnywhere,
            `the storage-probe instrument's unavailable outcome is exported somewhere in the capture (${capture.dropped} payloads dropped by the size cap)`,
          ).toBe(true);
        }
        if (mode.name === "no endpoint" || mode.name === "disabled") {
          expect(jobsPayloadsSoFar(), `${mode.name}: no jobs payload arrives in the capture`).toBe(
            baselineJobsPayloads,
          );
        }
      }

      // Restore the default start for the final test.
      stack.setServiceEnv("jobs", null);
      await stack.start("jobs");
    },
  );

  test(
    "SIGTERM drains the jobs process as the production image runs it, with work in flight, inside the window",
    { timeout: 240_000 },
    async () => {
      // The harness must launch exactly what the image runs: the Dockerfile's
      // last WORKDIR is the package, the CMD is the argv, and the image sets
      // NODE_ENV=production.
      const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
      const workdirs = [...dockerfile.matchAll(/^\s*WORKDIR\s+(\S+)\s*$/gm)].map(
        (match) => match[1] ?? "",
      );
      const lastWorkdir = workdirs.at(-1);
      expect(lastWorkdir, "the Dockerfile's last WORKDIR").toBeDefined();
      const cmdMatch = /^\s*CMD\s+(\[[^\n]*\])\s*$/m.exec(dockerfile);
      expect(cmdMatch, "the Dockerfile's CMD line").not.toBeNull();
      const cmd: string[] = JSON.parse(must(cmdMatch, "the Dockerfile's CMD line")[1] ?? "[]");
      const launch = serviceLaunch("jobs");
      expect(launch.argv, "the harness's argv equals the image's CMD").toEqual(cmd);
      expect(
        `/app/${launch.cwd}`,
        "the harness's working directory equals the image's WORKDIR",
      ).toBe(lastWorkdir);
      expect(dockerfile, "the image runs in production mode").toMatch(
        /^ENV NODE_ENV=production\s*$/m,
      );

      // Production refuses the diagnostic type, so this leg runs the fetch
      // type — the one installed production type — against the harness's
      // controlled origin.
      stack.setServiceEnv("jobs", {
        NODE_ENV: "production",
        JOBS_DIAGNOSTICS: "false",
        NODE_OPTIONS: auditNodeOptions(),
      });
      await stack.restart("jobs");

      const hold = origin.hold("/held");
      origin.respond("/held", { json: { ok: true } });
      const submitted = await submitOnce(
        sessions.image,
        SUBMIT_PATH_FETCH,
        { url: `${origin.origin}/held` },
        `rr-${randomUUID()}`,
      );
      expect(submitted.status, `the fetch submission: ${submitted.text}`).toBe(202);
      const fetchJob = JobAcceptedSchema.parse(submitted.json());

      // The outbound call in flight: jobs → edge callback → egress → origin.
      // The hold keeps the worker's task and its callback socket open while
      // the SIGTERM lands — exactly the work a drain must release.
      await Promise.race([
        hold.arrived,
        sleep(60_000).then(() => {
          throw new Error("the fetch job's outbound call never reached the origin within 60 s");
        }),
      ]);

      const stopped = await stack.stop("jobs");
      expect(stopped.exitCode, "the in-flight stop's exit code").toBe(0);
      expect(stopped.killed, "the in-flight stop never needed the grace's SIGKILL").toBe(false);
      expect(stopped.elapsedMs, "the in-flight stop drained inside the grace").toBeLessThan(10_000);
      expect(
        exitAuditRecord("jobs").outcome,
        "the in-flight worker task and its callback socket were released at shutdown",
      ).toBe("drained");

      // The shutdown story of this run: the signal was handled and the drain
      // completed, with no deadline exceeded.
      const tail = stack.logTail("jobs", 200);
      const lastSignalAt = tail.lastIndexOf("shutdown.signal");
      expect(
        lastSignalAt,
        "the run's log carries the shutdown.signal event",
      ).toBeGreaterThanOrEqual(0);
      const afterSignal = tail.slice(lastSignalAt);
      expect(
        afterSignal,
        "the run's log carries the shutdown.exit event after the signal",
      ).toContain("shutdown.exit");
      expect(afterSignal, "the run's drain never hit the shutdown deadline").not.toContain(
        "shutdown.timeout",
      );

      hold.release();

      stack.setServiceEnv("jobs", null);
      await stack.start("jobs");

      // The record is not lost: the fetch type does not retry a lost attempt,
      // so whichever terminal it reaches must be the truthful one — never a
      // non-terminal state. A succeeded outcome carries the origin's JSON. A
      // lost attempt (this drain: the graceful stop aborts the in-flight
      // handler and pg-boss's own stop settles the claim first, so the
      // attempt's failure is not projected) is recovered by the sweeper as
      // `crashed` — execution lost, never reissued (the note in
      // trustBoundary.integration.test.ts) — or as `failed` where the
      // attempt's own settle landed; either way the error is carried.
      const final = await pollSnapshot(
        sessions.image.api,
        fetchJob.jobId,
        (s) => (JOB_TERMINAL_STATUSES as readonly string[]).includes(s.status),
        120_000,
      );
      if (final.status === "succeeded") {
        const result = await sessions.image.api("GET", resultPath(fetchJob.jobId));
        expect(result.status, "the interrupted fetch job's result read").toBe(200);
        expect(JSON.parse(result.text), "the result is the origin's own JSON").toEqual({
          ok: true,
        });
      } else {
        expect(
          ["failed", "crashed"],
          `the fetch job's terminal outcome: ${final.status}`,
        ).toContain(final.status);
        expect(final.error, "a lost fetch attempt carries its bounded error").not.toBeNull();
      }

      // The restored stack is left healthy for whoever inspects it next.
      await waitFor(
        stack,
        "the restored jobs body to read ok after the production-mode leg",
        { timeoutMs: 90_000 },
        async () => ((await healthOf("jobs")).status === "ok" ? true : undefined),
      );
    },
  );
});
