import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ConnectionStatusRequestSchema,
  type ConnectionStatusResponse,
  INTERNAL_AUDIENCE,
  INTERNAL_AUTH_HEADER,
  INTERNAL_JWT_TYP,
  INTERNAL_TTL_SECONDS,
} from "@azx-pbc/shared";
import { ROUTE_CONSENT_STATUS, SPAN_CONSENT_STATUS_EDGE } from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { buildApp } from "../app.js";
import { deriveInternalKey } from "../internalJwt.js";
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
import type { PortalProvider, PortalProxyRequest, PortalProxyResponse } from "./portalProvider.js";

/**
 * `GET /_api/connections/:ref/status` (ADR-0031 as amended) — the app-facing
 * connection-status read. The read rides a scripted fake portal provider (the
 * consent-start test's fake-seam style), so every assertion here is against
 * the real route, session gate, and ref-parse gates — only the portal hop is
 * fake.
 */

const APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLUG = "demo";
const HOST = { host: "demo.local.helix.azxlabs.io" };
const STATUS_URL = "/_api/connections/asana/status";
const INTERNAL_SECRET = randomBytes(32);
const INTERNAL_KEY = deriveInternalKey(INTERNAL_SECRET);

/** The fake portal provider for the status seam: capture + scripted answer. */
class FakeStatusPortal implements PortalProvider {
  readonly requests: {
    target: string;
    headers: Record<string, unknown>;
    body: string;
    internalToken: string;
  }[] = [];
  response: ConnectionStatusResponse = { status: "not_connected" };
  /** Raw body override — malformed/over-answer responses for the failure paths. */
  body: string | null = null;
  status = 200;
  error: Error | null = null;

  async proxy(req: PortalProxyRequest): Promise<PortalProxyResponse> {
    const chunks: Buffer[] = [];
    if (req.body) {
      for await (const chunk of req.body) chunks.push(chunk as Buffer);
    }
    this.requests.push({
      target: req.target,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      internalToken: req.internalToken,
    });
    if (this.error) throw this.error;
    return {
      status: this.status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(this.body ?? JSON.stringify(this.response))]),
    };
  }

  async close(): Promise<void> {}
}

interface Harness {
  app: FastifyInstance;
  portal: FakeStatusPortal;
  sessions: FakeSessionStore;
  signIn(opts?: { kind?: "user" | "password"; expired?: boolean }): Promise<string>;
}

function buildStatusEdge(
  opts: { withPortal?: boolean; withInternalSecret?: boolean } = {},
): Harness {
  const portal = new FakeStatusPortal();
  const sessions = new FakeSessionStore();
  const entry = registryEntry({
    appId: APP_ID,
    slug: SLUG,
    blobPrefix: "apps/b/1/",
    visibilityMode: "internal",
    visibilityGroupIds: [],
  });
  const app = buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      internalSecret: opts.withInternalSecret === false ? null : INTERNAL_SECRET,
    }),
    registry: new FakeRegistry([entry]),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    portal: opts.withPortal === false ? null : portal,
  });
  return {
    app,
    portal,
    sessions,
    async signIn(overrides = {}) {
      const kind = overrides.kind ?? "user";
      const token = newSessionToken();
      const id = randomUUID();
      const now = Date.now();
      await sessions.createPending({
        id,
        appId: APP_ID,
        user: {
          oid: kind === "user" ? "oid-alice" : "pw_pseudonym1234",
          displayName: "Alice Anders",
          name: "Alice",
          email: "alice@azx.dev",
          kind,
          groups: [],
        },
        refreshDueAt: new Date(now + 60_000),
        expiresAt: new Date(overrides.expired ? now - 1000 : now + 3_600_000),
      });
      await sessions.redeem(id, APP_ID, hashSessionToken(token));
      return token;
    },
  };
}

async function verifiesUnderPortalRule(token: unknown, key: Buffer): Promise<boolean> {
  if (typeof token !== "string") return false;
  try {
    await jwtVerify(token, key, {
      algorithms: ["HS256"],
      typ: INTERNAL_JWT_TYP,
      audience: INTERNAL_AUDIENCE,
      clockTolerance: 5,
      maxTokenAge: INTERNAL_TTL_SECONDS,
    });
    return true;
  } catch {
    return false;
  }
}

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

describe("the status route — the pass-through contract", () => {
  it("forwards the read and answers the portal's status word with no-store", async () => {
    const h = buildStatusEdge();
    h.portal.response = { status: "connected" };
    const token = await h.signIn();
    const res = await h.app.inject({
      method: "GET",
      url: STATUS_URL,
      headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "connected" });
    expect(res.headers["cache-control"]).toBe("no-store");

    expect(h.portal.requests).toHaveLength(1);
    const seen = h.portal.requests[0]!;
    expect(seen.target).toBe("/internal/connections/status");
    // The minimal contract: identity, app, ref — no consult fields.
    const body = ConnectionStatusRequestSchema.parse(JSON.parse(seen.body));
    expect(body.identity).toEqual({ kind: "user", userOid: "oid-alice" });
    expect(body.appSlug).toBe(SLUG);
    expect(body.providerRef).toBe("asana");
    expect(seen.body).not.toContain("callbackUrl");
    expect(seen.body).not.toContain("openerOrigin");
    // T-0006's per-call internal JWT verifies under the portal's rule.
    expect(seen.headers[INTERNAL_AUTH_HEADER]).toBeUndefined();
    expect(await verifiesUnderPortalRule(seen.internalToken, INTERNAL_KEY)).toBe(true);
    await h.app.close();
  });

  it("passes not_connected and not_available through untouched", async () => {
    for (const status of ["not_connected", "not_available"] as const) {
      const h = buildStatusEdge();
      h.portal.response = { status };
      const token = await h.signIn();
      const res = await h.app.inject({
        method: "GET",
        url: STATUS_URL,
        headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status });
      await h.app.close();
    }
  });

  it("answers 401 without a session, on an expired one, and for a pseudonym — never a redirect", async () => {
    const h = buildStatusEdge();
    expect((await h.app.inject({ method: "GET", url: STATUS_URL, headers: HOST })).statusCode).toBe(
      401,
    );

    const expired = await h.signIn({ expired: true });
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: STATUS_URL,
          headers: { ...HOST, cookie: `${SESSION_COOKIE}=${expired}` },
        })
      ).statusCode,
    ).toBe(401);

    const pseudonym = await h.signIn({ kind: "password" });
    const res = await h.app.inject({
      method: "GET",
      url: STATUS_URL,
      headers: { ...HOST, cookie: `${SESSION_COOKIE}=${pseudonym}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    // The refusal is edge-side: the portal heard nothing (criterion 21 — a
    // pseudonym can never hold a connection, so there is nothing to ask).
    expect(h.portal.requests).toHaveLength(0);
    await h.app.close();
  });

  it("404s a malformed ref before any portal call or span attribute — a probe, not a state", async () => {
    const h = buildStatusEdge();
    const token = await h.signIn();
    for (const ref of ["NOT_A_REF", "..%2Fstart", "a".repeat(65)]) {
      const res = await h.app.inject({
        method: "GET",
        url: `/_api/connections/${ref}/status`,
        headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(res.statusCode, ref).toBe(404);
    }
    expect(h.portal.requests).toHaveLength(0);
    await h.app.close();
  });

  it("404s on the auth host and the platform host — the two-router discipline", async () => {
    const h = buildStatusEdge();
    const token = await h.signIn();
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: STATUS_URL,
          headers: { host: "auth.local.helix.azxlabs.io", cookie: `${SESSION_COOKIE}=${token}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: STATUS_URL,
          headers: { host: "localhost:8080", cookie: `${SESSION_COOKIE}=${token}` },
        })
      ).statusCode,
    ).toBe(404);
    await h.app.close();
  });

  it("fail-closes 503 with the seam unconfigured and when the portal hop fails", async () => {
    for (const opts of [{ withPortal: false }, { withInternalSecret: false }]) {
      const h = buildStatusEdge(opts);
      const token = await h.signIn();
      const res = await h.app.inject({
        method: "GET",
        url: STATUS_URL,
        headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("capability_unavailable");
      await h.app.close();
    }

    const h = buildStatusEdge();
    h.portal.error = new Error("portal hop failed");
    const token = await h.signIn();
    const res = await h.app.inject({
      method: "GET",
      url: STATUS_URL,
      headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("capability_unavailable");
    await h.app.close();
  });
});

describe("the status route — adversarial", () => {
  it("fails closed when the portal answers more than the contract — skew is a 503, never serialized", async () => {
    const h = buildStatusEdge();
    // A skew producer answering extra fields: the shared schema is strict, so
    // the parse throws and the route answers the fixed 503 — the extra field
    // can never reach the app (the ADR-0005 discipline).
    h.portal.body = JSON.stringify({ status: "connected", accessToken: "SECRET-VALUE" });
    const token = await h.signIn();
    const res = await h.app.inject({
      method: "GET",
      url: STATUS_URL,
      headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("SECRET");
    await h.app.close();
  });

  it("the happy-path body is exactly the one-key status object", async () => {
    const h = buildStatusEdge();
    h.portal.response = { status: "connected" };
    const token = await h.signIn();
    const res = await h.app.inject({
      method: "GET",
      url: STATUS_URL,
      headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["status"]);
    await h.app.close();
  });
});

describe("the status route — telemetry (AGENTS.md §Telemetry ships with the change)", () => {
  it("emits the edge span with a bounded outcome and never the identity", async () => {
    const h = buildStatusEdge();
    h.portal.response = { status: "connected" };
    const token = await h.signIn();
    await h.app.inject({
      method: "GET",
      url: STATUS_URL,
      headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}` },
    });

    const span = recording.spans().find((s) => s.name === SPAN_CONSENT_STATUS_EDGE);
    expect(span).toBeDefined();
    expect(span!.attributes["http.route"]).toBe(ROUTE_CONSENT_STATUS);
    expect(span!.attributes["helix.outcome"]).toBe("connected");

    // The global scan: no span attribute carries the caller's identity.
    const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
    expect(dump).not.toContain("oid-alice");
    await h.app.close();
  });
});
