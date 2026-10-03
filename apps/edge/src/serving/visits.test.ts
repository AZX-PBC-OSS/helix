import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { VisibilityMode } from "@azx-pbc/shared";
import { INSTR_APP_VISITS } from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { buildApp } from "../app.js";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { hashSessionToken, newSessionToken } from "../auth/sessions.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  registryEntry,
} from "../test/fakes.js";
import type { FastifyRequest } from "fastify";
import {
  makeVisitRecorder,
  MAX_VISITS_IN_FLIGHT,
  truncateIp,
  VISIT_DEDUPE_MS,
  visitorHash,
  type VisitRecord,
  type VisitStore,
} from "./visits.js";

/**
 * ADR-0050: the edge appends one `app_visits` row per top-level document it
 * serves past the gate, and nothing else. These pin what counts, what never
 * counts, and that the row carries no raw IP.
 */

const APP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_APP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PREFIX = "apps/d/1/";
const CLIENT_IP = "203.0.113.7";
const DOCUMENT = {
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  accept: "text/html",
};

class FakeVisitStore implements VisitStore {
  readonly rows: VisitRecord[] = [];
  fail = false;
  async record(visit: VisitRecord): Promise<void> {
    if (this.fail) throw new Error("db down");
    this.rows.push(visit);
  }
  async close(): Promise<void> {}
}

function buildEdge(visibilityMode: VisibilityMode, slug = "vis") {
  const blob = new FakeBlobReader();
  blob.set(`${PREFIX}index.html`, {
    body: "<!doctype html><body>app</body>",
    contentType: "text/html; charset=utf-8",
    etag: '"html-1"',
  });
  blob.set(`${PREFIX}app.js`, { body: "js", contentType: "text/javascript" });
  blob.set(`${PREFIX}report.csv`, { body: "a,b", contentType: "text/csv", etag: '"csv-1"' });
  const sessions = new FakeSessionStore();
  const visits = new FakeVisitStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({ appId: APP_ID, slug, blobPrefix: PREFIX, visibilityMode }),
    ]),
    blob,
    sessions,
    oidc: new FakeOidcClient(),
    visits,
  });
  return { app, sessions, visits, host: `${slug}.local.helix.azxlabs.io` };
}

async function seedSession(sessions: FakeSessionStore): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId: APP_ID,
    user: {
      oid: "oid-alice",
      displayName: "Alice",
      name: null,
      email: null,
      kind: "user",
      groups: [],
    },
    refreshDueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, APP_ID, hashSessionToken(token));
  return token;
}

/** The write is fire-and-forget; let its promise settle before asserting. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

async function load(
  app: FastifyInstance,
  host: string,
  opts: { url?: string; method?: "GET" | "HEAD"; headers?: Record<string, string> } = {},
) {
  const res = await app.inject({
    method: opts.method ?? "GET",
    url: opts.url ?? "/",
    remoteAddress: CLIENT_IP,
    headers: { host, ...(opts.headers ?? DOCUMENT) },
  });
  await settle();
  return res;
}

let recording: RecordingTelemetry | null = null;
afterEach(async () => {
  await recording?.restore();
  recording = null;
});

describe("what counts as a visit", () => {
  it("records a public app's document load with a hash and a prefix, never the IP", async () => {
    const edge = buildEdge("public");
    const res = await load(edge.app, edge.host);
    expect(res.statusCode).toBe(200);
    expect(edge.visits.rows).toHaveLength(1);
    const [row] = edge.visits.rows;
    expect(row?.appId).toBe(APP_ID);
    expect(row?.ipPrefix).toBe("203.0.113.0/24");
    expect(row?.visitorHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain(CLIENT_IP);
  });

  it("records an internal app's document load once the session gate passes", async () => {
    const edge = buildEdge("internal");
    const token = await seedSession(edge.sessions);
    const res = await load(edge.app, edge.host, {
      headers: { ...DOCUMENT, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(edge.visits.rows).toHaveLength(1);
  });

  it("records a deep link served by the SPA fallback", async () => {
    const edge = buildEdge("public");
    const res = await load(edge.app, edge.host, { url: "/some/client/route" });
    expect(res.statusCode).toBe(200);
    expect(edge.visits.rows).toHaveLength(1);
  });

  it("records a revalidated document (304)", async () => {
    const edge = buildEdge("public");
    const res = await load(edge.app, edge.host, {
      headers: { ...DOCUMENT, "if-none-match": '"html-1"' },
    });
    expect(res.statusCode).toBe(304);
    expect(edge.visits.rows).toHaveLength(1);
  });

  it("gives the same visitor the same hash, and a different hash on another app", async () => {
    const key = Buffer.alloc(32, 7);
    expect(visitorHash(key, APP_ID, CLIENT_IP)).toBe(visitorHash(key, APP_ID, CLIENT_IP));
    expect(visitorHash(key, APP_ID, CLIENT_IP)).not.toBe(visitorHash(key, OTHER_APP_ID, CLIENT_IP));
    expect(visitorHash(key, APP_ID, CLIENT_IP)).not.toBe(visitorHash(key, APP_ID, "203.0.113.8"));
  });
});

describe("what never counts", () => {
  it("does not record a gated app that redirected to login", async () => {
    for (const mode of ["internal", "password"] as const) {
      const edge = buildEdge(mode);
      const res = await load(edge.app, edge.host);
      expect(res.statusCode).toBe(302);
      expect(edge.visits.rows, mode).toHaveLength(0);
    }
  });

  it("does not record subresources", async () => {
    const edge = buildEdge("public");
    const res = await load(edge.app, edge.host, {
      url: "/app.js",
      headers: { "sec-fetch-dest": "script" },
    });
    expect(res.statusCode).toBe(200);
    expect(edge.visits.rows).toHaveLength(0);
  });

  it("does not record a request without Sec-Fetch-Dest (scanners, curl, most bots)", async () => {
    const edge = buildEdge("public");
    const res = await load(edge.app, edge.host, { headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(edge.visits.rows).toHaveLength(0);
  });

  it("does not record HEAD, an iframe embed, or a 404", async () => {
    const edge = buildEdge("public");
    await load(edge.app, edge.host, { method: "HEAD" });
    await load(edge.app, edge.host, { headers: { ...DOCUMENT, "sec-fetch-dest": "iframe" } });
    const miss = await load(edge.app, edge.host, {
      url: "/missing.png",
      headers: { "sec-fetch-dest": "document" },
    });
    expect(miss.statusCode).toBe(404);
    expect(edge.visits.rows).toHaveLength(0);
  });

  it.each([
    ["sec-purpose", "prefetch"],
    ["sec-purpose", "prefetch;prerender"],
    ["purpose", "prefetch"],
  ])("does not record a speculative load (%s: %s)", async (header, value) => {
    const edge = buildEdge("public");
    const res = await load(edge.app, edge.host, { headers: { ...DOCUMENT, [header]: value } });
    expect(res.statusCode).toBe(200);
    expect(edge.visits.rows).toHaveLength(0);
  });

  it("does not record a revalidated non-HTML file opened directly", async () => {
    const edge = buildEdge("public");
    const res = await load(edge.app, edge.host, {
      url: "/report.csv",
      headers: { ...DOCUMENT, "if-none-match": '"csv-1"' },
    });
    expect(res.statusCode).toBe(304);
    expect(edge.visits.rows).toHaveLength(0);
  });

  it("does not record gateway calls", async () => {
    const edge = buildEdge("public");
    await load(edge.app, edge.host, { url: "/_api/me" });
    expect(edge.visits.rows).toHaveLength(0);
  });
});

describe("failure and telemetry", () => {
  it("serves the document normally when the write fails, and counts the loss", async () => {
    recording = startRecordingTelemetry();
    const edge = buildEdge("public");
    edge.visits.fail = true;
    const res = await load(edge.app, edge.host);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("app");

    const points = await recording.metrics();
    const failed = points.find(
      (p) => p.name === INSTR_APP_VISITS && p.attributes["helix.outcome"] === "failed",
    );
    expect(failed?.value).toBe(1);
    expect(failed?.attributes["helix.app_id"]).toBe(APP_ID);
  });

  it("counts a recorded visit with only bounded, non-personal dimensions", async () => {
    recording = startRecordingTelemetry();
    const edge = buildEdge("public");
    await load(edge.app, edge.host);
    const points = await recording.metrics();
    const recorded = points.find((p) => p.name === INSTR_APP_VISITS);
    expect(recorded?.value).toBe(1);
    expect(Object.keys(recorded?.attributes ?? {}).sort()).toEqual([
      "helix.app_id",
      "helix.outcome",
    ]);
  });

  it("puts nothing IP-shaped on any span for a recorded load", async () => {
    recording = startRecordingTelemetry();
    const edge = buildEdge("public");
    await load(edge.app, edge.host);
    for (const span of recording.spans()) {
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(String(value), `${span.name} ${key}`).not.toContain("203.0.113");
      }
    }
  });
});

describe("the recorder's bounds", () => {
  const KEY = Buffer.alloc(32, 9);
  const fakeReq = (ip: string): FastifyRequest =>
    ({ ip, log: { warn: () => {} } }) as unknown as FastifyRequest;

  async function outcomes(r: RecordingTelemetry): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const p of await r.metrics()) {
      if (p.name !== INSTR_APP_VISITS) continue;
      const outcome = String(p.attributes["helix.outcome"]);
      out[outcome] = (out[outcome] ?? 0) + p.value;
    }
    return out;
  }

  it("records a repeat visitor once per minute, then again after it", async () => {
    recording = startRecordingTelemetry();
    const store = new FakeVisitStore();
    let clock = 1_000_000;
    const record = makeVisitRecorder({ store, key: KEY, now: () => clock });
    record(fakeReq(CLIENT_IP), APP_ID);
    clock += VISIT_DEDUPE_MS - 1;
    record(fakeReq(CLIENT_IP), APP_ID);
    clock += 1;
    record(fakeReq(CLIENT_IP), APP_ID);
    // A different app is a different visitor.
    record(fakeReq(CLIENT_IP), OTHER_APP_ID);
    await settle();
    expect(store.rows).toHaveLength(3);
    expect(await outcomes(recording)).toEqual({ recorded: 3, deduplicated: 1 });
  });

  it("treats an IPv4-mapped address as the IPv4 it carries", async () => {
    const store = new FakeVisitStore();
    let clock = 0;
    const record = makeVisitRecorder({ store, key: KEY, now: () => clock });
    record(fakeReq("1.2.3.4"), APP_ID);
    clock += VISIT_DEDUPE_MS;
    record(fakeReq("::ffff:1.2.3.4"), APP_ID);
    await settle();
    const [a, b] = store.rows;
    expect(a?.visitorHash).toBe(b?.visitorHash);
    expect(a?.ipPrefix).toBe("1.2.3.0/24");
    expect(b?.ipPrefix).toBe("1.2.3.0/24");
  });

  it("drops past the in-flight cap without marking the visitor as seen", async () => {
    recording = startRecordingTelemetry();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const rows: VisitRecord[] = [];
    const store: VisitStore = {
      record: async (v) => {
        await gate;
        rows.push(v);
      },
      close: async () => {},
    };
    const record = makeVisitRecorder({ store, key: KEY, now: () => 0 });
    for (let i = 0; i < MAX_VISITS_IN_FLIGHT + 1; i++) record(fakeReq(`198.51.100.${i}`), APP_ID);
    expect(await outcomes(recording)).toEqual({ dropped: 1 });

    release();
    await settle();
    // The dropped visitor gets a row on their next load: nothing marked it seen.
    record(fakeReq(`198.51.100.${MAX_VISITS_IN_FLIGHT}`), APP_ID);
    await settle();
    expect(rows).toHaveLength(MAX_VISITS_IN_FLIGHT + 1);
    expect(await outcomes(recording)).toEqual({ recorded: MAX_VISITS_IN_FLIGHT + 1, dropped: 1 });
  });

  it("does not dedupe visits it cannot attribute to a visitor", async () => {
    const store = new FakeVisitStore();
    const record = makeVisitRecorder({ store, key: null, now: () => 0 });
    record(fakeReq(CLIENT_IP), APP_ID);
    record(fakeReq(CLIENT_IP), APP_ID);
    await settle();
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]?.visitorHash).toBeNull();
  });
});

describe("truncateIp", () => {
  it.each([
    ["198.51.100.42", "198.51.100.0/24"],
    ["::ffff:198.51.100.42", "198.51.100.0/24"],
    ["2001:db8:abcd:12::1", "2001:db8:abcd::/48"],
    ["2001:0db8:00ab::", "2001:db8:ab::/48"],
    ["::1", "0:0:0::/48"],
    ["fe80::1%eth0", "fe80:0:0::/48"],
  ])("%s → %s", (ip, prefix) => {
    expect(truncateIp(ip)).toBe(prefix);
  });

  it.each([undefined, "", "not-an-ip", "300.1.1.1"])("rejects %s", (ip) => {
    expect(truncateIp(ip)).toBeNull();
  });
});
