import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  JOBS_CAPACITY_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_DATABASE_CHECK,
  JOBS_HEALTH_CHECK_NAMES,
  JOBS_INTAKE_CHECK,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_REACHABILITY_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_WORKER_CHECK,
  resolveJobsCapacityLimits,
  type HealthStatus,
} from "@azx-pbc/shared";

import { SERVICE_NAME as PORTAL_SERVICE_NAME } from "../../portal/src/serviceName.js";
import {
  loadRelayTargets,
  observeTarget,
  RELAY_CHECK_EVENT,
  RELAY_DETAIL_LIMIT,
  RELAY_OBSERVED_EVENT,
  RELAY_TARGETS_ENV,
  RELAY_TARGET_KINDS,
  runRelay,
  type RelayCheckLine,
  type RelayLine,
  type RelayTarget,
} from "../scripts/health-relay.js";
import { buildApp } from "./app.js";
import { loadJobsConfig } from "./config.js";
import { SERVICE_NAME as JOBS_SERVICE_NAME } from "./serviceName.js";
import { JobsStorage } from "./storage.js";
import {
  makeReceiver,
  MemoryAdmission,
  MemoryCancellation,
  MemoryLifecycle,
  MemoryObservation,
  runningCleanup,
} from "./test/instructions.js";

/**
 * The body-aware health relay (`scripts/health-relay.ts` — what
 * infra/azure/modules/alerts-jobs.bicep schedules). The HTTP boundary is real:
 * every scenario answers from a local `node:http` server, and the assertions
 * read the emitted lines as a Log Analytics rule would. The redaction sweep
 * runs over every scenario's recorded output — a line may never carry the
 * host, port, scheme, request path, or any error text, because the lines land
 * in retained logs.
 */

interface TestServer {
  server: Server;
  url: string;
  port: number;
  hits: number;
}

const servers: TestServer[] = [];
/** Every relay line any scenario produced, for the per-scenario redaction sweep. */
const emitted: string[] = [];

function record(lines: RelayLine[]): RelayLine[] {
  emitted.push(JSON.stringify(lines));
  return lines;
}

async function startServer(handler: RequestListener): Promise<TestServer> {
  const entry: TestServer = { server: undefined as unknown as Server, url: "", port: 0, hits: 0 };
  const server = createServer((req, res) => {
    entry.hits += 1;
    // A client that hangs up mid-response (the too-large and timeout scenarios
    // abort deliberately) must not surface as an unhandled stream error.
    req.on("error", () => {});
    res.on("error", () => {});
    handler(req, res);
  });
  server.on("error", () => {});
  entry.server = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  entry.port = address.port;
  entry.url = `http://127.0.0.1:${address.port}/health`;
  servers.push(entry);
  return entry;
}

async function startHealthServer(status: number, payload: string): Promise<TestServer> {
  return startServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  });
}

/** A port nothing listens on any more — the connection-refused scenario. */
async function startAndCloseServer(): Promise<TestServer> {
  const entry = await startServer(() => {});
  await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  entry.server.closeAllConnections();
  return entry;
}

afterEach(async () => {
  // Redaction first, while every started server's port is still known.
  const forbidden = ["127.0.0.1", "http", "/health", ...servers.map((s) => String(s.port))];
  for (const line of emitted) {
    for (const secret of forbidden) {
      expect(line, `relay line leaked ${JSON.stringify(secret)}: ${line}`).not.toContain(secret);
    }
  }
  emitted.length = 0;

  for (const entry of servers) {
    const closed = new Promise<void>((resolve) => entry.server.close(() => resolve()));
    entry.server.closeAllConnections();
    await closed;
  }
  servers.length = 0;
  vi.restoreAllMocks();
});

/** The jobs service's body order — deliberately not the expected-list order. */
const BODY_ORDER = [
  JOBS_INTAKE_CHECK,
  JOBS_DATABASE_CHECK,
  JOBS_CAPACITY_CHECK,
  JOBS_WORKER_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
];

function jobsBody(checks?: HealthStatus["checks"]): HealthStatus {
  return {
    status: "ok",
    service: RELAY_TARGET_KINDS.jobs.service,
    uptime: 4.2,
    checks: checks ?? BODY_ORDER.map((name) => ({ name, status: "ok" as const })),
  };
}

function portalBody(checks?: HealthStatus["checks"]): HealthStatus {
  return { status: "ok", service: RELAY_TARGET_KINDS.portal.service, uptime: 9.9, checks };
}

function jobsTarget(url: string, target = "jobs-prod"): RelayTarget {
  return { kind: "jobs", target, url };
}

function portalTarget(url: string, target = "portal-prod"): RelayTarget {
  return { kind: "portal", target, url };
}

function checkLine(lines: RelayLine[], name: string): RelayCheckLine | undefined {
  return lines.find((line): line is RelayCheckLine => "check" in line && line.check === name);
}

function json(body: HealthStatus): string {
  return JSON.stringify(body);
}

describe("observeTarget — a healthy jobs body", () => {
  test("seven ok checks emit seven check lines in body order, then the observed line", async () => {
    const server = await startHealthServer(200, json(jobsBody()));
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(lines).toHaveLength(BODY_ORDER.length + 1);
    const checkLines = lines.filter((line): line is RelayCheckLine => "check" in line);
    expect(checkLines.map((line) => line.check)).toEqual(BODY_ORDER);
    expect(checkLines).toEqual(
      BODY_ORDER.map((name) => ({
        event: RELAY_CHECK_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        check: name,
        status: "ok",
      })),
    );
    expect(lines[BODY_ORDER.length]).toEqual({
      event: RELAY_OBSERVED_EVENT,
      kind: "jobs",
      target: "jobs-prod",
      outcome: "observed",
      status: "ok",
      missing: [],
    });
  });

  test("a degraded check carries its detail and metrics, and never lastSuccessAt", async () => {
    const body = jobsBody(
      BODY_ORDER.map((name) =>
        name === JOBS_CAPACITY_CHECK
          ? {
              name,
              status: "degraded" as const,
              detail: "retained 81% of cap",
              lastSuccessAt: "2026-10-20T08:00:00.000Z",
              metrics: { retainedPct: 81 },
            }
          : { name, status: "ok" as const },
      ),
    );
    const server = await startHealthServer(200, json(body));
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(checkLine(lines, JOBS_CAPACITY_CHECK)).toEqual({
      event: RELAY_CHECK_EVENT,
      kind: "jobs",
      target: "jobs-prod",
      check: JOBS_CAPACITY_CHECK,
      status: "degraded",
      detail: "retained 81% of cap",
      metrics: { retainedPct: 81 },
    });
    expect(JSON.stringify(lines)).not.toContain("lastSuccessAt");
  });

  test("checks absent from the body are reported missing in expected-list order", async () => {
    const body = jobsBody(
      BODY_ORDER.filter((name) => name !== JOBS_WORKER_CHECK && name !== JOBS_CLEANUP_CHECK).map(
        (name) => ({
          name,
          status: "ok" as const,
        }),
      ),
    );
    const server = await startHealthServer(200, json(body));
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(lines).toHaveLength(6); // five check lines + the observed line
    expect(lines[5]).toEqual({
      event: RELAY_OBSERVED_EVENT,
      kind: "jobs",
      target: "jobs-prod",
      outcome: "observed",
      status: "ok",
      missing: [JOBS_WORKER_CHECK, JOBS_CLEANUP_CHECK],
    });
  });

  test("a non-jobs check name is not emitted, and a duplicated name is emitted once, first report winning", async () => {
    const body = jobsBody([
      { name: JOBS_INTAKE_CHECK, status: "ok" },
      { name: JOBS_DATABASE_CHECK, status: "ok" },
      { name: JOBS_CAPACITY_CHECK, status: "ok" },
      { name: JOBS_WORKER_CHECK, status: "ok" },
      { name: JOBS_CLEANUP_CHECK, status: "ok" },
      { name: JOBS_WORKER_CHECK, status: "degraded", detail: "second report" },
      { name: JOBS_SWEEPER_CHECK, status: "ok" },
      { name: JOBS_LIFECYCLE_RECOVERY_CHECK, status: "ok" },
      { name: "registry-projection", status: "degraded" },
    ]);
    const server = await startHealthServer(200, json(body));
    const lines = record(await observeTarget(jobsTarget(server.url)));

    const checkLines = lines.filter((line): line is RelayCheckLine => "check" in line);
    expect(checkLines.map((line) => line.check)).toEqual(BODY_ORDER);
    expect(lines.some((line) => "check" in line && line.check === "registry-projection")).toBe(
      false,
    );
    expect(lines.some((line) => "check" in line && line.detail === "second report")).toBe(false);
  });
});

describe("observeTarget — detail truncation", () => {
  test("a long detail is truncated to exactly RELAY_DETAIL_LIMIT characters", async () => {
    const body = jobsBody(
      BODY_ORDER.map((name) =>
        name === JOBS_CAPACITY_CHECK
          ? { name, status: "degraded" as const, detail: "x".repeat(1200) }
          : { name, status: "ok" as const },
      ),
    );
    const server = await startHealthServer(200, json(body));
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(checkLine(lines, JOBS_CAPACITY_CHECK)?.detail).toBe("x".repeat(RELAY_DETAIL_LIMIT));
  });
});

describe("observeTarget — the portal kind", () => {
  test("a degraded jobs_lifecycle_delivery is the one check line, and the observed line follows", async () => {
    const body: HealthStatus = {
      ...portalBody([
        {
          name: JOBS_LIFECYCLE_DELIVERY_CHECK,
          status: "degraded",
          detail: "backlog 12",
          metrics: { backlog: 12 },
        },
        { name: "unrelated-check", status: "ok" },
      ]),
      status: "degraded",
    };
    const server = await startHealthServer(200, json(body));
    const lines = record(await observeTarget(portalTarget(server.url)));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      event: RELAY_CHECK_EVENT,
      kind: "portal",
      target: "portal-prod",
      check: JOBS_LIFECYCLE_DELIVERY_CHECK,
      status: "degraded",
      detail: "backlog 12",
      metrics: { backlog: 12 },
    });
    expect(lines[1]).toEqual({
      event: RELAY_OBSERVED_EVENT,
      kind: "portal",
      target: "portal-prod",
      outcome: "observed",
      status: "degraded",
      missing: [],
    });
  });

  test("a portal body with no checks reports the expected check as missing", async () => {
    const server = await startHealthServer(200, json(portalBody()));
    const lines = record(await observeTarget(portalTarget(server.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "portal",
        target: "portal-prod",
        outcome: "observed",
        status: "ok",
        missing: [JOBS_LIFECYCLE_DELIVERY_CHECK],
      },
    ]);
  });
});

describe("observeTarget — off-protocol answers", () => {
  test("a jobs target answered by a different helix service emits no check lines", async () => {
    const body = { ...jobsBody(), service: "helix-edge" };
    const server = await startHealthServer(200, json(body));
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "off_protocol",
        missing: [],
      },
    ]);
  });

  test("a portal target answered by the jobs service is off-protocol", async () => {
    const server = await startHealthServer(200, json(jobsBody()));
    const lines = record(await observeTarget(portalTarget(server.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "portal",
        target: "portal-prod",
        outcome: "off_protocol",
        missing: [],
      },
    ]);
  });

  test("a 503 with a valid-looking body is off-protocol", async () => {
    const server = await startHealthServer(503, json(jobsBody()));
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "off_protocol",
        missing: [],
      },
    ]);
  });

  test("a 302 is off-protocol and the redirect destination receives zero requests", async () => {
    const destination = await startHealthServer(200, json(jobsBody()));
    const redirector = await startServer((req, res) => {
      res.writeHead(302, { location: destination.url });
      res.end();
    });
    const lines = record(await observeTarget(jobsTarget(redirector.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "off_protocol",
        missing: [],
      },
    ]);
    expect(destination.hits).toBe(0);
    expect(redirector.hits).toBe(1);
  });

  test("a body larger than the limit is off-protocol", async () => {
    const server = await startHealthServer(200, json(jobsBody()));
    const lines = record(await observeTarget(jobsTarget(server.url), { bodyLimitBytes: 32 }));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "off_protocol",
        missing: [],
      },
    ]);
  });

  test("invalid JSON is off-protocol", async () => {
    const server = await startHealthServer(200, "{not json at all");
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "off_protocol",
        missing: [],
      },
    ]);
  });

  test("schema-invalid JSON (status outside the vocabulary) is off-protocol", async () => {
    const server = await startHealthServer(
      200,
      JSON.stringify({
        status: "fine",
        service: RELAY_TARGET_KINDS.jobs.service,
        uptime: 1,
        checks: [],
      }),
    );
    const lines = record(await observeTarget(jobsTarget(server.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "off_protocol",
        missing: [],
      },
    ]);
  });
});

describe("observeTarget — no answer", () => {
  test("a server that never answers resolves to no_answer within a small timeout", async () => {
    const server = await startServer(() => {
      // Never answers — the request stays open until the relay's timeout aborts it.
    });
    const started = Date.now();
    const lines = record(await observeTarget(jobsTarget(server.url), { timeoutMs: 250 }));
    const elapsed = Date.now() - started;

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "no_answer",
        missing: [],
      },
    ]);
    expect(elapsed).toBeLessThan(3000);
  });

  test("a server that answers headers and then stalls mid-body is no_answer, not off_protocol", async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":"ok","service":"helix-jobs","uptime":1,"checks":[');
      // Never finishes the body — the timeout must abort the read mid-stream.
    });
    const started = Date.now();
    const lines = record(await observeTarget(jobsTarget(server.url), { timeoutMs: 250 }));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "no_answer",
        missing: [],
      },
    ]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a closed port is no_answer", async () => {
    const closed = await startAndCloseServer();
    const lines = record(await observeTarget(jobsTarget(closed.url)));

    expect(lines).toEqual([
      {
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "no_answer",
        missing: [],
      },
    ]);
  });
});

describe("runRelay — configuration", () => {
  function spyStderr() {
    return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  }

  function stderrText(spy: ReturnType<typeof spyStderr>): string {
    return spy.mock.calls.map((args) => String(args[0])).join("");
  }

  test.each([
    {
      name: "missing env",
      value: undefined,
      markers: [] as string[],
    },
    {
      name: "not JSON",
      value: "{{{{MARKER-NOT-JSON",
      markers: ["MARKER-NOT-JSON"],
    },
    {
      name: "a bad kind",
      value: JSON.stringify([
        { kind: "edge", target: "jobs-prod", url: "http://127.0.0.1:1/health" },
      ]),
      markers: ["127.0.0.1", "jobs-prod"],
    },
    {
      name: "an uppercase target",
      value: JSON.stringify([
        { kind: "jobs", target: "Jobs-Prod", url: "http://127.0.0.1:1/health" },
      ]),
      markers: ["127.0.0.1", "Jobs-Prod"],
    },
    {
      name: "an ftp url",
      value: JSON.stringify([
        { kind: "jobs", target: "jobs-prod", url: "ftp://127.0.0.1:1/health" },
      ]),
      markers: ["127.0.0.1", "ftp:"],
    },
    {
      name: "a duplicate (kind, target) pair",
      value: JSON.stringify([
        { kind: "jobs", target: "jobs-prod", url: "http://127.0.0.1:1/health" },
        { kind: "jobs", target: "jobs-prod", url: "http://127.0.0.1:2/health" },
      ]),
      markers: ["127.0.0.1"],
    },
  ])("$name → exit 1, no lines, and the env value never on stderr", async ({ value, markers }) => {
    const stderr = spyStderr();
    const write = vi.fn();

    const result = await runRelay(value === undefined ? {} : { [RELAY_TARGETS_ENV]: value }, write);

    expect(result).toBe(1);
    expect(write).not.toHaveBeenCalled();
    const output = stderrText(stderr);
    expect(output).toContain(RELAY_TARGETS_ENV);
    expect(output).toContain("infra/azure/modules/alerts-jobs.bicep");
    if (value !== undefined) expect(output).not.toContain(value);
    for (const marker of markers) expect(output).not.toContain(marker);
  });

  test("loadRelayTargets throws the fixed message — never the value — for unparseable JSON", () => {
    expect(() => loadRelayTargets({ [RELAY_TARGETS_ENV]: "{{{{MARKER-THROW" })).toThrowError(
      new RegExp(`^${RELAY_TARGETS_ENV} is missing or invalid`),
    );
    try {
      loadRelayTargets({ [RELAY_TARGETS_ENV]: "{{{{MARKER-THROW" });
    } catch (error) {
      expect(error instanceof Error && error.message.includes("MARKER-THROW")).toBe(false);
    }
  });
});

describe("runRelay — observing", () => {
  test("two targets emit each target's lines together, in the targets' order, and exit 0", async () => {
    const ok = await startHealthServer(200, json(jobsBody()));
    const closed = await startAndCloseServer();
    const env = {
      [RELAY_TARGETS_ENV]: JSON.stringify([
        { kind: "jobs", target: "jobs-alpha", url: ok.url },
        { kind: "jobs", target: "jobs-beta", url: closed.url },
      ]),
    };
    const written: string[] = [];
    const write = (line: string) => {
      written.push(line);
      emitted.push(line);
    };

    const result = await runRelay(env, write);

    expect(result).toBe(0);
    const lines = written.map((line) => JSON.parse(line) as RelayLine);
    expect(lines).toHaveLength(BODY_ORDER.length + 2);
    // The first target's seven check lines and observed line come first, then the second target's.
    expect(
      lines
        .slice(0, BODY_ORDER.length)
        .every((line) => "check" in line && line.target === "jobs-alpha"),
    ).toBe(true);
    expect(lines[BODY_ORDER.length]).toEqual({
      event: RELAY_OBSERVED_EVENT,
      kind: "jobs",
      target: "jobs-alpha",
      outcome: "observed",
      status: "ok",
      missing: [],
    });
    expect(lines[BODY_ORDER.length + 1]).toEqual({
      event: RELAY_OBSERVED_EVENT,
      kind: "jobs",
      target: "jobs-beta",
      outcome: "no_answer",
      missing: [],
    });
  });
});

describe("relay vocabulary pins", () => {
  test("the jobs kind expects exactly the jobs service's own checks — never the edge's or the portal's", () => {
    expect([...RELAY_TARGET_KINDS.jobs.checks].sort()).toEqual(
      JOBS_HEALTH_CHECK_NAMES.filter(
        (name) => name !== JOBS_REACHABILITY_CHECK && name !== JOBS_LIFECYCLE_DELIVERY_CHECK,
      ).sort(),
    );
    expect(RELAY_TARGET_KINDS.portal.checks).toEqual([JOBS_LIFECYCLE_DELIVERY_CHECK]);
  });

  test("each kind's expected service is that service's own SERVICE_NAME", () => {
    expect(RELAY_TARGET_KINDS.jobs.service).toBe(JOBS_SERVICE_NAME);
    expect(RELAY_TARGET_KINDS.portal.service).toBe(PORTAL_SERVICE_NAME);
  });
});

describe("the relay against the real jobs listener", () => {
  // The relay's expected set is pinned above against the vocabulary; this pins
  // it against the producer, so a check the jobs service stops reporting (or
  // renames) shows up as `missing` here before it shows up in Azure.
  const config = loadJobsConfig({
    JOBS_SERVER_ID: "jobs",
    JOBS_DATABASE_URL: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
    JOBS_ACCEPTING: "true",
    JOBS_EDGE_TO_JOBS_SECRET: "uFEfLTTVeHJK0+P/dQEWv8ccOyFrkZw7InR0I52V4/0=",
    JOBS_PORTAL_TO_JOBS_SECRET: "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=",
    JOBS_JOBS_TO_EDGE_SECRET: "gDZ5bWRVuYC58CVmc4rXPjvCzEtuoQZ4Hn0v2UXPUaU=",
    JOBS_EDGE_PROD_URL: "https://edge.internal.helix",
    JOBS_EDGE_DEV_URL: "https://edge.dev.internal.helix",
  });

  async function listen(
    storageReady: boolean,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const storage = new JobsStorage({
      databaseUrl: config.databaseUrl,
      statementTimeoutMs: config.statementTimeoutMs,
      check: async () =>
        storageReady ? { kind: "compatible", schemaVersion: 45 } : { kind: "schema_missing" },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    storage.start();
    await new Promise((resolve) => setImmediate(resolve));
    const now = (): string => new Date().toISOString();
    const app = buildApp({
      storage,
      instructions: makeReceiver().auth,
      lifecycle: new MemoryLifecycle(),
      admission: new MemoryAdmission(),
      cancellation: new MemoryCancellation(),
      observation: new MemoryObservation(),
      worker: () => ({ started: true, workerRegistered: true }),
      recovery: () => ({
        started: true,
        passes: 1,
        lastPassAt: now(),
        lastOkPassAt: now(),
        reconciled: 0,
        lifecycle: { outstanding: 0, oldestPendingAt: null },
      }),
      cleanup: runningCleanup,
      intake: () => ({
        configuredAccepting: true,
        phase: "applied",
        boundServer: null,
        appliedAt: now(),
        lastAttemptAt: now(),
      }),
      capacityLimits: resolveJobsCapacityLimits(),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    return {
      url: `${address}/health`,
      close: async () => {
        await app.close();
        await storage.stop();
      },
    };
  }

  test("a serving jobs service is observed with every expected check and nothing missing", async () => {
    const jobs = await listen(true);
    try {
      const lines = record(await observeTarget(jobsTarget(jobs.url)));
      const checks = lines.filter(
        (line): line is RelayCheckLine => line.event === RELAY_CHECK_EVENT,
      );
      expect(checks.map((line) => line.check).sort()).toEqual(
        [...RELAY_TARGET_KINDS.jobs.checks].sort(),
      );
      expect(checks.every((line) => line.status === "ok")).toBe(true);
      expect(lines.at(-1)).toEqual({
        event: RELAY_OBSERVED_EVENT,
        kind: "jobs",
        target: "jobs-prod",
        outcome: "observed",
        status: "ok",
        missing: [],
      });
    } finally {
      await jobs.close();
    }
  });

  test("an unusable store reaches the relay as a jobs_database error under an observed outcome", async () => {
    const jobs = await listen(false);
    try {
      const lines = record(await observeTarget(jobsTarget(jobs.url)));
      expect(checkLine(lines, JOBS_DATABASE_CHECK)).toMatchObject({
        status: "error",
        detail: expect.stringContaining("migration") as unknown,
      });
      expect(lines.at(-1)).toMatchObject({ outcome: "observed", status: "error", missing: [] });
    } finally {
      await jobs.close();
    }
  });
});
