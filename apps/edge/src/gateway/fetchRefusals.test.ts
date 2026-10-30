import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ATTR_APP_ID,
  ATTR_CAPABILITY,
  ATTR_OUTCOME,
  INSTR_GATEWAY_CALLS,
} from "@azx-pbc/shared/telemetry";
import {
  startRecordingTelemetry,
  type RecordedMetric,
  type RecordingTelemetry,
} from "@azx-pbc/telemetry/testing";
import { buildApp } from "../app.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import { until, withServer } from "../test/socket.js";
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
 * How the browser fetch route ledgers and meters its refusals, end to end
 * through `buildApp`: the request-body size refusal at both of its points
 * (before minting, and while streaming to egress). The policy core's own
 * view of the same refusals is in `fetchPolicy.test.ts`.
 */

// One recording for the file: the edge's ProxyTracer and meter cache their
// first provider, so metric assertions read before/after deltas.
let recording: RecordingTelemetry;

beforeAll(() => {
  recording = startRecordingTelemetry();
});

afterEach(() => {
  recording.reset();
});

afterAll(async () => {
  await recording.restore();
});

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = { host: "demo.local.helix.azxlabs.io" };
const ORIGIN = "https://demo.local.helix.azxlabs.io:8080";
const URL_PATH = "/_api/fetch/https://api.github.com/x";
const CAP = 64;
const key = deriveInstructionKey(randomBytes(32));

/** Drains the request body the way egress would, then answers 200. */
class DrainingEgress implements EgressProvider {
  calls: EgressRequest[] = [];

  async proxy(req: EgressRequest): Promise<EgressResponse> {
    this.calls.push(req);
    if (req.body instanceof Readable) {
      for await (const chunk of req.body) void chunk;
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from("{}")]),
      outcome: "ok",
    };
  }

  async close(): Promise<void> {}
}

function buildEdge(): { app: FastifyInstance; egress: DrainingEgress; usage: FakeUsageStore } {
  const egress = new DrainingEgress();
  const usage = new FakeUsageStore();
  const app = buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      allowUnauthenticated: false,
      fetch: { egressUrl: null, instructionSecret: null, timeoutMs: 30_000, maxBodyBytes: CAP },
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: "apps/a/1/",
        visibilityMode: "public",
        fetch: {
          connections: new Map([["https://api.github.com", { kind: "keyless" }]]),
          requestsPerDay: null,
          shim: false,
        },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    usage,
    egress,
    instructionKey: key,
  });
  return { app, egress, usage };
}

/** `helix.gateway.calls` for this app's fetch capability, per outcome. */
function callsByOutcome(points: RecordedMetric[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of points) {
    if (
      p.name !== INSTR_GATEWAY_CALLS ||
      p.attributes[ATTR_CAPABILITY] !== "fetch" ||
      p.attributes[ATTR_APP_ID] !== APP_ID
    ) {
      continue;
    }
    const outcome = String(p.attributes[ATTR_OUTCOME]);
    out.set(outcome, (out.get(outcome) ?? 0) + p.value);
  }
  return out;
}

async function outcomeDelta(run: () => Promise<void>): Promise<Map<string, number>> {
  const before = callsByOutcome(await recording.metrics());
  await run();
  const after = callsByOutcome(await recording.metrics());
  const delta = new Map<string, number>();
  for (const [outcome, n] of after) {
    const moved = n - (before.get(outcome) ?? 0);
    if (moved !== 0) delta.set(outcome, moved);
  }
  return delta;
}

describe("/_api/fetch — the request-body size refusal", () => {
  it("ledgers a declared oversized body as too_large: never dialled, no budget spent", async () => {
    const { app, egress, usage } = buildEdge();
    const delta = await outcomeDelta(async () => {
      const res = await app.inject({
        method: "POST",
        url: URL_PATH,
        headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
        payload: Buffer.alloc(CAP + 1, 0x61), // a truthful content-length over the cap
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().code).toBe("too_large");
    });

    expect(egress.calls).toHaveLength(0);
    await until(() => usage.records.length > 0, "the size refusal's ledger row");
    expect(usage.records).toEqual([
      expect.objectContaining({
        capability: "fetch",
        model: "https://api.github.com",
        outcome: "too_large",
        statusCode: 413,
        errorDetail: "request body exceeds the size cap",
        method: "POST",
        path: "/x",
      }),
    ]);
    // Its own metric label, never the allowlist denial's `forbidden`.
    expect(delta).toEqual(new Map([["too_large", 1]]));
    expect(await usage.fetchRequestsToday()).toBe(0);
    await app.close();
  });

  it("ledgers a streamed body that trips the cap as a 413 refusal that counts: egress was dialled", async () => {
    // No content-length: only the byte counter can find this one, and by then
    // the instruction is already on its way to egress.
    const { app, egress, usage } = buildEdge();
    const delta = await outcomeDelta(async () => {
      await withServer(app, async (base) => {
        const res = await undiciRequest(`${base}${URL_PATH}`, {
          method: "POST",
          headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
          body: Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(40, 0x61))),
        }).catch(() => undefined);
        expect(res?.statusCode).toBe(413);
        expect(((await res?.body.json()) as { code: string }).code).toBe("too_large");
      });
    });

    expect(egress.calls).toHaveLength(1);
    expect(usage.records).toEqual([
      expect.objectContaining({
        capability: "fetch",
        outcome: "refusal",
        statusCode: 413,
        errorDetail: "request body exceeds the size cap",
        method: "POST",
      }),
    ]);
    expect(delta).toEqual(new Map([["refusal", 1]]));
    expect(await usage.fetchRequestsToday()).toBe(1);
  });
});
