import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { type JobRequestError } from "@azx-pbc/shared";
import {
  type JobsCancelForward,
  type JobsForwarder,
  type JobsRecordSpec,
  type JobsResultForward,
  type JobsSnapshotForward,
  type JobsSubmitForward,
  type JobsSubmitSpec,
} from "../jobs/forwarder.js";
import { buildApp } from "../app.js";
import { buildDevGateway } from "../devGateway/app.js";
import { hashDevToken } from "@azx-pbc/shared/devToken";
import type { DevTokenStore } from "../devGateway/devTokenStore.js";
import { hashSessionToken, newSessionToken } from "../auth/sessions.js";
import type { UsageStore } from "../gateway/usage.js";
import type { JobsSubmissionThrottle } from "../gateway/jobsThrottle.js";
import { testAuthConfig, testDevGatewayConfig, testEdgeConfig } from "./config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  registryEntry,
} from "./fakes.js";

/**
 * The shared harness for the app-facing jobs route suites: one forwarder fake
 * (all four operations, each with its own captured specs and queued verdict)
 * and the builders for the edge and dev-gateway serving surfaces. The route
 * suites assert decisions against the fake; the forwarder's own transport is
 * tested against a real socket in `jobs/forwarder.test.ts`, and the
 * route↔forwarder join through the shared verifying receiver in
 * `gateway/jobs.test.ts`.
 */

export const JOBS_APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const JOBS_HOST = { host: "demo.local.helix.azxlabs.io" };
export const JOBS_ORIGIN = "https://demo.local.helix.azxlabs.io:8080";

/** What one forward handed the fake, tagged with the operation that produced it. */
export type CapturedRecordSpec = JobsRecordSpec & {
  operation: "snapshot" | "result" | "cancel";
};

export class FakeJobsForwarder implements JobsForwarder {
  readonly #configured = new Set<string>();
  submitSpecs: JobsSubmitSpec[] = [];
  recordSpecs: CapturedRecordSpec[] = [];
  submitVerdict: JobsSubmitForward = {
    kind: "accepted",
    status: 202,
    accepted: { server: "jobs", jobId: "job-123", status: "queued" },
    rawBody: new TextEncoder().encode(
      JSON.stringify({ server: "jobs", jobId: "job-123", status: "queued" }),
    ),
  };
  snapshotVerdict: JobsSnapshotForward = {
    kind: "found",
    status: 200,
    snapshot: {
      server: "jobs",
      jobId: "job-123",
      type: "jobs:fetch",
      status: "queued",
      attempt: null,
      progress: null,
      cancellationRequested: false,
      resultExpiresAt: null,
      recordExpiresAt: null,
      error: null,
    },
    rawBody: new TextEncoder().encode(
      JSON.stringify({
        server: "jobs",
        jobId: "job-123",
        type: "jobs:fetch",
        status: "queued",
        attempt: null,
        progress: null,
        cancellationRequested: false,
        resultExpiresAt: null,
        recordExpiresAt: null,
        error: null,
      }),
    ),
  };
  resultVerdict: JobsResultForward = {
    kind: "found",
    status: 200,
    rawBody: new TextEncoder().encode('{"served":"result"}'),
  };
  cancelVerdict: JobsCancelForward = {
    kind: "accepted",
    status: 202,
    cancellation: { server: "jobs", jobId: "job-123", cancellationRequested: true },
    rawBody: new TextEncoder().encode(
      JSON.stringify({ server: "jobs", jobId: "job-123", cancellationRequested: true }),
    ),
  };

  constructor(...configured: string[]) {
    for (const s of configured) this.#configured.add(s);
  }

  has(server: string): boolean {
    return this.#configured.has(server);
  }

  async submit(spec: JobsSubmitSpec): Promise<JobsSubmitForward> {
    this.submitSpecs.push(spec);
    return this.submitVerdict;
  }

  async snapshot(spec: JobsRecordSpec): Promise<JobsSnapshotForward> {
    this.recordSpecs.push({ ...spec, operation: "snapshot" });
    return this.snapshotVerdict;
  }

  async result(spec: JobsRecordSpec): Promise<JobsResultForward> {
    this.recordSpecs.push({ ...spec, operation: "result" });
    return this.resultVerdict;
  }

  async cancel(spec: JobsRecordSpec): Promise<JobsCancelForward> {
    this.recordSpecs.push({ ...spec, operation: "cancel" });
    return this.cancelVerdict;
  }

  async close(): Promise<void> {}
}

/** Registry/serving options the builders accept (everything else defaults). */
export interface JobsHarnessOpts {
  visibilityMode?: "internal" | "public" | "group";
  /** The app's jobs grant in the projection; null = no grant at all. */
  jobs?: { types: string[] } | null;
  jobsGeneration?: string;
  appSlug?: string;
  archived?: boolean;
  loaded?: boolean;
  /** The gateway request ledger; null (default) = submissions are not recorded. */
  usage?: UsageStore | null;
  /**
   * The submission throttle buckets; omitted, the app falls back to the
   * in-memory store over the platform defaults. Injected to share one
   * throttle across builds.
   */
  jobsSubmissionThrottle?: JobsSubmissionThrottle | null;
}

export interface JobsHarness {
  app: FastifyInstance;
  forwarder: FakeJobsForwarder;
  sessions: FakeSessionStore;
  usage: UsageStore | null;
}

/** The edge build with any forwarder (the fake in the decision suites, the real one in the join tests). */
export function buildJobsEdgeApp(
  forwarder: JobsForwarder,
  opts: JobsHarnessOpts = {},
): { app: FastifyInstance; sessions: FakeSessionStore; usage: UsageStore | null } {
  const sessions = new FakeSessionStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry(
      [
        registryEntry({
          appId: JOBS_APP_ID,
          slug: opts.appSlug ?? "demo",
          blobPrefix: "apps/a/1/",
          visibilityMode: opts.visibilityMode ?? "internal",
          jobs: opts.jobs === undefined ? { types: ["jobs:fetch"] } : opts.jobs,
          archived: opts.archived ?? false,
          ...(opts.jobsGeneration !== undefined ? { jobsGeneration: opts.jobsGeneration } : {}),
        }),
      ],
      { loaded: opts.loaded ?? true },
    ),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    jobsForwarder: forwarder,
    usage: opts.usage ?? null,
    jobsSubmissionThrottle: opts.jobsSubmissionThrottle ?? null,
  });
  return { app, sessions, usage: opts.usage ?? null };
}

export function buildJobsEdge(
  opts: { forwarder?: FakeJobsForwarder } & JobsHarnessOpts = {},
): JobsHarness {
  const forwarder = opts.forwarder ?? new FakeJobsForwarder("jobs");
  return { ...buildJobsEdgeApp(forwarder, opts), forwarder };
}

/** The disabled build: no forwarding seam wired — the app alone answers. */
export function buildDisabledJobsEdge(opts: JobsHarnessOpts = {}): JobsHarness {
  const sessions = new FakeSessionStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: JOBS_APP_ID,
        slug: "demo",
        blobPrefix: "apps/a/1/",
        visibilityMode: "internal",
        jobs: { types: ["jobs:fetch"] },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    jobsForwarder: null,
    usage: opts.usage ?? null,
    jobsSubmissionThrottle: opts.jobsSubmissionThrottle ?? null,
  });
  // The forwarder field is never consulted on this build; the type wants one.
  return { app, forwarder: new FakeJobsForwarder(), sessions, usage: opts.usage ?? null };
}

export async function seedJobsSession(
  sessions: FakeSessionStore,
  oid: string,
  kind: "user" | "password" = "user",
): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId: JOBS_APP_ID,
    user: { oid, displayName: oid, name: null, email: null, kind, groups: [] },
    refreshDueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, JOBS_APP_ID, hashSessionToken(token));
  return token;
}

export function isJobsError(value: unknown, code: string): value is JobRequestError {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === code;
}

// ── The dev-gateway surface ──────────────────────────────────────────────────

export const JOBS_DEV_APP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const JOBS_DEV_BEARER = "dev-token-plant";
export const JOBS_DEV_ORIGIN = "https://myapp.lovable.app";

export function fakeDevTokens(): DevTokenStore {
  return {
    async resolve(tokenHash: string) {
      return tokenHash === hashDevToken(JOBS_DEV_BEARER)
        ? {
            appId: JOBS_DEV_APP_ID,
            developerOid: "oid-developer",
            origins: [JOBS_DEV_ORIGIN],
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          }
        : null;
    },
    async originAllowed() {
      return false;
    },
    async close() {},
  };
}

export async function buildDevJobsEdge(
  jobsForwarder: JobsForwarder | null,
): Promise<FastifyInstance> {
  return buildDevGateway({
    config: testDevGatewayConfig(),
    registry: new FakeRegistry([
      registryEntry({
        appId: JOBS_DEV_APP_ID,
        slug: "myapp",
        blobPrefix: "apps/d/1/",
        visibilityMode: "internal",
        jobs: { types: ["jobs:fetch"] },
      }),
    ]),
    devTokens: fakeDevTokens(),
    appData: null,
    usage: null,
    llmProvider: null,
    egress: null,
    instructionKey: null,
    jobsForwarder,
    portal: null,
  });
}
