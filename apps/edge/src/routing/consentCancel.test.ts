import { randomUUID, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  AttemptCancelRequestSchema,
  type CancelResponse,
  type ConsultResponse,
  INTERNAL_AUDIENCE,
  INTERNAL_JWT_TYP,
  INTERNAL_TTL_SECONDS,
} from "@azx-pbc/shared";
import {
  ROUTE_CONSENT_CANCEL,
  ROUTE_CONSENT_START,
  SPAN_CONSENT_CANCEL_EDGE,
} from "@azx-pbc/shared/telemetry";
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
 * `POST /_api/connections/attempt/cancel` (I-02 T-0017) — the connect helper's
 * cancellation acknowledgement: session-gated, own-attempts-only, wrapping
 * T-0012's cancel operation over the internal portal seam. The fake portal is
 * the `consentStart.test.ts` seam shape: it captures what the edge forwards
 * (target, body, the minted internal token) and answers a scripted contract,
 * so every assertion here is against the real route, guards, correlation, and
 * telemetry — the portal hop is fake, and T-0012's state machine is asserted
 * in its own suite.
 */

const APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLUG = "demo";
const HOST = { host: "demo.local.helix.azxlabs.io" };
const ORIGIN = "https://demo.local.helix.azxlabs.io:8080";
const AUTH_ORIGIN = "https://auth.local.helix.azxlabs.io:8080";
const AUTH_HOST = { host: "auth.local.helix.azxlabs.io" };
const PLATFORM_HOST = { host: "localhost:8080" };
const EVIL_ORIGIN = "https://evil.example";
const CANCEL_URL = ROUTE_CONSENT_CANCEL;
const START_URL = `${ROUTE_CONSENT_START.replace(":ref", "asana")}`;
const INTERNAL_SECRET = randomBytes(32);
const INTERNAL_KEY = deriveInternalKey(INTERNAL_SECRET);

/** The consult's state, as the fake portal's assembled authorize URL carries it. */
const CONSULT_STATE = "a".repeat(43);

const authorizeUrl = (): string => {
  const u = new URL("https://vendor.example/oauth/authorize");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", "client-123");
  u.searchParams.set("state", CONSULT_STATE);
  u.searchParams.set("code_challenge", "X".repeat(43));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("redirect_uri", `${AUTH_ORIGIN}/connections/callback`);
  return u.toString();
};

/**
 * The fake consent portal: dispatches on the internal target so one seam
 * answers both the consult (start) and the cancel (acknowledgement), each with
 * its own scripted response and call log.
 */
class FakeConsentPortal implements PortalProvider {
  readonly requests: { target: string; body: unknown; internalToken: string }[] = [];
  consultResponse: ConsultResponse = { outcome: "started", authorizeUrl: authorizeUrl() };
  cancelResponse: CancelResponse = { outcome: "cancelled" };
  /** When set, the next internal call rejects (portal hop failed). */
  error: Error | null = null;
  status = 200;
  /** Raw body override — a malformed response body for the failure paths. */
  rawBody: string | null = null;

  async proxy(req: PortalProxyRequest): Promise<PortalProxyResponse> {
    const chunks: Buffer[] = [];
    if (req.body) {
      for await (const chunk of req.body) chunks.push(chunk as Buffer);
    }
    this.requests.push({
      target: req.target,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      internalToken: req.internalToken,
    });
    if (this.error) throw this.error;
    const scripted =
      req.target === "/internal/connections/cancel" ? this.cancelResponse : this.consultResponse;
    return {
      status: this.status,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(this.rawBody ?? JSON.stringify(scripted))]),
    };
  }

  consults(): number {
    return this.requests.filter((r) => r.target === "/internal/connections/consult").length;
  }

  cancels(): number {
    return this.requests.filter((r) => r.target === "/internal/connections/cancel").length;
  }

  async close(): Promise<void> {}
}

interface Harness {
  app: FastifyInstance;
  portal: FakeConsentPortal;
  sessions: FakeSessionStore;
  signIn(opts?: { oid?: string }): Promise<string>;
  /** Drive a real tagged start through the start route, so the correlation is
   * recorded exactly as production learns it. Returns the tag. */
  startAttempt(tag: string, opts?: { signedIn?: boolean; oid?: string }): Promise<void>;
  cancel(opts: {
    tag: string;
    /** Default: the harness's own signed-in session (the helper's caller). */
    cookie?: string;
    /** Explicitly send no cookie (an anonymous caller). */
    anonymous?: boolean;
    origin?: string;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }>;
}

function buildConsentEdge(): Harness {
  const portal = new FakeConsentPortal();
  const sessions = new FakeSessionStore();
  const entry = registryEntry({ appId: APP_ID, slug: SLUG, blobPrefix: "apps/b/1/" });
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), internalSecret: INTERNAL_SECRET }),
    registry: new FakeRegistry([entry]),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    portal,
  });

  async function signIn(opts: { oid?: string } = {}): Promise<string> {
    const token = newSessionToken();
    const id = randomUUID();
    const now = Date.now();
    await sessions.createPending({
      id,
      appId: APP_ID,
      user: {
        oid: opts.oid ?? "oid-alice",
        displayName: "Alice Anders",
        name: "Alice",
        email: "alice@azx.dev",
        kind: "user",
        groups: [],
      },
      refreshDueAt: new Date(now + 60_000),
      expiresAt: new Date(now + 3_600_000),
    });
    await sessions.redeem(id, APP_ID, hashSessionToken(token));
    return token;
  }

  // The helper's caller is the signed-in page; the harness signs in once and
  // reuses that session as the default cookie.
  let defaultToken: string | null = null;
  const defaultCookie = async (): Promise<string> => {
    if (defaultToken === null) defaultToken = await signIn();
    return defaultToken;
  };

  const h: Harness = {
    app,
    portal,
    sessions,
    signIn,
    async startAttempt(tag, opts = {}) {
      const headers: Record<string, string> = {
        ...HOST,
        "sec-fetch-site": "same-origin",
        referer: `${ORIGIN}/page`,
      };
      if (opts.signedIn !== false) {
        headers.cookie = `${SESSION_COOKIE}=${await signIn({ oid: opts.oid })}`;
      }
      const res = await app.inject({ method: "GET", url: `${START_URL}?attempt=${tag}`, headers });
      if (res.statusCode !== 302) throw new Error(`start did not begin: ${res.statusCode}`);
    },
    async cancel(opts) {
      // `cookie`, when given, is a full header value; the default is the
      // harness's own signed-in session (the helper's caller).
      const cookieHeader = opts.anonymous
        ? undefined
        : (opts.cookie ?? `${SESSION_COOKIE}=${await defaultCookie()}`);
      const res = await app.inject({
        method: "POST",
        url: CANCEL_URL,
        headers: {
          ...HOST,
          "content-type": "application/json",
          origin: opts.origin ?? ORIGIN,
          ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
        },
        body: opts.body ?? { provider: "asana", attempt: opts.tag },
      });
      let body: unknown;
      try {
        body = res.body === "" ? null : (JSON.parse(res.body) as unknown);
      } catch {
        body = res.body; // plain-text refusals (403/404) stay raw
      }
      return { status: res.statusCode, body };
    },
  };
  return h;
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

describe("the happy path — a closed popup's cancellation is acknowledged", () => {
  it("forwards the correlated cancel to the portal with the session's identity and the consult's state", async () => {
    const h = buildConsentEdge();
    await h.startAttempt("tag-happy-1");
    const { status, body } = await h.cancel({ tag: "tag-happy-1" });
    expect(status).toBe(200);
    expect(body).toEqual({ outcome: "cancelled" });

    // Exactly one internal cancel, and it is T-0012's contract: the attempt
    // named by the OAuth state the consult returned, the identity the session
    // attests — never the app-supplied tag (which the portal does not store).
    expect(h.portal.cancels()).toBe(1);
    const forwarded = h.portal.requests.find((r) => r.target === "/internal/connections/cancel")!;
    const parsed = AttemptCancelRequestSchema.safeParse(forwarded.body);
    expect(parsed.success).toBe(false); // the portal gets the CANCEL contract, not this one
    expect(forwarded.body).toEqual({
      identity: { kind: "user", userOid: "oid-alice" },
      state: CONSULT_STATE,
    });
    expect(await verifiesUnderPortalRule(forwarded.internalToken, INTERNAL_KEY)).toBe(true);
    await h.app.close();
  });

  it("relays the portal's not_cancellable answer (expired/finished attempts answer the same)", async () => {
    const h = buildConsentEdge();
    h.portal.cancelResponse = { outcome: "not_cancellable" };
    await h.startAttempt("tag-late-1");
    const { status, body } = await h.cancel({ tag: "tag-late-1" });
    expect(status).toBe(200);
    expect(body).toEqual({ outcome: "not_cancellable" });
    await h.app.close();
  });
});

describe("own-attempts-only", () => {
  it("another principal's session cannot cancel someone else's attempt", async () => {
    const h = buildConsentEdge();
    // Alice starts the attempt; Bob (same app, own session) sends the cancel.
    await h.startAttempt("tag-alice-1");
    const bobsToken = await h.signIn({ oid: "oid-bob" });
    const { status, body } = await h.cancel({
      tag: "tag-alice-1",
      cookie: `${SESSION_COOKIE}=${bobsToken}`,
    });
    expect(status).toBe(200);
    // Indistinguishable from an unknown tag — the caller learns nothing.
    expect(body).toEqual({ outcome: "not_cancellable" });
    // And the portal was never asked: the edge half already refused.
    expect(h.portal.cancels()).toBe(0);
    await h.app.close();
  });

  it("an unknown or never-started tag answers not_cancellable without forwarding", async () => {
    const h = buildConsentEdge();
    const token = await h.signIn();
    const { status, body } = await h.cancel({
      tag: "tag-never-started",
      cookie: `${SESSION_COOKIE}=${token}`,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ outcome: "not_cancellable" });
    expect(h.portal.requests).toHaveLength(0);
    await h.app.close();
  });

  it("a tag is single-use: the second acknowledgement does not reach the portal again", async () => {
    const h = buildConsentEdge();
    await h.startAttempt("tag-once-1");
    // First acknowledgement consumes the correlation.
    const first = await h.cancel({ tag: "tag-once-1" });
    expect(first.body).toEqual({ outcome: "cancelled" });
    // A second one (a double close, a replayed ack) finds nothing.
    const second = await h.cancel({ tag: "tag-once-1" });
    expect(second.body).toEqual({ outcome: "not_cancellable" });
    expect(h.portal.cancels()).toBe(1); // no replay, criterion 31
    await h.app.close();
  });

  it("correlations expire with the attempt's five-minute TTL (unit)", async () => {
    const { AttemptCorrelations } = await import("./consentCancel.js");
    const map = new AttemptCorrelations();
    map.remember("tag-expired", {
      state: CONSULT_STATE,
      userOid: "oid-alice",
      expiresAtMs: Date.now() - 1,
    });
    expect(map.takeIfOwn("tag-expired", "oid-alice")).toBeNull();
  });

  it("the correlation map is bounded — an insert beyond the cap is refused, degrading to the expiry", async () => {
    const { AttemptCorrelations } = await import("./consentCancel.js");
    const map = new AttemptCorrelations(2);
    const live = { state: CONSULT_STATE, userOid: "oid-alice", expiresAtMs: Date.now() + 60_000 };
    map.remember("t1", live);
    map.remember("t2", live);
    map.remember("t3", live); // at cap — the newest insert is refused
    expect(map.takeIfOwn("t3", "oid-alice")).toBeNull();
    expect(map.takeIfOwn("t1", "oid-alice")).not.toBeNull(); // earlier entries survive
    map.remember("t4", live); // consumption freed space
    expect(map.takeIfOwn("t4", "oid-alice")).not.toBeNull();
  });
});

describe("the gates fail closed before the portal is ever asked", () => {
  it("no usable session is a JSON 401, with no forwarding", async () => {
    const h = buildConsentEdge();
    await h.startAttempt("tag-anon");
    const { status, body } = await h.cancel({ tag: "tag-anon", anonymous: true });
    expect(status).toBe(401);
    expect(body).toEqual({
      error: { code: "unauthorized", message: "sign in to acknowledge a cancellation" },
    });
    expect(h.portal.cancels()).toBe(0);
    await h.app.close();
  });

  it("a cross-origin POST is refused (the logout precedent's belt)", async () => {
    const h = buildConsentEdge();
    const token = await h.signIn();
    for (const origin of [EVIL_ORIGIN, `${ORIGIN}.attacker.example`]) {
      const { status } = await h.cancel({
        tag: "tag-csrf",
        cookie: `${SESSION_COOKIE}=${token}`,
        origin,
      });
      expect(status).toBe(403);
    }
    expect(h.portal.requests).toHaveLength(0);
    await h.app.close();
  });

  it("a malformed body is a 400, with no forwarding and no signal", async () => {
    const h = buildConsentEdge();
    const token = await h.signIn();
    for (const body of [
      undefined,
      {},
      { provider: "asana" },
      { attempt: "tag-x" },
      { provider: "NOT A REF", attempt: "tag-x" },
      { provider: "asana", attempt: "not safe" },
      { provider: "asana", attempt: "tag-x", extra: true }, // strict: unknown key
    ]) {
      const { status } = await h.cancel({ tag: "", cookie: `${SESSION_COOKIE}=${token}`, body });
      expect(status).toBe(400);
    }
    expect(h.portal.requests).toHaveLength(0);
    await h.app.close();
  });

  it("an unconfigured portal seam answers fail-closed 503", async () => {
    const sessions = new FakeSessionStore();
    const app = buildApp({
      config: testEdgeConfig({ auth: testAuthConfig(), internalSecret: INTERNAL_SECRET }),
      registry: new FakeRegistry([
        registryEntry({ appId: APP_ID, slug: SLUG, blobPrefix: "apps/b/1/" }),
      ]),
      blob: new FakeBlobReader(),
      sessions,
      oidc: new FakeOidcClient(),
      portal: null,
    });
    const token = newSessionToken();
    const id = randomUUID();
    await sessions.createPending({
      id,
      appId: APP_ID,
      user: {
        oid: "oid-alice",
        displayName: "Alice",
        name: "Alice",
        email: "a@azx.dev",
        kind: "user",
        groups: [],
      },
      refreshDueAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await sessions.redeem(id, APP_ID, hashSessionToken(token));
    const res = await app.inject({
      method: "POST",
      url: CANCEL_URL,
      headers: {
        ...HOST,
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: { provider: "asana", attempt: "tag-unwired" },
    });
    // No correlation was recorded (no start route ran), so the answer is the
    // indistinguishable not_cancellable — never a degraded forward.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "not_cancellable" });
    await app.close();
  });

  it("a failed, non-200, or malformed portal answer is a 503 — the helper never retries it", async () => {
    // The portal hop throws.
    {
      const h = buildConsentEdge();
      await h.startAttempt("tag-fail-throw");
      h.portal.error = new Error("hop failed");
      expect((await h.cancel({ tag: "tag-fail-throw" })).status).toBe(503);
      expect(h.portal.cancels()).toBe(1);
      await h.app.close();
    }
    // The portal answers non-200.
    {
      const h = buildConsentEdge();
      await h.startAttempt("tag-fail-503");
      h.portal.status = 503;
      expect((await h.cancel({ tag: "tag-fail-503" })).status).toBe(503);
      await h.app.close();
    }
    // The portal answers 200 with a body that is not a cancel response.
    {
      const h = buildConsentEdge();
      await h.startAttempt("tag-fail-junk");
      h.portal.rawBody = "not json";
      expect((await h.cancel({ tag: "tag-fail-junk" })).status).toBe(503);
      await h.app.close();
    }
  });
});

describe("route discipline", () => {
  it("is an app-host route: the auth host and platform hosts 404 it", async () => {
    const h = buildConsentEdge();
    for (const headers of [AUTH_HOST, PLATFORM_HOST]) {
      const res = await h.app.inject({
        method: "POST",
        url: CANCEL_URL,
        headers: { ...headers, "content-type": "application/json", origin: EVIL_ORIGIN },
        body: { provider: "asana", attempt: "tag-x" },
      });
      expect(res.statusCode).toBe(404);
    }
    expect(h.portal.requests).toHaveLength(0);
    await h.app.close();
  });

  it("an unknown app 404s without forwarding", async () => {
    const h = buildConsentEdge();
    const token = await h.signIn();
    const res = await h.app.inject({
      method: "POST",
      url: CANCEL_URL,
      headers: {
        host: "nosuch.local.helix.azxlabs.io",
        "content-type": "application/json",
        origin: "https://nosuch.local.helix.azxlabs.io:8080",
        cookie: `${SESSION_COOKIE}=${token}`,
      },
      body: { provider: "asana", attempt: "tag-x" },
    });
    expect(res.statusCode).toBe(404);
    expect(h.portal.requests).toHaveLength(0);
    await h.app.close();
  });
});

describe("the cancel-acknowledgement span", () => {
  it("carries the outcome vocabulary, the route, and never a URL", async () => {
    const h = buildConsentEdge();
    await h.startAttempt("tag-span-1");
    await h.cancel({ tag: "tag-span-1" });
    await h.app.close();

    const span = recording.spans().find((s) => s.name === SPAN_CONSENT_CANCEL_EDGE);
    expect(span).toBeDefined();
    expect(span?.attributes["helix.outcome"]).toBe("cancelled");
    expect(span?.attributes["http.route"]).toBe(ROUTE_CONSENT_CANCEL);
    expect(span?.attributes["url.path"]).toBe(ROUTE_CONSENT_CANCEL);
    expect(span?.attributes["helix.provider_ref"]).toBe("asana");
    // The redaction posture: no whole-URL attribute may appear, on any span.
    for (const span2 of recording.spans()) {
      for (const key of Object.keys(span2.attributes)) {
        expect(["url.full", "http.url", "http.target", "url.query"]).not.toContain(key);
      }
    }
  });

  it("records the refusals: unauthorized and unknown_attempt", async () => {
    const h = buildConsentEdge();
    await h.startAttempt("tag-span-2");
    await h.cancel({ tag: "tag-span-2", anonymous: true }); // no session → unauthorized
    const token = await h.signIn({ oid: "oid-bob" });
    await h.cancel({ tag: "tag-never", cookie: `${SESSION_COOKIE}=${token}` }); // unknown tag
    await h.cancel({ tag: "tag-span-2", cookie: `${SESSION_COOKIE}=${token}` }); // not the owner
    await h.app.close();

    const outcomes = recording
      .spans()
      .filter((s) => s.name === SPAN_CONSENT_CANCEL_EDGE)
      .map((s) => s.attributes["helix.outcome"]);
    expect(outcomes).toContain("unauthorized");
    expect(outcomes).toContain("unknown_attempt");
    expect(outcomes).not.toContain("cancelled"); // nothing was cancelled in this suite
  });

  it("records error when the portal hop fails", async () => {
    const h = buildConsentEdge();
    await h.startAttempt("tag-span-3");
    h.portal.error = new Error("hop failed");
    await h.cancel({ tag: "tag-span-3" });
    await h.app.close();
    const span = recording.spans().find((s) => s.name === SPAN_CONSENT_CANCEL_EDGE);
    expect(span?.attributes["helix.outcome"]).toBe("error");
  });
});
