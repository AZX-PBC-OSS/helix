import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { type JWTPayload, jwtVerify } from "jose";
import { INSTRUCTION_JWT_TYP } from "@azx-pbc/shared";
import { buildApp } from "../app.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { deriveInstructionKey } from "./instruction.js";
import type { EgressProvider, EgressRequest, EgressResponse } from "./egressProvider.js";

/**
 * The `/_api/fetch` policy plane (fetch-proxy design §7): gate + CSRF, the
 * manifest proxy-origin allowlist, the per-app request budget, attested-
 * instruction minting, and metering. A fake egress captures what the edge
 * forwards; the egress service itself is tested in apps/egress.
 */

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "apps/a/1/";
const HOST = { host: "demo.localtest.me" };
const ORIGIN = "https://demo.localtest.me:8080";
const secret = randomBytes(32);
const key = deriveInstructionKey(secret);

class FakeEgress implements EgressProvider {
  calls: EgressRequest[] = [];
  outcome = "ok";
  /** When set, the response body egress "returns" — used to exercise the cap. */
  responseBody: Readable | null = null;
  /** When set, the request body is fully drained so tests can measure its size. */
  drainRequest = false;
  drainedBytes = 0;
  async proxy(req: EgressRequest): Promise<EgressResponse> {
    this.calls.push(req);
    if (this.drainRequest && req.body && typeof req.body !== "string") {
      for await (const chunk of req.body as Readable) this.drainedBytes += (chunk as Buffer).length;
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: this.responseBody ?? Readable.from([Buffer.from(JSON.stringify({ ok: true }))]),
      outcome: this.outcome,
    };
  }
  async close(): Promise<void> {}
}

interface FetchEdge {
  app: FastifyInstance;
  egress: FakeEgress;
  usage: FakeUsageStore;
}

function buildFetchEdge(
  opts: {
    connections?: Map<string, string | null>;
    requestsPerDay?: number | null;
    withEgress?: boolean;
    maxBodyBytes?: number;
  } = {},
): FetchEdge {
  const egress = new FakeEgress();
  const usage = new FakeUsageStore();
  const connections =
    opts.connections ??
    new Map<string, string | null>([
      ["https://api.github.com", null],
      ["https://api.stripe.com", "stripe"],
    ]);
  const app = buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      allowUnauthenticated: false,
      fetch: {
        egressUrl: null,
        instructionSecret: null,
        timeoutMs: 30_000,
        maxBodyBytes: opts.maxBodyBytes ?? 10 * 1024 * 1024,
      },
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: PREFIX,
        visibilityMode: "public", // anonymous caller — no session needed
        fetch: { connections, requestsPerDay: opts.requestsPerDay ?? null, shim: false },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    usage,
    egress: opts.withEgress === false ? null : egress,
    instructionKey: opts.withEgress === false ? null : key,
  });
  return { app, egress, usage };
}

async function decode(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, key, { typ: INSTRUCTION_JWT_TYP });
  return payload;
}

describe("/_api/fetch", () => {
  it("proxies a keyless allowlisted origin, mints an instruction, meters it", async () => {
    const { app, egress, usage } = buildFetchEdge();
    const res = await app.inject({
      method: "GET",
      url: "/_api/fetch/https://api.github.com/users/octocat",
      headers: { ...HOST, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(egress.calls).toHaveLength(1);
    expect(egress.calls[0]!.target).toBe("https://api.github.com/users/octocat");
    const claims = await decode(egress.calls[0]!.instruction);
    expect(claims.origin).toBe("https://api.github.com");
    expect(claims.connection).toBeUndefined();
    expect(claims.userOid).toBe("anon");
    expect(usage.records).toContainEqual(
      expect.objectContaining({
        capability: "fetch",
        model: "https://api.github.com",
        outcome: "ok",
      }),
    );
    await app.close();
  });

  it("names the connection in the instruction for a secret-bound origin", async () => {
    const { app, egress } = buildFetchEdge();
    const res = await app.inject({
      method: "GET",
      url: "/_api/fetch/https://api.stripe.com/v1/charges",
      headers: { ...HOST, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect((await decode(egress.calls[0]!.instruction)).connection).toBe("stripe");
    await app.close();
  });

  it("preserves path and query in the forwarded target", async () => {
    const { app, egress } = buildFetchEdge();
    await app.inject({
      method: "GET",
      url: "/_api/fetch/https://api.github.com/search?q=helix&page=2",
      headers: { ...HOST, origin: ORIGIN },
    });
    expect(egress.calls[0]!.target).toBe("https://api.github.com/search?q=helix&page=2");
    await app.close();
  });

  it("refuses an origin that is not a proxied origin (egress untouched)", async () => {
    const { app, egress } = buildFetchEdge();
    const res = await app.inject({
      method: "GET",
      url: "/_api/fetch/https://api.evil.com/steal",
      headers: { ...HOST, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    expect(egress.calls).toHaveLength(0);
    await app.close();
  });

  it("rejects a cross-origin (CSRF) caller", async () => {
    const { app, egress } = buildFetchEdge();
    const res = await app.inject({
      method: "GET",
      url: "/_api/fetch/https://api.github.com/x",
      headers: { ...HOST, origin: "https://evil.localtest.me:8080" },
    });
    expect(res.statusCode).toBe(403);
    expect(egress.calls).toHaveLength(0);
    await app.close();
  });

  it("blocks when the daily request budget is exhausted", async () => {
    const { app, egress, usage } = buildFetchEdge({ requestsPerDay: 1 });
    usage.fetchToday = 1;
    const res = await app.inject({
      method: "GET",
      url: "/_api/fetch/https://api.github.com/x",
      headers: { ...HOST, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(429);
    expect(egress.calls).toHaveLength(0);
    expect(usage.records).toContainEqual(
      expect.objectContaining({ capability: "fetch", outcome: "quota_blocked" }),
    );
    await app.close();
  });

  it("503s when the capability is not configured (no egress)", async () => {
    const { app } = buildFetchEdge({ withEgress: false });
    const res = await app.inject({
      method: "GET",
      url: "/_api/fetch/https://api.github.com/x",
      headers: { ...HOST, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  // Body-size cap (issue #8): the edge caps both hops independently of egress.
  it("refuses an over-cap request body with 413 before forwarding (fast-path)", async () => {
    const { app, egress, usage } = buildFetchEdge({ maxBodyBytes: 64 });
    const res = await app.inject({
      method: "POST",
      url: "/_api/fetch/https://api.github.com/x",
      headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(65, 0x61), // 65 > 64, with a truthful content-length
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("too_large");
    expect(egress.calls).toHaveLength(0); // never dialed egress
    expect(usage.records).not.toContainEqual(expect.objectContaining({ outcome: "ok" }));
    await app.close();
  });

  it("forwards an under-cap request body intact (no false trip)", async () => {
    const { app, egress } = buildFetchEdge({ maxBodyBytes: 64 });
    egress.drainRequest = true;
    const res = await app.inject({
      method: "POST",
      url: "/_api/fetch/https://api.github.com/x",
      headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(40, 0x61),
    });
    expect(res.statusCode).toBe(200);
    expect(egress.calls).toHaveLength(1);
    expect(egress.drainedBytes).toBe(40); // body transited intact
    await app.close();
  });

  it("truncates an over-cap response body streaming back to the app", async () => {
    // Over a real socket, not inject: a mid-stream destroy is a *truncation*
    // (200 + short body), not a clean error — inject can't model that.
    const { app, egress } = buildFetchEdge({ maxBodyBytes: 64 });
    // 320 bytes across chunks, no content-length ⇒ the fast-path is inert.
    egress.responseBody = Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(40, 0x61)));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const res = await undiciRequest(`${base}/_api/fetch/https://api.github.com/big`, {
      method: "GET",
      headers: { host: "demo.localtest.me", origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    let got = 0;
    try {
      for await (const chunk of res.body) got += (chunk as Buffer).length;
    } catch {
      // premature close — the expected shape of a truncated response
    }
    expect(got).toBeLessThanOrEqual(64); // counter cut it at the cap
    expect(got).toBeLessThan(320); // the full body never reached the app
    await app.close();
  });
});
