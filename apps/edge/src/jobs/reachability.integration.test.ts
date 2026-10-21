import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import {
  HealthStatusSchema,
  JOBS_MAX_RESULT_BYTES,
  JOBS_REACHABILITY_CHECK,
} from "@azx-pbc/shared";

import { buildApp } from "../app.js";
import type { EdgeConfig } from "../config.js";
import { testEdgeConfig } from "../test/config.js";
import { FakeBlobReader, FakeRegistry, registryEntry } from "../test/fakes.js";
import { JobsReachability, probeJobsHealth } from "./reachability.js";

/**
 * The reachability observation against a real HTTP endpoint: the REAL probe
 * (`probeJobsHealth`, undici `request` — the forwarding seam's own client for
 * this hop) classifying a real server's answers, the REAL supervised loop
 * carrying them, and the REAL edge composition grading them into `/health` —
 * the production wiring, driven over loopback sockets with the cadence
 * shortened for the legs. The unit suite pins the state machine's transitions
 * on an injected probe; these legs prove the probe itself reaches through
 * HTTP and classifies by the wire contract.
 */

const APP_ID = "11111111-1111-4111-8111-111111111111";

/** A loopback HTTP server answering one of the jobs service's health shapes. */
class FakeJobsServer {
  readonly #server: Server;
  readonly #sessions = new Set<import("node:net").Socket>();
  /** What `/health` answers — replaced per leg. */
  status: "ok" | "degraded" | "error" = "ok";
  /** When set, `/health` answers garbage instead of the health contract. */
  offProtocol = false;
  /** When set, `/health` answers with this HTTP status instead of 200. */
  httpStatus = 200;
  /** When set (and not offProtocol), `/health` answers this exact body. */
  rawBody: string | null = null;

  constructor() {
    this.#server = createServer((_req, res) => {
      if (this.offProtocol) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not the health contract</html>");
        return;
      }
      if (this.httpStatus !== 200) {
        res.writeHead(this.httpStatus, { "content-type": "text/plain" });
        res.end("answering, but not as the health contract");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        this.rawBody ?? JSON.stringify({ status: this.status, service: "helix-jobs", uptime: 1 }),
      );
    });
    // Keep sockets alive between legs' probe rounds; destroyed on stop().
    this.#server.on("connection", (socket) => {
      this.#sessions.add(socket);
      socket.on("close", () => this.#sessions.delete(socket));
    });
  }

  get endpoint(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(0, "127.0.0.1", () => resolve(undefined)));
  }

  /** Refuse further connections — the unreachable leg's outage. */
  stop(): Promise<void> {
    for (const socket of this.#sessions) socket.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

/** Poll the loop's snapshot until a predicate holds, bounded — a wait this suite can see. */
async function eventually(what: string, read: () => boolean, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!read()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The edge config with jobs configured against the fake server's endpoint (the shared fixture, jobs overridden). */
function edgeConfig(jobsEndpoint: string | null): EdgeConfig {
  return testEdgeConfig({
    jobs: {
      servers: jobsEndpoint
        ? {
            jobs: {
              server: "jobs",
              endpoint: jobsEndpoint,
              edgeToJobsKey: new Uint8Array(32).fill(1),
              jobsToEdgeKey: new Uint8Array(32).fill(2),
            },
          }
        : {},
      timeoutMs: 30_000,
      refuseDiagnosticTypes: false,
    },
  });
}

describe("the reachability probe over real HTTP", () => {
  let jobsServer: FakeJobsServer;

  beforeAll(async () => {
    jobsServer = new FakeJobsServer();
    await jobsServer.start();
  });
  afterAll(async () => {
    await jobsServer.stop();
  });

  it("classifies a health-contract answer as reachable, carrying the server's own roll-up", async () => {
    jobsServer.status = "ok";
    const answer = await probeJobsHealth(jobsServer.endpoint, 1_000);
    expect(answer).toEqual({ outcome: "reachable", reported: "ok" });
    jobsServer.status = "degraded";
    expect(await probeJobsHealth(jobsServer.endpoint, 1_000)).toEqual({
      outcome: "reachable",
      reported: "degraded",
    });
  });

  it("classifies a non-200 status and a wrong-shaped JSON body as invalid_response, not as reachability", async () => {
    // Both branches the HTML leg cannot reach: a wire answer that parses
    // (status or JSON) but is not the shared health contract. A proxy's 503
    // and any other service's body must read exactly like the misrouted
    // endpoint's — never as a server identifying itself.
    jobsServer.httpStatus = 503;
    expect(await probeJobsHealth(jobsServer.endpoint, 1_000)).toEqual({
      outcome: "invalid_response",
    });
    jobsServer.httpStatus = 200;
    jobsServer.rawBody = JSON.stringify({ hello: "world" });
    expect(await probeJobsHealth(jobsServer.endpoint, 1_000)).toEqual({
      outcome: "invalid_response",
    });
    jobsServer.rawBody = null;
  });

  it("refuses an empty 200 answer — no contract body, no reachability", async () => {
    // The empty edge of the body space: a 200 with no body at all is an
    // answer that is not the health contract. It must classify
    // (invalid_response) — never throw out of the parse, never read as a
    // reachable server.
    const empty = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "0" });
      res.end();
    });
    await new Promise((resolve) => empty.listen(0, "127.0.0.1", () => resolve(undefined)));
    try {
      const answer = await probeJobsHealth(
        `http://127.0.0.1:${(empty.address() as AddressInfo).port}`,
        1_000,
      );
      expect(answer).toEqual({ outcome: "invalid_response" });
    } finally {
      await new Promise((resolve) => empty.close(() => resolve(undefined)));
    }
  });

  it("classifies a non-contract answer as invalid_response and a dead endpoint as no_answer", async () => {
    jobsServer.offProtocol = true;
    expect(await probeJobsHealth(jobsServer.endpoint, 1_000)).toEqual({
      outcome: "invalid_response",
    });
    jobsServer.offProtocol = false;
    const endpoint = jobsServer.endpoint;
    await jobsServer.stop();
    expect(await probeJobsHealth(endpoint, 250)).toEqual({
      outcome: "unreachable",
      reason: "no_answer",
    });
  });

  it("classifies a refused redirect as invalid_response — the endpoint answered, just not as the jobs service", async () => {
    // The probe-outcome vocabulary's contract (`JOBS_REACHABILITY_PROBE_OUTCOMES`)
    // puts a redirect in `invalid_response` — the same class the forwarding
    // seam reads a 3xx as on this hop — distinguishable from a dead endpoint's
    // `no_answer`: a redirecting misroute is a wrong-service answer, not a
    // dead one. The mechanism: the probe's undici `request` follows NO
    // redirects, so the 302 arrives as its own response (classified by status
    // below) and the redirect target is never contacted — a misrouted or
    // compromised endpoint answering 302 cannot launder itself into the jobs
    // plane's trust, which `targetHits` pins.
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "helix-jobs", uptime: 1 }));
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", () => resolve(undefined)));
    const targetEndpoint = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `${targetEndpoint}/health` });
      res.end();
    });
    await new Promise((resolve) => redirector.listen(0, "127.0.0.1", () => resolve(undefined)));
    try {
      const answer = await probeJobsHealth(
        `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`,
        1_000,
      );
      expect(answer).toEqual({ outcome: "invalid_response" });
      expect(targetHits).toBe(0);
    } finally {
      await Promise.all([
        new Promise((resolve) => redirector.close(() => resolve(undefined))),
        new Promise((resolve) => target.close(() => resolve(undefined))),
      ]);
    }
  });

  it("refuses a valid health body from a different helix service — reachable means the jobs service, not any contract answer", async () => {
    // Every helix service answers the same shared health contract, and the
    // body's `service` field is the only thing naming which one spoke. The
    // vocabulary's contract: reachable is "answered as the jobs service the
    // deployment map names"; an answer from another service is
    // invalid_response. A one-digit port typo pointing this edge's probe at a
    // sibling helix process must not read as a reachable jobs server — the
    // misroute would otherwise sit behind a green check while every forward
    // fails at the instruction layer.
    const impostor = new FakeJobsServer();
    impostor.rawBody = JSON.stringify({
      status: "ok",
      service: "helix-edge",
      uptime: 1,
    });
    await impostor.start();
    try {
      const answer = await probeJobsHealth(impostor.endpoint, 1_000);
      expect(answer).toEqual({ outcome: "invalid_response" });
    } finally {
      await impostor.stop();
    }
  });

  it("never throws, whatever the endpoint does", async () => {
    // A probe that threw would escape into the loop's pass; the real probe's
    // contract is a classified answer for every transport ending.
    await expect(probeJobsHealth("http://127.0.0.1:1/health", 250)).resolves.toEqual({
      outcome: "unreachable",
      reason: "no_answer",
    });
  });

  it("is bounded against an endpoint that accepts and never answers", async () => {
    // The hang the per-probe timeout exists for: a listening socket that
    // says nothing. The probe must come back `no_answer` within its bound —
    // measured, so a regression to an unbounded wait fails here.
    const blackHole = createServer(() => {}); // accepts, never responds
    await new Promise((resolve) => blackHole.listen(0, "127.0.0.1", () => resolve(undefined)));
    const { port } = blackHole.address() as AddressInfo;
    try {
      const startedAt = Date.now();
      const answer = await probeJobsHealth(`http://127.0.0.1:${port}`, 500);
      expect(answer).toEqual({ outcome: "unreachable", reason: "no_answer" });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      await new Promise((resolve) => blackHole.close(() => resolve(undefined)));
    }
  });

  it("is bounded against a body that stalls after the headers — the read half of the bound", async () => {
    // The black-hole leg pins the HEADERS half; this one pins the read: an
    // endpoint that answers its headers and then never finishes the body must
    // still come back inside the probe's bound — the answer began (the
    // vocabulary's invalid_response, the forwarder's own classification for a
    // body that failed mid-read), and the wait is measured.
    const bodyStall = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":"ok"'); // partial body, never ended
    });
    await new Promise((resolve) => bodyStall.listen(0, "127.0.0.1", () => resolve(undefined)));
    const { port } = bodyStall.address() as AddressInfo;
    try {
      const startedAt = Date.now();
      const answer = await probeJobsHealth(`http://127.0.0.1:${port}`, 500);
      expect(answer).toEqual({ outcome: "invalid_response" });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      await new Promise((resolve) => bodyStall.close(() => resolve(undefined)));
    }
  });

  it("refuses a body past the hop's result allowance instead of buffering it whole", async () => {
    // The forwarding seam reads this hop's bodies under JOBS_MAX_RESULT_BYTES —
    // "anything bigger is unusable" — destroying the source at the trip, so a
    // misrouted endpoint cannot drive unbounded buffering into this process.
    // The probe's read holds the same bound: a 200 answer whose body dwarfs
    // any legitimate health body (a static file, a padded proxy page) is
    // invalid_response, never read past the allowance to find out.
    const bigServer = new FakeJobsServer();
    bigServer.rawBody = JSON.stringify({
      status: "ok",
      service: "helix-jobs",
      uptime: 1,
      padding: "x".repeat(JOBS_MAX_RESULT_BYTES),
    });
    await bigServer.start();
    try {
      const answer = await probeJobsHealth(bigServer.endpoint, 1_000);
      expect(answer).toEqual({ outcome: "invalid_response" });
    } finally {
      await bigServer.stop();
    }
  });

  it("accepts a body at exactly the hop's result allowance — the cap is a strict bound", async () => {
    // The oversized leg pins the refusal one byte past the allowance; this
    // one pins the reachable side of the boundary: a valid jobs body of
    // EXACTLY JOBS_MAX_RESULT_BYTES is the documented maximum, legal, and
    // answered as reachability — the forwarding seam's own rule for the same
    // cap. A comparison flipped to >= would silently refuse every
    // answer at the boundary.
    const shaped = (pad: number): string =>
      JSON.stringify({ status: "ok", service: "helix-jobs", uptime: 1, padding: "x".repeat(pad) });
    const atCap = shaped(JOBS_MAX_RESULT_BYTES - shaped(0).length);
    expect(atCap.length).toBe(JOBS_MAX_RESULT_BYTES); // the leg's premise, verified
    const capServer = new FakeJobsServer();
    capServer.rawBody = atCap;
    await capServer.start();
    try {
      const answer = await probeJobsHealth(capServer.endpoint, 1_000);
      expect(answer).toEqual({ outcome: "reachable", reported: "ok" });
    } finally {
      await capServer.stop();
    }
  });
});

describe("the edge composition's jobs_reachability check", () => {
  // Shortened cadence: the legs drive the real loop on real timers.
  const INTERVAL = 50;

  it("per-server observation rolls up through /health: one down degrades, all down errors — without a user request", async () => {
    const jobsA = new FakeJobsServer();
    const jobsB = new FakeJobsServer();
    await Promise.all([jobsA.start(), jobsB.start()]);
    const config = edgeConfig(jobsA.endpoint);
    config.jobs.servers["jobs-eu"] = {
      server: "jobs-eu",
      endpoint: jobsB.endpoint,
      edgeToJobsKey: new Uint8Array(32).fill(3),
      jobsToEdgeKey: new Uint8Array(32).fill(4),
    };
    const registry = new FakeRegistry([
      registryEntry({ appId: APP_ID, slug: "demo", blobPrefix: "apps/x/1/" }),
    ]);
    const loop = new JobsReachability({
      servers: [
        { server: "jobs", endpoint: jobsA.endpoint },
        { server: "jobs-eu", endpoint: jobsB.endpoint },
      ],
      intervalMs: INTERVAL,
      timeoutMs: 500,
      probe: probeJobsHealth,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const app = buildApp({
      config,
      registry,
      blob: new FakeBlobReader(),
      jobsReachability: () => loop.snapshot(),
    });
    try {
      await app.ready();
      loop.start();

      // The probes observed both servers on their own cadence — no user
      // request was ever made against the edge.
      await eventually("both servers to be observed reachable", () => {
        const body = loop.snapshot();
        return body.servers.every((s) => s.state === "reachable");
      });
      const healthy = await app.inject({ url: "/health", headers: { host: "localhost:8080" } });
      expect(healthy.statusCode).toBe(200);
      const healthyBody = HealthStatusSchema.parse(healthy.json());
      const okCheck = healthyBody.checks?.find((c) => c.name === JOBS_REACHABILITY_CHECK);
      expect(okCheck?.status).toBe("ok");
      expect(healthyBody.status).toBe("ok");

      // One server dies under the edge: the next pass observes it, and the
      // body degrades — evidence produced by the probe, never by traffic.
      await jobsB.stop();
      await eventually("jobs-eu to be observed unreachable", () => {
        const body = loop.snapshot();
        return body.servers.find((s) => s.server === "jobs-eu")?.state === "unreachable";
      });
      const degraded = await app.inject({ url: "/health", headers: { host: "localhost:8080" } });
      expect(degraded.statusCode).toBe(200); // always-200: the body carries it
      const degradedBody = HealthStatusSchema.parse(degraded.json());
      const degradedCheck = degradedBody.checks?.find((c) => c.name === JOBS_REACHABILITY_CHECK);
      expect(degradedCheck?.status).toBe("degraded");
      expect(degradedCheck?.detail).toContain("jobs-eu");
      expect(degradedBody.status).toBe("degraded");

      // The last server goes too: the whole configured plane is refusing this
      // edge, and the check errors.
      await jobsA.stop();
      await eventually("jobs to be observed unreachable too", () => {
        const body = loop.snapshot();
        return body.servers.find((s) => s.server === "jobs")?.state === "unreachable";
      });
      const down = await app.inject({ url: "/health", headers: { host: "localhost:8080" } });
      const downBody = HealthStatusSchema.parse(down.json());
      const downCheck = downBody.checks?.find((c) => c.name === JOBS_REACHABILITY_CHECK);
      expect(downCheck?.status).toBe("error");
      expect(downCheck?.detail).toMatch(/every configured jobs server is unreachable/);
      expect(downBody.status).toBe("error");
    } finally {
      await loop.stop();
      await app.close();
      await Promise.all([jobsA.stop().catch(() => {}), jobsB.stop().catch(() => {})]);
    }
  }, 15_000);

  it("a fully disabled install carries no jobs check at all", async () => {
    const registry = new FakeRegistry([
      registryEntry({ appId: APP_ID, slug: "demo", blobPrefix: "apps/x/1/" }),
    ]);
    const app = buildApp({
      config: edgeConfig(null),
      registry,
      blob: new FakeBlobReader(),
    });
    try {
      await app.ready();
      const res = await app.inject({ url: "/health", headers: { host: "localhost:8080" } });
      const body = HealthStatusSchema.parse(res.json());
      expect(body.checks?.some((c) => c.name === JOBS_REACHABILITY_CHECK)).toBe(false);
      expect(body.status).toBe("ok");
    } finally {
      await app.close();
    }
  });

  it("the real loop releases its timer on stop — the cadence stops without a user request", async () => {
    const jobsServer = new FakeJobsServer();
    await jobsServer.start();
    const loop = new JobsReachability({
      servers: [{ server: "jobs", endpoint: jobsServer.endpoint }],
      intervalMs: 50,
      timeoutMs: 500,
      probe: probeJobsHealth,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      loop.start();
      await eventually("the first pass to land", () => loop.snapshot().passes >= 1);
      await loop.stop();
      const passes = loop.snapshot().passes;
      await new Promise((r) => setTimeout(r, 100));
      expect(loop.snapshot().passes).toBe(passes);
      expect(loop.snapshot().started).toBe(false);
    } finally {
      await loop.stop();
      await jobsServer.stop();
    }
  });
});
