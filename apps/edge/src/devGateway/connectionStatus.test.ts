import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashDevToken, newDevToken } from "@azx-pbc/shared/devToken";
import { ConnectionStatusRequestSchema, type ConnectionStatusResponse } from "@azx-pbc/shared";
import { ROUTE_CONSENT_STATUS_DEV, SPAN_CONSENT_STATUS_DEV } from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { buildDevGateway } from "./app.js";
import type { DevTokenRow, DevTokenStore } from "./devTokenStore.js";
import { testDevGatewayConfig } from "../test/config.js";
import { FakeAppDataStore, FakeRegistry, FakeUsageStore, registryEntry } from "../test/fakes.js";
import type {
  PortalProvider,
  PortalProxyRequest,
  PortalProxyResponse,
} from "../routing/portalProvider.js";

/**
 * The dev tier's connection-status read (ADR-0031 as amended) — the bearer
 * GET that answers the row-state word. The read rides a scripted fake portal
 * provider (the dev consent-start test's seam style), so every assertion here
 * is against the real route and the real dev-token resolver — only the portal
 * hop is fake.
 */

const APP_ID = "11111111-1111-4111-8111-111111111111";
const SLUG = "myapp";
const HOST = { host: "dev-api.local.helix.azxlabs.io" };
const DEV_ORIGIN = "https://myapp.lovable.app";
const OTHER_REGISTERED_ORIGIN = "https://editor.dev.example";
const DEV_BEARER = "PLANTED-DEV-BEARER-TOKEN-VALUE";
const STATUS_URL = `/${SLUG}/_api/connections/asana/status`;

/** In-memory dev-token store keyed by hash (the real store's shape). */
class FakeDevTokenStore implements DevTokenStore {
  readonly rows = new Map<string, DevTokenRow>();
  add(token: string, row: DevTokenRow): void {
    this.rows.set(hashDevToken(token), row);
  }
  async resolve(tokenHash: string): Promise<DevTokenRow | null> {
    return this.rows.get(tokenHash) ?? null;
  }
  async originAllowed(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

/** The fake status seam: captures every call, answers the scripted contract. */
class FakeStatusPortal implements PortalProvider {
  readonly requests: { target: string; body: string }[] = [];
  response: ConnectionStatusResponse = { status: "not_connected" };
  body: string | null = null;
  status = 200;
  error: Error | null = null;

  async proxy(req: PortalProxyRequest): Promise<PortalProxyResponse> {
    const chunks: Buffer[] = [];
    if (req.body) {
      for await (const chunk of req.body) chunks.push(chunk as Buffer);
    }
    this.requests.push({ target: req.target, body: Buffer.concat(chunks).toString("utf8") });
    if (this.error) throw this.error;
    return {
      status: this.status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(this.body ?? JSON.stringify(this.response))]),
    };
  }

  async close(): Promise<void> {}
}

function liveTokenRow(origins: string[] = [DEV_ORIGIN, OTHER_REGISTERED_ORIGIN]): DevTokenRow {
  return {
    appId: APP_ID,
    developerOid: "oid-developer-alice",
    origins,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  };
}

interface Harness {
  app: FastifyInstance;
  portal: FakeStatusPortal;
  tokens: FakeDevTokenStore;
}

function build(opts: { withPortal?: boolean; withInternalSecret?: boolean } = {}): Harness {
  const portal = new FakeStatusPortal();
  const tokens = new FakeDevTokenStore();
  tokens.add(DEV_BEARER, liveTokenRow());
  const internalSecret = Buffer.alloc(32, 7);
  const app = buildDevGateway({
    config: testDevGatewayConfig({
      internalSecret: opts.withInternalSecret === false ? null : internalSecret,
    }),
    registry: new FakeRegistry([
      registryEntry({ appId: APP_ID, slug: SLUG, blobPrefix: "apps/a/1/" }),
    ]),
    devTokens: tokens,
    appData: new FakeAppDataStore(),
    usage: new FakeUsageStore(),
    llmProvider: null,
    egress: null,
    instructionKey: null,
    portal: opts.withPortal === false ? null : portal,
  });
  return { app, portal, tokens };
}

function get(
  app: FastifyInstance,
  opts: { token?: string | null; origin?: string | null; url?: string } = {},
) {
  const headers: Record<string, string> = { ...HOST };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? DEV_BEARER}`;
  if (opts.origin !== null) headers.origin = opts.origin ?? DEV_ORIGIN;
  return app.inject({ method: "GET", url: opts.url ?? STATUS_URL, headers });
}

describe("the dev status route — the pass-through contract", () => {
  it("forwards the dev identity over the internal status read and answers the status word", async () => {
    const h = build();
    h.portal.response = { status: "connected" };
    const res = await get(h.app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "connected" });
    expect(res.headers["cache-control"]).toBe("no-store");
    // The validated origin is reflected over CORS — the dev app may read it.
    expect(res.headers["access-control-allow-origin"]).toBe(DEV_ORIGIN);

    expect(h.portal.requests).toHaveLength(1);
    expect(h.portal.requests[0]!.target).toBe("/internal/connections/status");
    // The minimal contract: the dev identity (kind pins the tier), app, ref —
    // no nonce (a status read writes nothing), no consult fields.
    const body = ConnectionStatusRequestSchema.parse(JSON.parse(h.portal.requests[0]!.body));
    expect(body.identity).toEqual({ kind: "dev", developerOid: "oid-developer-alice" });
    expect(body.appSlug).toBe(SLUG);
    expect(body.providerRef).toBe("asana");
    expect(h.portal.requests[0]!.body).not.toContain("nonce");
    expect(h.portal.requests[0]!.body).not.toContain("callbackUrl");
    await h.app.close();
  });

  it("passes not_connected and not_available through untouched", async () => {
    for (const status of ["not_connected", "not_available"] as const) {
      const h = build();
      h.portal.response = { status };
      const res = await get(h.app);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status });
      expect(Object.keys(res.json())).toEqual(["status"]);
      await h.app.close();
    }
  });
});

describe("the resolver gate runs BEFORE any read", () => {
  it("an unregistered or missing Origin is refused 403 with no status call", async () => {
    const h = build();
    for (const origin of ["https://evil.example", null]) {
      const res = await get(h.app, { origin });
      expect(res.statusCode, origin ?? "no origin").toBe(403);
    }
    expect(h.portal.requests.length).toBe(0);
    await h.app.close();
  });

  it("a token for another app is refused 403 before any read", async () => {
    const h = build();
    const other = newDevToken();
    h.tokens.add(other, { ...liveTokenRow(), appId: "22222222-2222-4222-8222-222222222222" });
    const res = await get(h.app, { token: other });
    expect(res.statusCode).toBe(403);
    expect(h.portal.requests.length).toBe(0);
    await h.app.close();
  });

  it("a missing, unknown, revoked, or expired token is refused 401 before any read", async () => {
    const h = build();
    const revoked = newDevToken();
    h.tokens.add(revoked, { ...liveTokenRow(), revokedAt: new Date() });
    const expired = newDevToken();
    h.tokens.add(expired, { ...liveTokenRow(), expiresAt: new Date(Date.now() - 1000) });
    for (const token of [null, newDevToken(), revoked, expired]) {
      const res = await get(h.app, { token });
      expect(res.statusCode, token ?? "no token").toBe(401);
    }
    expect(h.portal.requests.length).toBe(0);
    await h.app.close();
  });

  it("404s a malformed ref before any status call — a probe, not a state", async () => {
    const h = build();
    for (const ref of ["NOT_A_REF", "..%2Fstart"]) {
      const res = await get(h.app, { url: `/${SLUG}/_api/connections/${ref}/status` });
      expect(res.statusCode, ref).toBe(404);
    }
    expect(h.portal.requests.length).toBe(0);
    await h.app.close();
  });
});

describe("fail-closed seams and telemetry", () => {
  it("an unconfigured portal seam or internal key answers a fixed 503", async () => {
    for (const opts of [{ withPortal: false }, { withInternalSecret: false }]) {
      const h = build(opts);
      const res = await get(h.app);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("capability_unavailable");
      await h.app.close();
    }
  });

  it("a portal hop failure answers the fixed 503", async () => {
    const h = build();
    h.portal.error = new Error("portal hop failed");
    const res = await get(h.app);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("capability_unavailable");
    await h.app.close();
  });

  it("emits the dev span with a bounded outcome and never the identity", async () => {
    const recording = startRecordingTelemetry();
    try {
      const h = build();
      h.portal.response = { status: "connected" };
      await get(h.app);

      const span = recording.spans().find((s) => s.name === SPAN_CONSENT_STATUS_DEV);
      expect(span).toBeDefined();
      expect(span!.attributes["http.route"]).toBe(ROUTE_CONSENT_STATUS_DEV);
      expect(span!.attributes["helix.outcome"]).toBe("connected");

      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      expect(dump).not.toContain("oid-developer-alice");
      await h.app.close();
    } finally {
      await recording.restore();
    }
  });
});
