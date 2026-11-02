import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  GatewayAuditPageSchema,
  HealthStatusSchema,
  INSTRUCTION_HEADER,
  JOB_TERMINAL_STATUSES,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_MAX_RESULT_BYTES,
  JOBS_SERVER_NAME,
  ManifestUpdateResultSchema,
  type App,
  type JobSnapshot,
} from "@azx-pbc/shared";
import {
  FORBIDDEN_URL_ATTRS,
  SPAN_JOBS_FETCH_DISPATCH,
  SPAN_JOBS_FETCH_EDGE,
} from "@azx-pbc/shared/telemetry";
import {
  deriveJobsInstructionKey,
  mintJobsInstruction,
  type JobsCallbackIdentity,
} from "@azx-pbc/shared/jobsSigning";

import { JOBS_JOB_RECORD_QUALIFIED } from "./policy.js";
import {
  createLiveApp,
  mintLoopbackCert,
  startJsonOrigin,
  startRealStack,
  waitFor,
  type AppSession,
  type ControlledJsonOrigin,
  type HttpReply,
  type PortalClient,
  type RealStack,
  type StackServiceName,
} from "./test/realStack.js";

/**
 * The governed outbound fetch (`jobs:fetch`) end to end, over the real running
 * platform: a submitted job's one governed GET is dispatched through the signed
 * jobs→edge callback and the fetch policy, the result bounds hold on the
 * stream, every failure mode ends in its distinct terminal reason, stored
 * secrets are injected and revocable, governance changes apply to work that is
 * already waiting, the lifecycle generation fences the callback, a jobs crash
 * never reissues the remote effect, and no secret value reaches a reply, a log
 * line or an exported signal.
 *
 * One stack serves the whole file (telemetry capture on); the three
 * capacity-shaped test groups run concurrently because each owns its own app,
 * so the per-app two-running-jobs allowance and the submission throttle never
 * interact. The controlled origins are loopback HTTP(S) servers the dev
 * egress allowance lets the outbound call reach.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let bob: PortalClient;
let alice: PortalClient;
/** Platform-owner pool: the session table and the apps' lifecycle generation. */
let platform: Pool;
/** Jobs-owner pool: the job records no route exposes for rewrite. */
let jobsDb: Pool;

let origin: ControlledJsonOrigin;
let holdOrigin: ControlledJsonOrigin;
let tlsOrigin: ControlledJsonOrigin;
let badTlsOrigin: ControlledJsonOrigin;
let trustedCert: ReturnType<typeof mintLoopbackCert>;
let untrustedCert: ReturnType<typeof mintLoopbackCert>;
let bundleDir: string;
let bundlePath: string;

type AppKey = "results" | "failures" | "slow" | "secret" | "gov";
const APP_KEYS: readonly AppKey[] = ["results", "failures", "slow", "secret", "gov"];

interface AppUnderTest {
  readonly app: App;
  readonly slug: string;
  session: AppSession;
  /** Every submission attempt this suite made on the app — the throttle counts refusals. */
  readonly attempts: { n: number };
  /** The wall-clock of the app's own last submission attempt (the throttle's window). */
  lastSubmitAt: number;
}

const apps = {} as Record<AppKey, AppUnderTest>;

/** The sealed values the tests plant; never printed in an assertion message. */
const SECRET_PROD = `helix-secret-prod-${randomBytes(8).toString("hex")}`;
const SECRET_DEV = `helix-secret-dev-${randomBytes(8).toString("hex")}`;
const SECRET_GOV = `helix-secret-gov-${randomBytes(8).toString("hex")}`;
const PROVIDER_CLIENT_SECRET = `helix-provider-secret-${randomBytes(8).toString("hex")}`;
const UPSTREAM_MARKER = `helix-upstream-marker-${randomBytes(8).toString("hex")}`;

/** The streamed body the result bound must cut off. */
const HUGE_BODY_BYTES = 128 * 1024 * 1024;

const DNS_FAILURE_ORIGIN = "http://helix-outbound-dns.invalid";
const METADATA_ORIGIN = "http://169.254.169.254";
const PRIVATE_ORIGIN = "http://10.255.255.1";

const seenReplies: Array<{ what?: string; status: number; headersJson: string; text: string }> = [];

/** Every callback instruction token the suite mints — the final scan consumes this. */
const instructionTokens: string[] = [];

/**
 * What the portal said when the `slow` app's private/metadata origin grants
 * were requested, if it refused them — reported, never swallowed.
 */
let slowGrantReport: string | undefined;

// ── small helpers ────────────────────────────────────────────────────────────

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Record every HttpReply the suite receives, for the final leak scan. */
function seen(reply: HttpReply, what?: string): HttpReply {
  seenReplies.push({
    what,
    status: reply.status,
    headersJson: JSON.stringify(reply.headers),
    text: reply.text,
  });
  return reply;
}

/** One header of a reply or a recorded origin request, as a single string. */
const valueOf = (headers: Record<string, string | string[] | undefined>, name: string): string => {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

/** The `{code, …}` envelope's code — the fetch gateway's error body shape. */
const envelopeCode = (reply: HttpReply): string | undefined => {
  const body = reply.json() as { code?: string };
  return body.code;
};

/** How many recorded requests to the origin have this exact pathname. */
function originGets(o: ControlledJsonOrigin, path: string): number {
  return o.requests.filter((r) => {
    try {
      return new URL(r.path, "http://127.0.0.1").pathname === path;
    } catch {
      return false;
    }
  }).length;
}

/** The port of a `http://127.0.0.1:<port>` origin string. */
const portOf = (o: ControlledJsonOrigin): number => Number(new URL(o.origin).port);

// ── leak scanning (the final test) ───────────────────────────────────────────

/** One forbidden value, named only by its class — never by its bytes. */
type SealedValue = { label: string; value: string };

const leakIn = (text: string, sealed: readonly SealedValue[]): string | null => {
  for (const { label, value } of sealed) {
    if (value !== "" && text.includes(value)) return label;
  }
  return null;
};

const urlAttributeLeak = (text: string): string | null => {
  for (const key of FORBIDDEN_URL_ATTRS) {
    if (new RegExp(`"key"\\s*:\\s*"${key.replaceAll(".", "\\.")}"`).test(text)) {
      return `a forbidden URL attribute key (${key})`;
    }
  }
  return null;
};

// ── the jobs gateway surface ─────────────────────────────────────────────────

const SUBMIT_PATH = "/_api/jobs/jobs/types/fetch";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

/**
 * One submission attempt series on one app: a fresh retry key, the attempt
 * counted against the edge's per-app throttle (asserted inside it — refusals
 * count, so the whole suite must stay inside the allowance), one retry of a
 * retryable 503 with the SAME key and bytes, then the acceptance.
 */
async function submit(app: AppUnderTest, url: string): Promise<string> {
  const key = `of-${randomUUID()}`;
  const body = JSON.stringify({ url });
  const attempt = (): Promise<HttpReply> => {
    app.attempts.n += 1;
    expect(
      app.attempts.n,
      `submission attempts on "${app.slug}" stay inside the edge throttle`,
    ).toBeLessThanOrEqual(9);
    app.lastSubmitAt = Date.now();
    return app.session
      .api("POST", SUBMIT_PATH, {
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body,
      })
      .then((r) => seen(r, `the submission of ${url} on ${app.slug}`));
  };
  const first = await attempt();
  const reply = first.status === 503 ? await attempt() : first;
  expect(
    reply.status,
    `the submission of ${url} on ${app.slug} answered ${reply.status}: ${reply.text.slice(0, 300)}`,
  ).toBe(202);
  return JobAcceptedSchema.parse(reply.json()).jobId;
}

/**
 * Poll the snapshot (parsed against the wire schema) to a terminal status. A
 * 503 is the forwarding seam's retryable answer and a 410 the archived-app
 * page mid-projection (an archive/unarchive race) — both keep polling, since
 * an observation failure is never an execution failure.
 */
async function pollTerminal(
  api: AppSession["api"],
  jobId: string,
  timeoutMs: number,
  what = "",
): Promise<JobSnapshot> {
  let last: JobSnapshot | undefined;
  return waitFor(
    stack,
    () =>
      `job ${jobId}${what === "" ? "" : ` (${what})`} to reach a terminal status — last: ` +
      (last === undefined
        ? "<none>"
        : `${last.status}${last.error === null ? "" : `/${last.error.code}`}`),
    { timeoutMs },
    async () => {
      const res = seen(await api("GET", statusPath(jobId)), `the status poll of job ${jobId}`);
      if (res.status === 503 || res.status === 410) return undefined;
      expect(res.status, `the status poll of job ${jobId}`).toBe(200);
      last = JobSnapshotSchema.parse(res.json());
      return (JOB_TERMINAL_STATUSES as readonly string[]).includes(last.status) ? last : undefined;
    },
  );
}

/** The job succeeded and keeps a result. */
async function expectSucceeded(
  api: AppSession["api"],
  jobId: string,
  timeoutMs: number,
): Promise<JobSnapshot> {
  const final = await pollTerminal(api, jobId, timeoutMs, "to succeed");
  expect(final.status, `job ${jobId}'s terminal status`).toBe("succeeded");
  expect(final.error, `job ${jobId}'s terminal error`).toBeNull();
  return final;
}

/**
 * The job failed with the given code; the result read is the stateful 409 and
 * carries no upstream content. The snapshot schema already enforces that
 * `error.message` is the fixed platform message for the code.
 */
async function expectFailed(
  api: AppSession["api"],
  jobId: string,
  code: string,
  timeoutMs = 120_000,
): Promise<JobSnapshot> {
  const final = await pollTerminal(api, jobId, timeoutMs, `to fail with ${code}`);
  expect(final.status, `job ${jobId}'s terminal status`).toBe("failed");
  expect(final.error?.code, `job ${jobId}'s failure code`).toBe(code);
  const result = seen(await api("GET", resultPath(jobId)), `the result read of job ${jobId}`);
  expect(result.status, `the result read of the failed job ${jobId}`).toBe(409);
  const parsed = JobRequestErrorSchema.parse(result.json());
  expect(
    "status" in parsed && parsed.code === "job_terminal" && parsed.status === "failed",
    `the result read of failed job ${jobId} answers the stateful job_terminal 409`,
  ).toBe(true);
  expect(result.text, `the result read of job ${jobId} carries no upstream content`).not.toContain(
    UPSTREAM_MARKER,
  );
  return final;
}

/** The job is accepted queued (both running slots held elsewhere). */
async function pollQueued(
  api: AppSession["api"],
  jobId: string,
  timeoutMs = 30_000,
): Promise<JobSnapshot> {
  let last: JobSnapshot | undefined;
  return waitFor(
    stack,
    () =>
      `job ${jobId} to read "queued" while both running slots are held — last: ` +
      (last === undefined ? "<none>" : last.status),
    { timeoutMs },
    async () => {
      const res = seen(await api("GET", statusPath(jobId)), `the queued poll of job ${jobId}`);
      if (res.status === 503 || res.status === 410) return undefined;
      expect(res.status, `the queued poll of job ${jobId}`).toBe(200);
      last = JobSnapshotSchema.parse(res.json());
      return last.status === "queued" ? last : undefined;
    },
  );
}

/** Wait — bounded — for the job's outbound GET to arrive at the origin, then the hold's own arrival. */
async function awaitArrival(
  o: ControlledJsonOrigin,
  path: string,
  hold: { arrived: Promise<void> },
): Promise<void> {
  await waitFor(
    stack,
    `the job's outbound GET to reach the origin at ${path}`,
    { timeoutMs: 60_000 },
    async () => (originGets(o, path) > 0 ? true : undefined),
  );
  await hold.arrived;
}

/** Every service is running and its /health answers 200 — after every scenario. */
async function assertAllAlive(label: string): Promise<void> {
  const checks: ReadonlyArray<readonly [StackServiceName, string]> = [
    ["portal", `http://localhost:${stack.ports.portal}/health`],
    ["egress", `http://localhost:${stack.ports.egress}/health`],
    ["jobs", `http://localhost:${stack.ports.jobs}/health`],
    ["edge", `https://${stack.baseDomain}:${stack.ports.edge}/health`],
    ["devGateway", `https://dev-api.${stack.baseDomain}:${stack.ports.devGateway}/health`],
  ];
  for (const [name, url] of checks) {
    expect(stack.isRunning(name), `${label}: ${name} is running`).toBe(true);
    const res = seen(await stack.request(url), `${label}: the ${name} health read`);
    expect(res.status, `${label}: the ${name} /health answers 200`).toBe(200);
  }
}

// ── setup helpers ────────────────────────────────────────────────────────────

/** The SPA capability editor's save body for these choices. */
function manifestBody(
  origins: ReadonlyArray<{ origin: string; connection?: string; provider?: string }>,
  requestsPerDay?: number,
): unknown {
  return {
    capabilities: {
      mcp: [],
      externalOrigins: [],
      fetch: {
        shim: false,
        origins: origins.map((o) =>
          o.connection !== undefined
            ? { origin: o.origin, connection: o.connection }
            : o.provider !== undefined
              ? { origin: o.origin, provider: o.provider }
              : { origin: o.origin },
        ),
        ...(requestsPerDay === undefined ? {} : { requestsPerDay }),
      },
      jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] },
    },
  };
}

/** Save by bob; approve by alice only when the change is elevated (pending). */
async function saveManifest(
  slug: string,
  origins: ReadonlyArray<{ origin: string; connection?: string; provider?: string }>,
  requestsPerDay?: number,
): Promise<void> {
  const saved = seen(
    await bob.put(`/api/v1/apps/${slug}/manifest`, manifestBody(origins, requestsPerDay)),
    `the manifest save on ${slug}`,
  );
  expect(saved.status, `the manifest save on ${slug}: ${saved.text.slice(0, 300)}`).toBe(200);
  const pending = ManifestUpdateResultSchema.parse(saved.json()).pending;
  if (pending !== null) {
    const approved = seen(
      await alice.post(`/api/v1/approvals/${pending}/approve`),
      `the approval of ${slug}'s manifest change`,
    );
    expect(approved.status, `the approval of ${slug}'s manifest change`).toBe(200);
  }
}

/** The hosted app's synchronous fetch proxy — the observable projection signal. */
async function probe(session: AppSession, target: string): Promise<HttpReply> {
  return seen(await session.api("GET", `/_api/fetch/${target}`), `the probe of ${target}`);
}

async function waitForProbe(
  session: AppSession,
  target: string,
  until: (reply: HttpReply) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<HttpReply> {
  return waitFor(stack, what, { timeoutMs }, async () => {
    const reply = await probe(session, target);
    return until(reply) ? reply : undefined;
  });
}

/** Delete one session row by the cookie value's hash — the session gate's own seam. */
async function deleteSessionRow(cookie: string): Promise<void> {
  await platform.query(`DELETE FROM sessions WHERE "tokenHash" = $1`, [
    createHash("sha256").update(cookie.slice("__Host-session=".length), "utf8").digest("hex"),
  ]);
}

/** The platform `/health` body's lifecycle-delivery reading. */
async function lifecycleDeliveryReading(): Promise<{ passes: number; synchronized: boolean }> {
  const res = seen(await stack.request(`${stack.portalUrl}/health`), "the portal health read");
  expect(res.status, "portal /health status").toBe(200);
  const body = HealthStatusSchema.parse(res.json());
  const check = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK);
  const metrics = check?.metrics;
  if (!metrics) return { passes: 0, synchronized: false };
  return {
    passes: metrics.passes ?? 0,
    synchronized: (metrics.targets ?? 0) > 0 && metrics.synchronizedTargets === metrics.targets,
  };
}

async function waitForLifecycleDelivery(passesBefore: number): Promise<void> {
  await waitFor(
    stack,
    "the portal's jobs_lifecycle_delivery check to end a pass (after the apps' creation) with every target synchronized",
    { timeoutMs: 90_000 },
    async () => {
      const reading = await lifecycleDeliveryReading();
      return reading.passes > passesBefore && reading.synchronized ? true : undefined;
    },
  );
}

// ── the jobs→edge callback, minted as an insider would ───────────────────────

const jobsToEdgeKey = (): Uint8Array =>
  deriveJobsInstructionKey(
    must(stack.jobsRoots ?? undefined, "the stack's jobs signing roots").jobsToEdge,
    "jobsToEdge",
  );

const nowS = (): number => Math.floor(Date.now() / 1000);

/** Mint one fetch callback instruction for the given identity and register the token for the final scan. */
async function mintFetchCallback(
  identity: JobsCallbackIdentity,
  jobId: string,
  generation: string,
  target: string,
): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify({ url: target }));
  const token = await mintJobsInstruction(
    {
      operation: "fetch",
      server: JOBS_SERVER_NAME,
      identity,
      jobId,
      generation,
      body,
      iatS: nowS(),
    },
    jobsToEdgeKey(),
  );
  instructionTokens.push(token);
  return token;
}

const platformCallbackUrl = (): string =>
  `https://${stack.baseDomain}:${stack.ports.edge}/internal/jobs/v1/fetch`;

// ── the suite ────────────────────────────────────────────────────────────────

describe("the governed outbound fetch through the real stack", () => {
  beforeAll(async () => {
    stack = await startRealStack({ label: "outbound", telemetry: true });
    platform = new Pool({ connectionString: stack.platformOwnerDsn, max: 1 });
    jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 1 });

    // Four origins: plain http for the happy paths, a second http origin for
    // capacity holds, TLS with a certificate the egress will trust, and TLS
    // with one it will refuse.
    origin = await startJsonOrigin();
    holdOrigin = await startJsonOrigin();
    trustedCert = mintLoopbackCert();
    tlsOrigin = await startJsonOrigin({ tls: { cert: trustedCert.cert, key: trustedCert.key } });
    untrustedCert = mintLoopbackCert();
    badTlsOrigin = await startJsonOrigin({
      tls: { cert: untrustedCert.cert, key: untrustedCert.key },
    });

    // The egress's CA bundle: the harness's own certificate (the services'
    // default EXTRA_CA_CERTS value) PLUS the trusted loopback origin's — never
    // the untrusted one.
    bundleDir = mkdtempSync(path.join(tmpdir(), "helix-outbound-ca-"));
    bundlePath = path.join(bundleDir, "ca-bundle.pem");
    writeFileSync(bundlePath, Buffer.concat([stack.tlsCa, Buffer.from(trustedCert.cert)]));
    stack.setServiceEnv("egress", { NODE_EXTRA_CA_CERTS: bundlePath });
    await stack.restart("egress");

    bob = await stack.portalAs("bob@azx.dev");
    alice = await stack.portalAs("alice@azx.dev");

    const passesBefore = (await lifecycleDeliveryReading()).passes;

    const slugs: Record<AppKey, string> = {
      results: `of-results-${randomBytes(3).toString("hex")}`,
      failures: `of-failures-${randomBytes(3).toString("hex")}`,
      slow: `of-slow-${randomBytes(3).toString("hex")}`,
      secret: `of-secret-${randomBytes(3).toString("hex")}`,
      gov: `of-gov-${randomBytes(3).toString("hex")}`,
    };
    const created = Object.fromEntries(
      await Promise.all(
        APP_KEYS.map(async (key) => {
          const app = await createLiveApp(stack, bob, {
            slug: slugs[key],
            files: { "index.html": "<h1>outbound fetch</h1>" },
          });
          return [key, app] as const;
        }),
      ),
    ) as Record<AppKey, App>;

    // The connection secrets, before the manifest saves that bind them.
    for (const [slug, name, value, env] of [
      [slugs.secret, "vendor-key", SECRET_PROD, "prod"],
      [slugs.secret, "dev-only-key", SECRET_DEV, "dev"],
      [slugs.gov, "gov-key", SECRET_GOV, "prod"],
    ] as const) {
      const made = seen(
        await bob.post(`/api/v1/apps/${slug}/secrets`, {
          name,
          value,
          env,
          injection: { kind: "header", name: "x-api-key" },
        }),
        `the secret creation of ${name}`,
      );
      expect(made.status, `the secret creation of ${name}: ${made.text.slice(0, 300)}`).toBe(201);
    }

    await saveManifest(slugs.results, [{ origin: origin.origin }]);
    await saveManifest(slugs.failures, [
      { origin: origin.origin },
      { origin: badTlsOrigin.origin },
      { origin: DNS_FAILURE_ORIGIN },
    ]);

    // The SSRF scenarios need the private/metadata origins granted; if the
    // portal refuses any of them, assert the refusal, drop them, and report —
    // the affected scenarios will then observe the allowlist refusal instead.
    {
      const slowOrigins = [
        { origin: origin.origin },
        { origin: `http://localhost:${portOf(origin)}` },
        { origin: `http://[::1]:${portOf(origin)}` },
        { origin: METADATA_ORIGIN },
        { origin: PRIVATE_ORIGIN },
      ];
      const first = seen(
        await bob.put(`/api/v1/apps/${slugs.slow}/manifest`, manifestBody(slowOrigins)),
        "slow's manifest save with the private/metadata origins",
      );
      if (first.status === 200) {
        const pending = ManifestUpdateResultSchema.parse(first.json()).pending;
        if (pending !== null) {
          const approved = seen(
            await alice.post(`/api/v1/approvals/${pending}/approve`),
            "the approval of slow's manifest",
          );
          expect(approved.status, "the approval of slow's manifest").toBe(200);
        }
      } else {
        slowGrantReport =
          `the portal refused the private/metadata origin grants on the "slow" app ` +
          `(HTTP ${first.status}: ${first.text.slice(0, 300)}) — they were dropped; the SSRF ` +
          `scenarios aimed at them will observe the edge's allowlist refusal instead of egress's`;
        console.log(slowGrantReport);
        expect(
          first.status,
          "a private-origin refusal must be an explicit validation refusal",
        ).toBe(400);
        await saveManifest(slugs.slow, [{ origin: origin.origin }]);
      }
    }

    await saveManifest(slugs.secret, [
      { origin: tlsOrigin.origin, connection: "vendor-key" },
      { origin: holdOrigin.origin },
    ]);
    await saveManifest(slugs.gov, [
      { origin: tlsOrigin.origin, connection: "gov-key" },
      { origin: holdOrigin.origin },
    ]);

    await waitForLifecycleDelivery(passesBefore);

    for (const key of APP_KEYS) {
      apps[key] = {
        app: created[key],
        slug: slugs[key],
        session: await stack.appSession(slugs[key], "bob@azx.dev"),
        attempts: { n: 0 },
        lastSubmitAt: 0,
      };
    }

    // The projections' observable signal: every app's granted origins answer a
    // synchronous probe (the TLS probes prove the egress trusts the bundle and
    // injects the bound secret). Each probe path is configured on the origin
    // that app's manifest actually grants.
    const probePlan: ReadonlyArray<readonly [ControlledJsonOrigin, string]> = [
      [origin, "/probe-results"],
      [origin, "/probe-failures"],
      [origin, "/probe-slow"],
      [holdOrigin, "/probe-secret"],
      [tlsOrigin, "/probe-secret-tls"],
      [holdOrigin, "/probe-gov"],
      [tlsOrigin, "/probe-gov-tls"],
    ];
    for (const [o, path] of probePlan) {
      o.respond(path, { json: { probe: true } });
    }
    const probeTargets: Record<AppKey, readonly string[]> = {
      results: [`${origin.origin}/probe-results`],
      failures: [`${origin.origin}/probe-failures`],
      slow: [`${origin.origin}/probe-slow`],
      secret: [`${holdOrigin.origin}/probe-secret`, `${tlsOrigin.origin}/probe-secret-tls`],
      gov: [`${holdOrigin.origin}/probe-gov`, `${tlsOrigin.origin}/probe-gov-tls`],
    };
    for (const key of APP_KEYS) {
      for (const target of probeTargets[key]) {
        await waitForProbe(
          apps[key].session,
          target,
          (r) => r.status === 200,
          `the edge's projection to serve ${key}'s granted origins (probe ${target})`,
        );
      }
    }
  }, 300_000);

  afterAll(async () => {
    await origin?.close();
    await holdOrigin?.close();
    await tlsOrigin?.close();
    await badTlsOrigin?.close();
    if (bundleDir !== undefined) rmSync(bundleDir, { recursive: true, force: true });
    if (trustedCert) rmSync(trustedCert.dir, { recursive: true, force: true });
    if (untrustedCert) rmSync(untrustedCert.dir, { recursive: true, force: true });
    await platform?.end();
    await jobsDb?.end();
    if (stack) await stack.close();
  });

  // ── Test 1: result bounds, JSON validity, stream enforcement ──────────────

  test.concurrent(
    "results: the exact upstream JSON is kept inside the byte bound, on the stream",
    { timeout: 300_000 },
    async () => {
      const api = apps.results.session.api;

      // A plain object round-trips exactly.
      origin.respond("/obj", { json: { ok: true, list: [1, 2, 3] } });
      {
        const jobId = await submit(apps.results, `${origin.origin}/obj`);
        await expectSucceeded(api, jobId, 60_000);
        const result = seen(await api("GET", resultPath(jobId)), "the /obj result read");
        expect(result.status, "the /obj result read").toBe(200);
        expect(JSON.parse(result.text), "the /obj result is the upstream JSON").toEqual({
          ok: true,
          list: [1, 2, 3],
        });
        expect(originGets(origin, "/obj"), "the origin saw exactly one GET").toBe(1);
        await assertAllAlive("after /obj");
      }

      // JSON null is a result, not absence.
      origin.respond("/null", { json: null });
      {
        const jobId = await submit(apps.results, `${origin.origin}/null`);
        await expectSucceeded(api, jobId, 60_000);
        const result = seen(await api("GET", resultPath(jobId)), "the /null result read");
        expect(result.status, "the /null result read").toBe(200);
        expect(JSON.parse(result.text), "the /null result parses to null").toBeNull();
        expect(result.text.trim(), "the /null result body is exactly null").toBe("null");
        expect(originGets(origin, "/null")).toBe(1);
        await assertAllAlive("after /null");
      }

      // Exactly the platform's result allowance: kept.
      const atCapBody = `"${"a".repeat(JOBS_MAX_RESULT_BYTES - 2)}"`;
      expect(
        Buffer.byteLength(atCapBody, "utf8"),
        "the at-cap body is exactly the result allowance",
      ).toBe(JOBS_MAX_RESULT_BYTES);
      origin.respond("/at-cap", { rawBody: atCapBody });
      {
        const jobId = await submit(apps.results, `${origin.origin}/at-cap`);
        await expectSucceeded(api, jobId, 60_000);
        const result = seen(await api("GET", resultPath(jobId)), "the /at-cap result read");
        expect(result.status, "the /at-cap result read").toBe(200);
        expect(result.text, "the /at-cap result is the upstream bytes").toBe(atCapBody);
        expect(originGets(origin, "/at-cap")).toBe(1);
        await assertAllAlive("after /at-cap");
      }

      // One byte over: refused, nothing stored.
      const overCapBody = `"${"a".repeat(JOBS_MAX_RESULT_BYTES - 1)}"`;
      expect(
        Buffer.byteLength(overCapBody, "utf8"),
        "the over-cap body is one byte past the allowance",
      ).toBe(JOBS_MAX_RESULT_BYTES + 1);
      origin.respond("/over-cap", { rawBody: overCapBody });
      {
        const jobId = await submit(apps.results, `${origin.origin}/over-cap`);
        await expectFailed(api, jobId, "result_too_large");
        expect(originGets(origin, "/over-cap")).toBe(1);
        await assertAllAlive("after /over-cap");
      }

      // A 128 MiB upstream stream: the byte bound stops the STREAM — the origin
      // is cut off far below the whole body, never buffered to the end.
      let hugeBytesAtClose: number | undefined;
      origin.serve("/huge", (req, res) => {
        const chunk = "0,".repeat(32 * 1024);
        const total = HUGE_BODY_BYTES;
        let written = 0;
        let stopped = false;
        const record = (): void => {
          if (!stopped) {
            stopped = true;
            hugeBytesAtClose = written;
          }
        };
        const pump = (): void => {
          while (!res.destroyed && !stopped && written < total) {
            const n = Math.min(chunk.length, total - written);
            written += n;
            if (!res.write(n === chunk.length ? chunk : chunk.slice(0, n))) return;
          }
          if (!res.destroyed && !stopped && written >= total) {
            record();
            res.end("]");
          }
        };
        res.on("drain", () => {
          if (!res.destroyed && !stopped) pump();
        });
        res.socket?.on("close", record);
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[");
        written += 1;
        pump();
      });
      {
        const jobId = await submit(apps.results, `${origin.origin}/huge`);
        await expectFailed(api, jobId, "result_too_large", 180_000);
        await waitFor(
          stack,
          "the /huge origin socket to close (the stream stop reached the origin)",
          { timeoutMs: 60_000 },
          async () => (hugeBytesAtClose === undefined ? undefined : true),
        );
        // The bound is generous: once the job stops reading, each hop's socket
        // and stream buffers still fill before backpressure reaches the origin,
        // and under load that can be several MiB per hop.
        expect(
          hugeBytesAtClose,
          "the /huge origin was cut off well before the whole body — the stream was stopped, not buffered",
        ).toBeLessThan(HUGE_BODY_BYTES / 2);
        expect(originGets(origin, "/huge")).toBe(1);
        await assertAllAlive("after /huge");
      }

      // An incomplete JSON value is not a result.
      origin.respond("/invalid", { rawBody: '{"a":' });
      {
        const jobId = await submit(apps.results, `${origin.origin}/invalid`);
        await expectFailed(api, jobId, "result_invalid");
        expect(originGets(origin, "/invalid")).toBe(1);
        await assertAllAlive("after /invalid");
      }

      // An empty 200 body is not a result either.
      origin.respond("/empty", { status: 200, rawBody: "" });
      {
        const jobId = await submit(apps.results, `${origin.origin}/empty`);
        await expectFailed(api, jobId, "result_invalid");
        expect(originGets(origin, "/empty")).toBe(1);
        await assertAllAlive("after /empty");
      }
    },
  );

  // ── Test 2: upstream failures ─────────────────────────────────────────────

  test.concurrent(
    "upstream failures end the job upstream_error and never forward upstream content",
    { timeout: 240_000 },
    async () => {
      const api = apps.failures.session.api;

      // A 500: the body's marker must not reach the snapshot or the result read.
      origin.respond("/status-500", { status: 500, json: { marker: UPSTREAM_MARKER } });
      {
        const jobId = await submit(apps.failures, `${origin.origin}/status-500`);
        await expectFailed(api, jobId, "upstream_error");
        const snap = seen(await api("GET", statusPath(jobId)), "the /status-500 snapshot read");
        expect(snap.status, "the terminal snapshot read").toBe(200);
        expect(snap.text, "the snapshot carries no upstream content").not.toContain(
          UPSTREAM_MARKER,
        );
        const result = seen(await api("GET", resultPath(jobId)), "the /status-500 result read");
        expect(result.text, "the 409 carries no upstream content").not.toContain(UPSTREAM_MARKER);
        expect(originGets(origin, "/status-500"), "the failure was not retried").toBe(1);
        await assertAllAlive("after /status-500");
      }

      origin.respond("/status-404", { status: 404, json: { gone: true } });
      {
        const jobId = await submit(apps.failures, `${origin.origin}/status-404`);
        await expectFailed(api, jobId, "upstream_error");
        expect(originGets(origin, "/status-404")).toBe(1);
        await assertAllAlive("after /status-404");
      }

      // Redirects are never followed — even to the metadata address.
      origin.respond("/redirect", {
        status: 302,
        json: {},
        headers: { location: `${origin.origin}/redirect-target` },
      });
      {
        const jobId = await submit(apps.failures, `${origin.origin}/redirect`);
        await expectFailed(api, jobId, "upstream_error");
        expect(originGets(origin, "/redirect-target"), "the redirect was not followed").toBe(0);
        expect(originGets(origin, "/redirect")).toBe(1);
        await assertAllAlive("after /redirect");
      }

      origin.respond("/redirect-metadata", {
        status: 302,
        json: {},
        headers: { location: `${METADATA_ORIGIN}/latest/meta-data/` },
      });
      {
        const jobId = await submit(apps.failures, `${origin.origin}/redirect-metadata`);
        await expectFailed(api, jobId, "upstream_error");
        expect(originGets(origin, "/redirect-metadata")).toBe(1);
        await assertAllAlive("after /redirect-metadata");
      }

      // A connection reset before any bytes: the bounded upstream failure.
      origin.serve("/reset", (req, res) => {
        req.socket.resetAndDestroy();
        res.destroy();
      });
      {
        const jobId = await submit(apps.failures, `${origin.origin}/reset`);
        await expectFailed(api, jobId, "upstream_error");
        expect(originGets(origin, "/reset"), "the reset request was not reissued").toBe(1);
        await assertAllAlive("after /reset");
      }

      // A reset mid-body is never a partial result.
      origin.serve("/reset-mid", (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"partial": [1,2,');
        setTimeout(() => res.socket?.resetAndDestroy(), 200);
      });
      {
        const jobId = await submit(apps.failures, `${origin.origin}/reset-mid`);
        await expectFailed(api, jobId, "upstream_error");
        expect(originGets(origin, "/reset-mid"), "the reset request was not reissued").toBe(1);
        await assertAllAlive("after /reset-mid");
      }

      // A DNS failure and a TLS handshake refusal are upstream failures too.
      {
        const jobId = await submit(apps.failures, `${DNS_FAILURE_ORIGIN}/x`);
        await expectFailed(api, jobId, "upstream_error");
        await assertAllAlive("after the DNS failure");
      }
      {
        const jobId = await submit(apps.failures, `${badTlsOrigin.origin}/tls`);
        await expectFailed(api, jobId, "upstream_error");
        expect(
          badTlsOrigin.requests.length,
          "the TLS handshake was refused before any request",
        ).toBe(0);
        await assertAllAlive("after the TLS failure");
      }
    },
  );

  // ── Test 3: timeouts and cancellation ─────────────────────────────────────

  test.concurrent(
    "a hung or trickling upstream ends in the outbound timeout; cancellation reaches a held job",
    { timeout: 300_000 },
    async () => {
      const api = apps.slow.session.api;

      // A handler that never answers: the 30 s outbound bound ends the job,
      // and the abort reaches the origin through edge and egress.
      let hangClosedAt: number | undefined;
      origin.serve("/hang", (req, res) => {
        res.socket?.on("close", () => {
          hangClosedAt = Date.now();
        });
      });
      {
        const submittedAt = Date.now();
        const jobId = await submit(apps.slow, `${origin.origin}/hang`);
        const final = await expectFailed(api, jobId, "timeout", 90_000);
        expect(final.error?.code, "the timeout code").toBe("timeout");
        const terminalAt = Date.now();
        const elapsed = terminalAt - submittedAt;
        expect(
          elapsed,
          "the outbound bound ended the job no earlier than 30 s in",
        ).toBeGreaterThanOrEqual(30_000);
        expect(elapsed, "the outbound bound ended the job within 60 s").toBeLessThanOrEqual(60_000);
        await waitFor(
          stack,
          "the /hang origin socket to close after the abort",
          { timeoutMs: 30_000 },
          async () => (hangClosedAt === undefined ? undefined : true),
        );
        expect(
          must(hangClosedAt, "the /hang socket close time") - terminalAt,
          "the origin socket closed within 15 s of the terminal outcome",
        ).toBeLessThanOrEqual(15_000);
        expect(originGets(origin, "/hang"), "the origin saw exactly one GET").toBe(1);
        await assertAllAlive("after /hang");
      }

      // A body that trickles forever: same bound, same abort path.
      let trickleClosedAt: number | undefined;
      origin.serve("/trickle", (req, res) => {
        res.socket?.on("close", () => {
          trickleClosedAt = Date.now();
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[");
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer);
            return;
          }
          res.write("0,");
        }, 1_000);
        res.socket?.on("close", () => clearInterval(timer));
      });
      {
        const jobId = await submit(apps.slow, `${origin.origin}/trickle`);
        await expectFailed(api, jobId, "timeout", 90_000);
        const terminalAt = Date.now();
        await waitFor(
          stack,
          "the /trickle origin socket to close after the abort",
          { timeoutMs: 30_000 },
          async () => (trickleClosedAt === undefined ? undefined : true),
        );
        expect(
          must(trickleClosedAt, "the /trickle socket close time") - terminalAt,
          "the origin socket closed within 15 s of the terminal outcome",
        ).toBeLessThanOrEqual(15_000);
        expect(originGets(origin, "/trickle"), "the origin saw exactly one GET").toBe(1);
        await assertAllAlive("after /trickle");
      }

      // Cancelling a job whose GET the origin has not answered: acknowledged,
      // terminal within the bound, the abort reaches the origin, and the
      // origin saw exactly one GET.
      {
        let cancelClosedAt: number | undefined;
        origin.serve("/cancel", (req) => {
          req.socket.on("close", () => {
            cancelClosedAt = Date.now();
          });
        });
        const jobId = await submit(apps.slow, `${origin.origin}/cancel`);
        await waitFor(
          stack,
          "the cancel job's outbound GET to reach the origin",
          { timeoutMs: 60_000 },
          async () => (originGets(origin, "/cancel") > 0 ? true : undefined),
        );
        const del = seen(await api("DELETE", statusPath(jobId)), "the held job's cancellation");
        expect(del.status, "the cancellation of the held job").toBe(202);
        const final = await pollTerminal(api, jobId, 60_000, "to cancel");
        expect(final.status, "the cancelled job's terminal status").toBe("cancelled");
        expect(final.cancellationRequested, "the cancellation intent is on the snapshot").toBe(
          true,
        );
        const terminalAt = Date.now();
        await waitFor(
          stack,
          "the /cancel origin socket to close after the cancellation",
          { timeoutMs: 30_000 },
          async () => (cancelClosedAt === undefined ? undefined : true),
        );
        expect(
          must(cancelClosedAt, "the /cancel socket close time") - terminalAt,
          "the origin socket closed within 15 s of the terminal outcome",
        ).toBeLessThanOrEqual(15_000);
        expect(originGets(origin, "/cancel"), "the origin saw exactly one GET").toBe(1);
        await assertAllAlive("after /cancel");
      }
    },
  );

  // ── Test 4: stored secret custody, attribution, revocation, tiers ─────────

  test(
    "stored secrets: injection, attribution after session expiry, revocation, and tier isolation",
    { timeout: 300_000 },
    async () => {
      const secretApp = apps.secret;

      // Injection: the origin sees the header; nothing else does.
      tlsOrigin.respond("/with-secret", { json: { ok: "secret" } });
      {
        const jobId = await submit(secretApp, `${tlsOrigin.origin}/with-secret`);
        await expectSucceeded(secretApp.session.api, jobId, 60_000);
        const atOrigin = originGets(tlsOrigin, "/with-secret");
        expect(atOrigin, "the origin saw exactly one GET").toBe(1);
        const recorded = must(
          tlsOrigin.requests.find(
            (r) => new URL(r.path, "http://127.0.0.1").pathname === "/with-secret",
          ),
          "the recorded /with-secret request",
        );
        expect(valueOf(recorded.headers, "x-api-key"), "the secret was injected").toBe(SECRET_PROD);
        const result = seen(
          await secretApp.session.api("GET", resultPath(jobId)),
          "the /with-secret result read",
        );
        expect(result.status, "the /with-secret result read").toBe(200);
        expect(JSON.parse(result.text)).toEqual({ ok: "secret" });
        expect(result.text, "the result carries no secret value").not.toContain(SECRET_PROD);
        const snap = seen(
          await secretApp.session.api("GET", statusPath(jobId)),
          "the /with-secret snapshot read",
        );
        expect(snap.text, "the snapshot carries no secret value").not.toContain(SECRET_PROD);
        await assertAllAlive("after /with-secret");
      }

      // Attribution after session expiry: the queued third job runs after its
      // submitter's session is gone, and the ledger still attributes it to the
      // principal that submitted it.
      holdOrigin.respond("/hold-a", { json: { held: "a" } });
      holdOrigin.respond("/hold-b", { json: { held: "b" } });
      {
        const holdA = holdOrigin.hold("/hold-a");
        const holdB = holdOrigin.hold("/hold-b");
        await submit(secretApp, `${holdOrigin.origin}/hold-a`);
        await submit(secretApp, `${holdOrigin.origin}/hold-b`);
        await awaitArrival(holdOrigin, "/hold-a", holdA);
        await awaitArrival(holdOrigin, "/hold-b", holdB);

        tlsOrigin.respond("/after-session", { json: { late: true } });
        const lateJob = await submit(secretApp, `${tlsOrigin.origin}/after-session`);
        await pollQueued(secretApp.session.api, lateJob);

        await deleteSessionRow(secretApp.session.cookie);
        holdA.release();
        holdB.release();

        const fresh = await stack.appSession(secretApp.slug, "bob@azx.dev");
        secretApp.session = fresh;
        await expectSucceeded(fresh.api, lateJob, 120_000);

        const page = await waitFor(
          stack,
          "the audit to carry the /after-session fetch row",
          { timeoutMs: 30_000, pollMs: 1_000 },
          async () => {
            const res = seen(
              await bob.get(`/api/v1/apps/${secretApp.slug}/audit?limit=200`),
              "the secret app's audit read",
            );
            expect(res.status, "the audit read").toBe(200);
            const parsed = GatewayAuditPageSchema.parse(res.json());
            return (
              parsed.rows.find((r) => r.capability === "fetch" && r.path === "/after-session") ??
              undefined
            );
          },
        );
        expect(page.env, "the fetch row's environment").toBe("prod");
        const jobsRows = GatewayAuditPageSchema.parse(
          seen(
            await bob.get(`/api/v1/apps/${secretApp.slug}/audit?limit=200`),
            "the secret app's audit read (second)",
          ).json(),
        ).rows.filter((r) => r.capability === "jobs");
        expect(jobsRows.length, "the audit carries bob's jobs submission rows").toBeGreaterThan(0);
        for (const row of jobsRows) {
          expect(row.userOid, "the fetch row's attribution matches the jobs submissions'").toBe(
            page.userOid,
          );
        }
        await assertAllAlive("after the attribution scenario");
      }

      // Revocation: the bound secret is gone, so the call refuses — no keyless
      // fallback reaches the origin.
      {
        const deleted = seen(
          await bob.delete(`/api/v1/apps/${secretApp.slug}/secrets/vendor-key?env=prod`),
          "the vendor-key deletion",
        );
        expect(deleted.status, "the vendor-key deletion").toBe(204);
        const jobId = await submit(secretApp, `${tlsOrigin.origin}/after-revoke`);
        await expectFailed(secretApp.session.api, jobId, "upstream_error");
        expect(
          originGets(tlsOrigin, "/after-revoke"),
          "no keyless fallback dialled the origin",
        ).toBe(0);
        await assertAllAlive("after the revocation");
      }

      // Tier isolation: the remaining secret exists only in dev. The binding
      // change is observed through a dev-tier probe (a dev caller's fetch
      // succeeds once the dev secret resolves), then the prod job still
      // refuses — no prod→dev fallback, no keyless fallback.
      {
        const minted = seen(
          await bob.post(`/api/v1/apps/${secretApp.slug}/dev-tokens`, {
            origins: ["http://localhost:5199"],
          }),
          "the dev-token mint",
        );
        expect(minted.status, "the dev-token mint").toBe(201);
        const dev = stack.devClient(
          secretApp.slug,
          (minted.json() as { token: string }).token,
          "http://localhost:5199",
        );

        await saveManifest(secretApp.slug, [
          { origin: tlsOrigin.origin, connection: "dev-only-key" },
          { origin: holdOrigin.origin },
        ]);

        tlsOrigin.respond("/dev-probe", { json: { probe: "dev" } });
        await waitFor(
          stack,
          "the dev-tier probe to succeed through the dev-only-key binding",
          { timeoutMs: 30_000 },
          async () => {
            const reply = seen(
              await dev.api("GET", `/_api/fetch/${tlsOrigin.origin}/dev-probe`),
              "the dev-tier probe",
            );
            return reply.status === 200 ? true : undefined;
          },
        );
        const devProbe = must(
          tlsOrigin.requests.find(
            (r) => new URL(r.path, "http://127.0.0.1").pathname === "/dev-probe",
          ),
          "the recorded /dev-probe request",
        );
        expect(valueOf(devProbe.headers, "x-api-key"), "the dev secret was injected").toBe(
          SECRET_DEV,
        );

        const jobId = await submit(secretApp, `${tlsOrigin.origin}/dev-only`);
        await expectFailed(secretApp.session.api, jobId, "upstream_error");
        expect(originGets(tlsOrigin, "/dev-only"), "the prod job never dialled the origin").toBe(0);
        await assertAllAlive("after the tier isolation");
      }
    },
  );

  // ── Test 5: governance changes while a job waits ──────────────────────────

  test(
    "governance changes while a job waits apply when the waiting job finally runs",
    { timeout: 360_000 },
    async () => {
      const gov = apps.gov;
      const govApi = gov.session.api;

      // The secret-bound origin works before any change (and consumes budget,
      // which phase C's cap will then find already spent).
      tlsOrigin.respond("/gov-probe-a0", { json: { probe: "a0" } });
      const before = await probe(gov.session, `${tlsOrigin.origin}/gov-probe-a0`);
      expect(before.status, "the gov-key probe before any change").toBe(200);

      /** Two running jobs held at the hold origin; the phase's target queues behind them. */
      const holdTwo = async (path: string): Promise<{ release(): void }> => {
        const hold = holdOrigin.hold(path);
        holdOrigin.respond(path, { json: { held: true } });
        await submit(gov, `${holdOrigin.origin}${path}`);
        await awaitArrival(holdOrigin, path, hold);
        return hold;
      };

      // Phase A — the origin becomes provider-bound while the target waits:
      // unattended work may never spend a delegated connection.
      const holdA1 = await holdTwo("/gov-hold-a1");
      const holdA2 = await holdTwo("/gov-hold-a2");
      const targetA = await submit(gov, `${tlsOrigin.origin}/gov-deleg`);
      await pollQueued(govApi, targetA);

      const providerRef = `gov-${randomBytes(4).toString("hex")}`;
      const made = seen(
        await alice.post("/api/v1/providers", {
          ref: providerRef,
          kind: "rest-delegated",
          displayName: "Outbound gov vendor",
          authorizeEndpoint: "https://gov-vendor.example/authorize",
          tokenEndpoint: "https://gov-vendor.example/token",
          requestedScopes: ["read"],
          apiOrigins: [tlsOrigin.origin],
          tokenPlacement: { kind: "header-bearer" },
          env: "prod",
          clientId: `gov-client-${randomBytes(6).toString("hex")}`,
          clientSecret: PROVIDER_CLIENT_SECRET,
        }),
        "the delegated provider creation",
      );
      expect(made.status, `the provider creation: ${made.text.slice(0, 300)}`).toBe(201);
      await saveManifest(gov.slug, [
        { origin: tlsOrigin.origin, provider: providerRef },
        { origin: holdOrigin.origin },
      ]);

      // Observed at the edge: the same-origin probe now refuses — the caller
      // holds no connection to the provider. (Transient 503s while the egress
      // provider cache catches up keep polling.)
      tlsOrigin.respond("/gov-probe-a", { json: { probe: "a" } });
      await waitForProbe(
        gov.session,
        `${tlsOrigin.origin}/gov-probe-a`,
        (r) => r.status === 403 && envelopeCode(r) === "connection_required",
        "the provider binding to reach the edge (the probe refuses with connection_required)",
      );
      holdA1.release();
      await expectFailed(govApi, targetA, "delegated_unattended", 90_000);
      expect(originGets(tlsOrigin, "/gov-deleg"), "the delegated target was never dialled").toBe(0);
      await assertAllAlive("after governance phase A");

      // Phase B — the origin grant is removed while the target waits: the
      // allowlist refusal, with no dial.
      const holdB = await holdTwo("/gov-hold-b");
      const targetB = await submit(gov, `${tlsOrigin.origin}/gov-grant`);
      await pollQueued(govApi, targetB);
      await saveManifest(gov.slug, [{ origin: holdOrigin.origin }]);
      tlsOrigin.respond("/gov-probe-b", { json: { probe: "b" } });
      await waitForProbe(
        gov.session,
        `${tlsOrigin.origin}/gov-probe-b`,
        (r) => r.status === 403 && envelopeCode(r) === "forbidden",
        "the grant removal to reach the edge (the probe refuses with forbidden)",
      );
      holdA2.release();
      await expectFailed(govApi, targetB, "outbound_forbidden", 90_000);
      expect(originGets(tlsOrigin, "/gov-grant"), "the ungranted target was never dialled").toBe(0);
      await assertAllAlive("after governance phase B");

      // Phase C — the daily budget (already spent by the earlier probes and
      // completed holds) refuses the waiting target.
      const holdC = await holdTwo("/gov-hold-c");
      holdOrigin.respond("/gov-budget", { json: { budget: true } });
      const targetC = await submit(gov, `${holdOrigin.origin}/gov-budget`);
      await pollQueued(govApi, targetC);
      await saveManifest(gov.slug, [{ origin: holdOrigin.origin }], 1);
      holdOrigin.respond("/gov-probe-c", { json: { probe: "c" } });
      await waitForProbe(
        gov.session,
        `${holdOrigin.origin}/gov-probe-c`,
        (r) => r.status === 429 && envelopeCode(r) === "rate_limited",
        "the budget to reach the edge (the probe refuses with rate_limited)",
      );
      holdB.release();
      await expectFailed(govApi, targetC, "outbound_quota_exceeded", 90_000);
      expect(originGets(holdOrigin, "/gov-budget"), "the budgeted target was never dialled").toBe(
        0,
      );

      // Release everything and let the held work finish.
      holdC.release();
      for (const path of ["/gov-hold-a1", "/gov-hold-a2", "/gov-hold-b", "/gov-hold-c"]) {
        expect(originGets(holdOrigin, path), `the held path ${path} saw exactly one GET`).toBe(1);
      }
      await assertAllAlive("after governance phase C");
    },
  );

  // ── Test 6: the lifecycle generation fence ────────────────────────────────

  test("the lifecycle generation fence at the callback", { timeout: 300_000 }, async () => {
    const resultsApp = apps.results;

    const readGeneration = async (): Promise<number> => {
      const res = await platform.query<{ jobsGeneration: number }>(
        `SELECT "jobsGeneration" FROM apps WHERE slug = $1`,
        [resultsApp.slug],
      );
      return must(res.rows[0], "the app's jobsGeneration row").jobsGeneration;
    };
    const oldGen = await readGeneration();

    // One job dispatched and held at the origin when the generation closes.
    origin.respond("/pre-archive", { json: { pre: true } });
    const hold = origin.hold("/pre-archive");
    const preArchiveJob = await submit(resultsApp, `${origin.origin}/pre-archive`);
    await awaitArrival(origin, "/pre-archive", hold);

    const archived = seen(await bob.post(`/api/v1/apps/${resultsApp.slug}/archive`), "the archive");
    expect(archived.status, "the archive").toBe(200);
    const unarchived = seen(
      await bob.post(`/api/v1/apps/${resultsApp.slug}/unarchive`),
      "the unarchive",
    );
    expect(unarchived.status, "the unarchive").toBe(200);

    const newGen = await readGeneration();
    expect(newGen, "the unarchive opened a new generation").not.toBe(oldGen);

    const cancelled = await pollTerminal(
      resultsApp.session.api,
      preArchiveJob,
      120_000,
      "to be cancelled by the archive",
    );
    expect(cancelled.status, "the archive cancelled the held job").toBe("cancelled");
    hold.release();

    // The callback identity comes from the job's immutable record.
    const record = await jobsDb.query<{
      app_id: string;
      env: string;
      owner_kind: string;
      owner_oid: string;
      type: string;
    }>(
      `SELECT app_id, env, owner_kind, owner_oid, type
         FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
      [preArchiveJob],
    );
    const row = must(record.rows[0], "the pre-archive job's record row");
    expect(row.env === "dev" || row.env === "prod", "the record's env is a tier").toBe(true);
    expect(row.owner_kind === "dev" || row.owner_kind === "user", "the record's owner kind").toBe(
      true,
    );
    const identity: JobsCallbackIdentity = {
      appId: row.app_id,
      env: row.env as "prod" | "dev",
      ownerKind: row.owner_kind as "user" | "dev",
      ownerOid: row.owner_oid,
      type: row.type,
    };
    expect(identity.type, "the record's type").toBe(JOBS_FETCH_QUALIFIED_TYPE);

    const presentCallback = async (generation: string, target: string): Promise<HttpReply> => {
      const token = await mintFetchCallback(identity, preArchiveJob, generation, target);
      return seen(
        await stack.request(platformCallbackUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json", [INSTRUCTION_HEADER]: token },
          body: Buffer.from(JSON.stringify({ url: target })),
        }),
        `the minted callback for ${target}`,
      );
    };

    // Positive control: the CURRENT generation dispatches — polled, because the
    // edge's projection learns the new generation by LISTEN/NOTIFY.
    origin.respond("/new-gen", { json: { gen: "new" } });
    await waitFor(
      stack,
      "the new-generation callback to dispatch",
      { timeoutMs: 60_000 },
      async () => {
        const reply = await presentCallback(String(newGen), `${origin.origin}/new-gen`);
        return reply.status === 200 ? true : undefined;
      },
    );
    expect(originGets(origin, "/new-gen"), "the new-generation callback dialled the origin").toBe(
      1,
    );

    // The fence: the archived generation refuses before any dial.
    const fenced = await presentCallback(String(oldGen), `${origin.origin}/old-gen`);
    expect(fenced.status, "the old-generation callback's refusal").toBe(403);
    expect(
      JobRequestErrorSchema.parse(fenced.json()).code,
      "the old-generation callback's code",
    ).toBe("outbound_forbidden");
    expect(originGets(origin, "/old-gen"), "the fenced callback dialled nothing").toBe(0);
    await assertAllAlive("after the generation fence");
  });

  // ── Test 7: a jobs crash after the remote effect ──────────────────────────

  test(
    "a jobs crash after the remote effect never reissues the GET",
    { timeout: 300_000 },
    async () => {
      const slowApp = apps.slow;

      origin.respond("/crash", { json: { crashed: true } });
      const hold = origin.hold("/crash");
      const jobId = await submit(slowApp, `${origin.origin}/crash`);
      await awaitArrival(origin, "/crash", hold);

      await stack.crash("jobs");
      // The fetch type's five-minute deadline runs from acceptance, and the
      // record's `created_at` IS that instant; shifting it back past the
      // deadline stands in for the elapsed outage time.
      await jobsDb.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
          SET created_at = created_at - interval '301 seconds'
        WHERE job_id = $1`,
        [jobId],
      );
      await stack.start("jobs");
      hold.release();

      await expectFailed(slowApp.session.api, jobId, "timeout", 120_000);
      const quietDeadline = Date.now() + 15_000;
      while (Date.now() < quietDeadline) await sleep(1_000);
      expect(originGets(origin, "/crash"), "the remote effect was never issued again").toBe(1);
      await assertAllAlive("after the jobs crash");
    },
  );

  // ── Test 8: SSRF controls with the dev allowance off ──────────────────────

  test(
    "SSRF controls hold with the dev allowance off, and the refusals are legible in the audit",
    { timeout: 300_000 },
    async () => {
      const slowApp = apps.slow;

      // The throttle's fixed window counts attempts, never refunds: stay inside
      // it by waiting out the remainder since this app's last submission.
      const waitUntil = slowApp.lastSubmitAt + 60_000;
      if (Date.now() < waitUntil) await sleep(waitUntil - Date.now());

      stack.setServiceEnv("egress", {
        NODE_EXTRA_CA_CERTS: bundlePath,
        EGRESS_ALLOW_PRIVATE: null,
      });
      await stack.restart("egress");

      const ssrfTargets = [
        `${origin.origin}/ssrf-loopback`,
        `http://localhost:${portOf(origin)}/ssrf-name`,
        `http://[::1]:${portOf(origin)}/ssrf-v6`,
        `${METADATA_ORIGIN}/latest/meta-data/`,
        `${PRIVATE_ORIGIN}/ssrf-private`,
      ];
      for (const target of ssrfTargets) {
        const jobId = await submit(slowApp, target);
        await expectFailed(slowApp.session.api, jobId, "upstream_error");
        await assertAllAlive(`after the SSRF refusal of ${target}`);
      }
      for (const path of ["/ssrf-loopback", "/ssrf-name", "/ssrf-v6", "/ssrf-private"]) {
        expect(originGets(origin, path), `no GET reached the origin at ${path}`).toBe(0);
      }

      // The audit is where an operator tells an SSRF refusal from an upstream
      // failure: a fetch row per refusal, outcome "refusal", status 403.
      await waitFor(
        stack,
        "the audit to carry a refusal fetch row for every SSRF target",
        { timeoutMs: 30_000, pollMs: 1_000 },
        async () => {
          const res = seen(
            await alice.get(`/api/v1/apps/${slowApp.slug}/audit?limit=200`),
            "the slow app's admin audit read",
          );
          expect(res.status, "the admin audit read").toBe(200);
          const rows = GatewayAuditPageSchema.parse(res.json()).rows.filter(
            (r) => r.capability === "fetch" && r.outcome === "refusal" && r.statusCode === 403,
          );
          const paths = [
            "/ssrf-loopback",
            "/ssrf-name",
            "/ssrf-v6",
            "/latest/meta-data/",
            "/ssrf-private",
          ];
          return paths.every((p) => rows.some((r) => r.path === p)) ? true : undefined;
        },
      );

      // Restore the dev allowance for any later work.
      stack.setServiceEnv("egress", { NODE_EXTRA_CA_CERTS: bundlePath });
      await stack.restart("egress");
    },
  );

  // ── Test 9: the final leak scan ───────────────────────────────────────────

  test(
    "no secret reaches a reply, a log, or exported telemetry",
    { timeout: 180_000 },
    async () => {
      const sealed: readonly SealedValue[] = [
        { label: "the prod connection secret", value: SECRET_PROD },
        { label: "the dev connection secret", value: SECRET_DEV },
        { label: "the gov connection secret", value: SECRET_GOV },
        { label: "the provider client secret", value: PROVIDER_CLIENT_SECRET },
        { label: "the upstream failure marker", value: UPSTREAM_MARKER },
        ...instructionTokens.map((t, i) => ({
          label: `a minted callback instruction token (#${i + 1})`,
          value: t,
        })),
      ];

      // Stop every service so each exporter's last batch is flushed before the
      // scans read what the processes actually emitted.
      for (const name of ["edge", "devGateway", "jobs", "portal", "egress"] as const) {
        await stack.stop(name);
      }

      for (const [i, reply] of seenReplies.entries()) {
        const found = leakIn(`${reply.headersJson}\n${reply.text}`, sealed);
        expect(
          found,
          `response #${i}${reply.what === undefined ? "" : ` (${reply.what})`}: no forbidden value leaked, found ${found === null ? "none" : found}`,
        ).toBeNull();
      }

      const logFiles = readdirSync(stack.logDir).filter((f) => f.endsWith(".log"));
      expect(logFiles.length, "the stack wrote service logs").toBeGreaterThan(0);
      for (const file of logFiles) {
        const found = leakIn(readFileSync(path.join(stack.logDir, file), "utf8"), sealed);
        expect(
          found,
          `the log file ${file}: no forbidden value leaked, found ${found === null ? "none" : found}`,
        ).toBeNull();
      }

      const telemetry = must(stack.telemetry ?? undefined, "the stack's telemetry capture");
      const payloads = telemetry.payloads;
      expect(
        payloads.some((p) => p.signal === "traces"),
        "the stack exported at least one traces payload",
      ).toBe(true);
      expect(telemetry.dropped, "the telemetry capture dropped nothing").toBe(0);
      const joined = payloads.map((p) => p.body).join("\n");
      expect(joined, "the exported traces carry the jobs fetch dispatch span").toContain(
        SPAN_JOBS_FETCH_DISPATCH,
      );
      expect(joined, "the exported traces carry the edge's callback span").toContain(
        SPAN_JOBS_FETCH_EDGE,
      );
      for (const [i, payload] of payloads.entries()) {
        const found = leakIn(payload.body, sealed) ?? urlAttributeLeak(payload.body);
        expect(
          found,
          `the ${payload.signal} payload #${i}: no forbidden value leaked, found ${found === null ? "none" : found}`,
        ).toBeNull();
      }
    },
  );
});
