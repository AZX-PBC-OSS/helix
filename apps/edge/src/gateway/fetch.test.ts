import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { type JWTPayload, jwtVerify } from "jose";
import { INSTRUCTION_AUDIENCE, INSTRUCTION_JWT_TYP } from "@azx-pbc/shared";
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
 * The `/_api/fetch` policy plane (fetch-proxy design §7): gate + CSRF, the
 * manifest proxy-origin allowlist, the per-app request budget, attested-
 * instruction minting, and metering. A fake egress captures what the edge
 * forwards; the egress service itself is tested in apps/egress.
 */

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "apps/a/1/";
const HOST = { host: "demo.local.helix.azxlabs.io" };
const ORIGIN = "https://demo.local.helix.azxlabs.io:8080";
const secret = randomBytes(32);
const key = deriveInstructionKey(secret);

/** undici rejects an in-flight request with this the moment its signal fires. */
function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

class FakeEgress implements EgressProvider {
  calls: EgressRequest[] = [];
  outcome = "ok";
  /** When set, the response body egress "returns" — used to exercise the cap. */
  responseBody: Readable | null = null;
  /** When set, the request body is fully drained so tests can measure its size. */
  drainRequest = false;
  drainedBytes = 0;
  /**
   * Hold the call open this long before answering, standing in for an upstream
   * that takes real time. At the default 0 the response is already resolved
   * before the edge could possibly abort, so a self-abort would be invisible —
   * any test asserting on abort behaviour has to set this.
   */
  delayMs = 0;
  /** Set when the edge's signal fired while this call was still in flight. */
  abortedDuringCall = false;

  async proxy(req: EgressRequest): Promise<EgressResponse> {
    this.calls.push(req);
    // Watch from the moment the call starts, not just during the delay window:
    // a client that hangs up mid-upload aborts while we are still draining, and
    // that has to be observable too.
    let settled = false;
    if (req.signal.aborted) this.abortedDuringCall = true;
    else {
      req.signal.addEventListener(
        "abort",
        () => {
          // Only while in flight: once we have answered, the edge tearing the
          // request down is ordinary completion, not a cancelled call.
          if (!settled) this.abortedDuringCall = true;
        },
        { once: true },
      );
    }
    if (this.drainRequest && req.body && typeof req.body !== "string") {
      for await (const chunk of req.body as Readable) this.drainedBytes += (chunk as Buffer).length;
    }
    if (this.delayMs > 0) await this.#holdOpen(req.signal);
    settled = true;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: this.responseBody ?? Readable.from([Buffer.from(JSON.stringify({ ok: true }))]),
      outcome: this.outcome,
    };
  }

  /**
   * Mirror undici's contract, which is the whole point of the fake here: a call
   * in flight rejects with an AbortError as soon as its signal fires. A fake
   * that ignored the signal would answer 200 even while the edge was aborting
   * it, and the bug this guards against would pass.
   */
  #holdOpen(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
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
    // Instruction carries the aud + one-time jti (== requestId) egress asserts.
    expect(claims.aud).toBe(INSTRUCTION_AUDIENCE);
    expect(claims.jti).toBe(claims.requestId);
    expect(typeof claims.jti).toBe("string");
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
      headers: { ...HOST, origin: "https://evil.local.helix.azxlabs.io:8080" },
    });
    expect(res.statusCode).toBe(403);
    expect(egress.calls).toHaveLength(0);
    await app.close();
  });

  /**
   * CSRF on the proxy must hold for **GET**, because a proxied GET spends a
   * connection credential and returns third-party data — so the reads-are-exempt
   * shortcut `data-handler` takes is not available here. But a same-origin
   * `fetch()` GET carries no `Origin` header at all (the Fetch standard appends
   * one only for CORS-tainted requests or non-GET/HEAD methods), so an
   * Origin-only check refused every legitimate browser read through the proxy.
   * `Sec-Fetch-Site` is the signal that covers both; these pin the matrix.
   */
  describe("CSRF: Sec-Fetch-Site as the GET-capable signal", () => {
    async function call(headers: Record<string, string>) {
      const { app, egress } = buildFetchEdge();
      const res = await app.inject({
        method: "GET",
        url: "/_api/fetch/https://api.github.com/x",
        headers: { ...HOST, ...headers },
      });
      await app.close();
      return { status: res.statusCode, egressCalls: egress.calls.length };
    }

    // The regression this fixes: the real browser shape for an app's own GET.
    it("allows a same-origin GET that carries no Origin header", async () => {
      expect(await call({ "sec-fetch-site": "same-origin" })).toMatchObject({ status: 200 });
    });

    // A sibling subdomain is same-*site*, so SameSite cookies do not stop it —
    // this is precisely the threat the origin check exists for.
    it("refuses a sibling subdomain (same-site) even with no Origin", async () => {
      expect(await call({ "sec-fetch-site": "same-site" })).toEqual({
        status: 403,
        egressCalls: 0,
      });
    });

    it("refuses a cross-site caller", async () => {
      expect(await call({ "sec-fetch-site": "cross-site" })).toEqual({
        status: 403,
        egressCalls: 0,
      });
    });

    /**
     * `none` means *no initiator* — a link opened from an email client, Slack, or
     * a native app, not just the address bar. `__Host-session` is `SameSite=Lax`,
     * so the session rides that navigation; accepting `none` would let an attacker
     * spend the app's connection credential against the victim's session, outside
     * the manifest allowlist and the budget.
     */
    it("refuses `none` — no initiator is a phishing channel, not a user typing", async () => {
      expect(await call({ "sec-fetch-site": "none" })).toEqual({ status: 403, egressCalls: 0 });
    });

    /**
     * Second, independent lock on the same attack. A proxied response is returned
     * on the app's own origin with an upstream-controlled `content-type`, no CSP
     * and no `nosniff`, so a `text/html` body reached by *navigation* would execute
     * script in the app's origin. No legitimate `/_api/*` caller navigates.
     */
    it.each([
      ["sec-fetch-mode: navigate", { "sec-fetch-mode": "navigate" }],
      ["sec-fetch-dest: document", { "sec-fetch-dest": "document" }],
      ["sec-fetch-dest: iframe", { "sec-fetch-dest": "iframe" }],
    ])("refuses a navigation even when same-origin (%s)", async (_label, extra) => {
      expect(await call({ "sec-fetch-site": "same-origin", ...extra })).toEqual({
        status: 403,
        egressCalls: 0,
      });
    });

    // The `accept` header is on the request safelist, so an app proxying an HTML
    // resource legitimately sends `text/html`. Unlike gate.ts's isNavigation, this
    // check must not sniff it — that would fail closed on a valid call.
    it("does not mistake an app fetching HTML for a navigation", async () => {
      expect(
        await call({ "sec-fetch-site": "same-origin", accept: "text/html,*/*" }),
      ).toMatchObject({ status: 200 });
    });

    // Sec-Fetch-Site is a forbidden header name, so page script cannot forge it;
    // a lying value beats the check only for a client that already holds the
    // session cookie — which is what CSRF exists to exploit *without* holding.
    it("lets Sec-Fetch-Site override a mismatched Origin", async () => {
      expect(
        await call({
          "sec-fetch-site": "same-origin",
          origin: "https://evil.local.helix.azxlabs.io:8080",
        }),
      ).toMatchObject({ status: 200 });
    });

    it("still refuses a cross-origin POST when Sec-Fetch-Site says cross-site", async () => {
      const { app, egress } = buildFetchEdge();
      const res = await app.inject({
        method: "POST",
        url: "/_api/fetch/https://api.github.com/x",
        headers: {
          ...HOST,
          "sec-fetch-site": "cross-site",
          origin: "https://evil.local.helix.azxlabs.io:8080",
        },
        payload: { a: 1 },
      });
      expect(res.statusCode).toBe(403);
      expect(egress.calls).toHaveLength(0);
      await app.close();
    });

    // Older clients that send no Fetch Metadata fall back to the exact Origin
    // match, and an absent Origin still fails closed — curl is refused.
    it("falls back to Origin when Sec-Fetch-Site is absent", async () => {
      expect(await call({ origin: ORIGIN })).toMatchObject({ status: 200 });
      expect(await call({ origin: "https://evil.local.helix.azxlabs.io:8080" })).toEqual({
        status: 403,
        egressCalls: 0,
      });
      expect(await call({})).toEqual({ status: 403, egressCalls: 0 });
    });
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
    await withServer(app, async (base) => {
      const res = await undiciRequest(`${base}/_api/fetch/https://api.github.com/big`, {
        method: "GET",
        headers: { ...HOST, origin: ORIGIN },
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
    });
  });
});

/**
 * Everything below runs over a real socket. `app.inject()` cannot reach this
 * class of bug: light-my-request never emits `'close'` on `req.raw` when the
 * body is consumed, so a handler that mistook that for a client disconnect
 * looked perfectly healthy under inject while failing every body-bearing
 * method in production.
 */
describe("/_api/fetch over a real socket", () => {
  const URL_PATH = "/_api/fetch/https://api.github.com/x";
  const JSON_BODY = JSON.stringify({ a: 1 });
  const JSON_BODY_BYTES = Buffer.byteLength(JSON_BODY);
  const JSON_HEADERS = { ...HOST, origin: ORIGIN, "content-type": "application/json" };

  it("proxies a POST with a JSON body", async () => {
    const { app, egress, usage } = buildFetchEdge();
    egress.drainRequest = true;
    // A delay is what makes the assertion meaningful: it leaves a window in
    // which a spurious abort could land, the way a real upstream does.
    egress.delayMs = 50;
    await withServer(app, async (base) => {
      const res = await undiciRequest(`${base}${URL_PATH}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON_BODY,
      });
      expect(res.statusCode).toBe(200);
      expect(await res.body.json()).toEqual({ ok: true });
    });
    expect(egress.abortedDuringCall).toBe(false); // the request finishing is not a disconnect
    expect(egress.drainedBytes).toBe(JSON_BODY_BYTES);
    expect(usage.records).toContainEqual(expect.objectContaining({ outcome: "ok" }));
  });

  it("proxies a POST with no body", async () => {
    // The reporter's `content-length: 0` control: nothing about the *content*
    // of the body matters, only that the method is one that may carry one.
    const { app, egress } = buildFetchEdge();
    egress.drainRequest = true;
    egress.delayMs = 50;
    await withServer(app, async (base) => {
      const res = await undiciRequest(`${base}${URL_PATH}`, {
        method: "POST",
        headers: { ...HOST, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(200);
      await res.body.text();
    });
    expect(egress.abortedDuringCall).toBe(false);
  });

  it.each(["PUT", "PATCH", "DELETE"] as const)("proxies %s", async (method) => {
    const { app, egress } = buildFetchEdge();
    egress.drainRequest = true;
    egress.delayMs = 50;
    await withServer(app, async (base) => {
      const res = await undiciRequest(`${base}${URL_PATH}`, {
        method,
        headers: JSON_HEADERS,
        body: JSON_BODY,
      });
      expect(res.statusCode).toBe(200);
      await res.body.text();
    });
    expect(egress.abortedDuringCall).toBe(false);
  });

  it("forwards a chunked multi-chunk body intact", async () => {
    // No content-length ⇒ chunked framing, the shape the report guessed was at
    // fault. It transits fine; the verb was never the upstream's problem.
    const { app, egress } = buildFetchEdge();
    egress.drainRequest = true;
    egress.delayMs = 50;
    await withServer(app, async (base) => {
      const res = await undiciRequest(`${base}${URL_PATH}`, {
        method: "POST",
        headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
        body: Readable.from(Array.from({ length: 4 }, () => Buffer.alloc(1_000, 0x61))),
      });
      expect(res.statusCode).toBe(200);
      await res.body.text();
    });
    expect(egress.abortedDuringCall).toBe(false);
    expect(egress.drainedBytes).toBe(4_000);
  });

  it("still proxies GET and HEAD", async () => {
    const { app, egress } = buildFetchEdge();
    egress.delayMs = 50;
    await withServer(app, async (base) => {
      for (const method of ["GET", "HEAD"] as const) {
        const res = await undiciRequest(`${base}${URL_PATH}`, {
          method,
          headers: { ...HOST, origin: ORIGIN },
        });
        expect(res.statusCode).toBe(200);
        await res.body.dump();
      }
    });
    expect(egress.calls).toHaveLength(2);
    expect(egress.abortedDuringCall).toBe(false);
  });

  it("aborts the egress call when the client hangs up mid-upload", async () => {
    // The reason the signal exists. `req.raw` is still mid-body here, so this
    // is the case a `req.aborted`-based guard would also catch.
    const { app, egress } = buildFetchEdge();
    egress.drainRequest = true;
    const stalled = new Readable({ read() {} });
    stalled.push(Buffer.alloc(16, 0x61)); // one chunk, then nothing — never ends
    await withServer(app, async (base) => {
      const ac = new AbortController();
      const pending = undiciRequest(`${base}${URL_PATH}`, {
        method: "POST",
        headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
        body: stalled,
        signal: ac.signal,
      }).catch(() => undefined);
      await until(() => egress.calls.length === 1, "egress to be dialed");
      ac.abort();
      stalled.destroy();
      await pending;
      await until(() => egress.abortedDuringCall, "the egress call to be aborted");
    });
  });

  it("aborts the egress call when the client uploads fully and then hangs up", async () => {
    // The case that decides the primitive: the body arrived complete, so
    // `req.raw.aborted` is false and Fastify's `onRequestAbort` would never
    // fire. Watching the *response* for a premature close is what catches it.
    const { app, egress, usage } = buildFetchEdge();
    egress.drainRequest = true;
    egress.delayMs = 5_000; // held open until the client gives up
    await withServer(app, async (base) => {
      const ac = new AbortController();
      const pending = undiciRequest(`${base}${URL_PATH}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON_BODY,
        signal: ac.signal,
      }).catch(() => undefined);
      await until(() => egress.drainedBytes === JSON_BODY_BYTES, "the body to arrive in full");
      ac.abort();
      await pending;
      await until(() => egress.abortedDuringCall, "the egress call to be aborted");
    });
    expect(usage.records).toContainEqual(
      expect.objectContaining({ capability: "fetch", outcome: "error" }),
    );
  });

  it("answers 413 for an over-cap request body, not 502", async () => {
    // The cap trip and a disconnect both surface as a failed egress forward in
    // the same catch, so the fix must not blur one into the other.
    const { app, egress, usage } = buildFetchEdge({ maxBodyBytes: 64 });
    egress.drainRequest = true;
    await withServer(app, async (base) => {
      const res = await undiciRequest(`${base}${URL_PATH}`, {
        method: "POST",
        headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
        body: Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(40, 0x61))),
      }).catch(() => undefined);
      expect(res?.statusCode).toBe(413);
      expect(((await res?.body.json()) as { code: string }).code).toBe("too_large");
    });
    expect(usage.records).toContainEqual(expect.objectContaining({ statusCode: 413 }));
  });
});
