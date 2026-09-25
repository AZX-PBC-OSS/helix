import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { DataCapabilitySchema, INTERNAL_AUTH_HEADER } from "@azx-pbc/shared";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import { FORBIDDEN_URL_ATTRS } from "@azx-pbc/shared/telemetry";
import { withRootSpan } from "./telemetry.js";
import { buildApp } from "./app.js";
import { SESSION_COOKIE } from "./auth/cookies.js";
import { hashSessionToken, newSessionToken } from "./auth/sessions.js";
import { testAuthConfig, testEdgeConfig } from "./test/config.js";
import {
  FakeAppDataStore,
  FakeBlobReader,
  FakeOidcClient,
  FakePortalProvider,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "./test/fakes.js";

/**
 * ADR-0037 decision 10's redaction case — the direct sibling of
 * `apps/edge/src/logging.test.ts`, and written the same way on purpose: it
 * scans **every attribute of every span** for the planted secret rather than
 * checking one field. A per-field assertion passes forever while a span added
 * later leaks; a global scan fails.
 *
 * Decision 6 is the rule this enforces, and the ADR's own consequences call it
 * "the most likely way the decision decays" — a rule someone must keep applying
 * at each new span. This is the part that does not depend on remembering.
 */

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

/** Distinctive enough that a substring match cannot be a false negative. */
const HANDOFF_TOKEN = "eyJhbGciOiJIUzI1NiJ9.PLANTED-HANDOFF-TOKEN.signature";
const OIDC_CODE = "PLANTED-OIDC-AUTHORIZATION-CODE";
const UPSTREAM_KEY = "sk-PLANTED-UPSTREAM-API-KEY";
const SAS_SIG = "PLANTED-AZURE-SAS-SIGNATURE";

/** Every credential-bearing URL the platform actually produces. */
const CREDENTIAL_URLS = [
  `/_auth/complete?token=${HANDOFF_TOKEN}&rd=/`,
  `/callback?code=${OIDC_CODE}&state=abc`,
  `/callback?error=access_denied&error_description=${OIDC_CODE}`,
  `/_api/fetch/https://api.vendor.test/v1/users?api_key=${UPSTREAM_KEY}`,
  `/_api/fetch/https://acct.blob.core.windows.net/c/b.txt?sig=${SAS_SIG}&se=2026-01-01`,
  // Percent-encoded target: the whole thing hides in the path, where a
  // parameter scan never runs.
  `/_api/fetch/https%3A%2F%2Fapi.vendor.test%2Fv1%3Fapi_key%3D${UPSTREAM_KEY}`,
  // Userinfo in the target — `origin` strips it, but assert rather than assume.
  `/_api/fetch/https://user:${UPSTREAM_KEY}@api.vendor.test/v1`,
];

const SECRETS = [HANDOFF_TOKEN, OIDC_CODE, UPSTREAM_KEY, SAS_SIG];

describe("span attributes never carry a credential", () => {
  it("leaks nothing from any credential-bearing URL, across every attribute", async () => {
    for (const url of CREDENTIAL_URLS) {
      await withRootSpan("test.route", spanUrlAttributes(url), async () => {});
    }

    // The global scan: serialize everything and look for the plants.
    const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
    for (const secret of SECRETS) {
      expect(dump, `a span attribute leaked ${secret}`).not.toContain(secret);
    }
  });

  it("records no attribute key that carries a whole URL", async () => {
    for (const url of CREDENTIAL_URLS) {
      await withRootSpan("test.route", spanUrlAttributes(url), async () => {});
    }

    for (const span of recording.spans()) {
      for (const key of Object.keys(span.attributes)) {
        expect(FORBIDDEN_URL_ATTRS, `${key} is a whole-URL attribute`).not.toContain(key);
      }
    }
  });

  it("drops the query wholesale, not by parameter name", async () => {
    // Stronger than the log serializer, deliberately: a credential under a name
    // `SENSITIVE_PARAMS` has never heard of still cannot reach a span.
    const url = "/_auth/complete?unknown_param_name=PLANTED-UNLISTED-SECRET";
    await withRootSpan("test.route", spanUrlAttributes(url), async () => {});

    const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
    expect(dump).not.toContain("PLANTED-UNLISTED-SECRET");
    expect(dump).not.toContain("?");
  });

  it("still records enough path to be worth having", async () => {
    // Redaction that deleted everything would pass every test above and be
    // useless. `url.path` must still say which route ran, and for the
    // fetch-proxy which upstream was called.
    await withRootSpan(
      "test.route",
      spanUrlAttributes(`/_api/fetch/https://api.vendor.test/v1/users?api_key=${UPSTREAM_KEY}`),
      async () => {},
    );

    const path = recording.spans()[0]?.attributes["url.path"];
    expect(path).toContain("api.vendor.test");
    expect(path).toContain("/v1/users");
    expect(path).not.toContain(UPSTREAM_KEY);
  });

  it("keeps the constant auth routes recognisable", async () => {
    await withRootSpan(
      "test.route",
      spanUrlAttributes(`/_auth/complete?token=${HANDOFF_TOKEN}`),
      async () => {},
    );
    expect(recording.spans()[0]?.attributes["url.path"]).toBe("/_auth/complete");
  });

  /**
   * ADR-0042 review finding 1's regression guard. The data routes are the
   * first parameterized routes `spanUrlAttributes` was ever pointed at, and
   * four of them carry an app-chosen KEY as the path's last segment — under
   * prefix grants those keys are unbounded and attacker-choosable, so an
   * `url.path` there is app data written into a retained backend (it fires even
   * on a 404, so an unauthenticated prober chooses the strings). The wrapper
   * (`withDataSpans`) therefore records no path at all — `http.route` plus
   * `helix.data.verb` identify the route. This drives the REAL handlers with a
   * planted key in the URL and scans every attribute of every span, so
   * re-adding a path attribute fails here rather than leaking quietly.
   */
  describe("the app-data gateway's parameterized routes (ADR-0042 finding 1)", () => {
    const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const HOST = "notes.local.helix.azxlabs.io";
    // The edge's Origin check is exact same-origin, port included (as in
    // `data.test.ts` — the host header omits it, the Origin must carry it).
    const ORIGIN = `https://${HOST}:8080`;
    /** A key an app might plausibly derive from a person — the leak case. */
    const PLANTED_KEY = "PLANTED-PATIENT-ssn-123";

    function buildDataEdge() {
      const app = buildApp({
        config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
        registry: new FakeRegistry([
          registryEntry({
            appId: APP_ID,
            slug: "notes",
            blobPrefix: "apps/c/1/",
            visibilityMode: "public",
            data: DataCapabilitySchema.parse({
              user: false,
              sharedReadPrefixes: ["record:"],
            }),
          }),
        ]),
        blob: new FakeBlobReader(),
        sessions: new FakeSessionStore(),
        oidc: new FakeOidcClient(),
        usage: new FakeUsageStore(),
        appData: new FakeAppDataStore(),
      });
      return app;
    }

    it("never puts the app-chosen key on a span — not even on a 404 probe", async () => {
      const app = buildDataEdge();
      const res = await app.inject({
        method: "GET",
        // 404 (nothing seeded): the span still fires — that is the point.
        url: `/_api/data/shared/record:${PLANTED_KEY}`,
        headers: { host: HOST },
      });
      expect(res.statusCode).toBe(404);
      await app.close();

      expect(recording.spans().length).toBeGreaterThan(0);
      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      expect(dump, "an app-data span leaked the requested key").not.toContain(PLANTED_KEY);
      // And the route is identified without any path at all.
      for (const span of recording.spans()) {
        expect(span.attributes["url.path"]).toBeUndefined();
      }
    });

    it("never puts the key on a successful write's span either", async () => {
      // A user-scope PUT that SUCCEEDS (the authenticated happy path) — the
      // strongest case, because the key is real stored data, not a probe.
      const sessions = new FakeSessionStore();
      const token = newSessionToken();
      const id = randomUUID();
      await sessions.createPending({
        id,
        appId: APP_ID,
        user: {
          oid: "alice",
          displayName: "Alice",
          name: null,
          email: null,
          kind: "user",
          groups: [],
        },
        refreshDueAt: new Date(Date.now() + 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await sessions.redeem(id, APP_ID, hashSessionToken(token));
      const app = buildApp({
        config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
        registry: new FakeRegistry([
          registryEntry({
            appId: APP_ID,
            slug: "notes",
            blobPrefix: "apps/c/1/",
            visibilityMode: "internal",
            data: DataCapabilitySchema.parse({ user: true }),
          }),
        ]),
        blob: new FakeBlobReader(),
        sessions,
        oidc: new FakeOidcClient(),
        usage: new FakeUsageStore(),
        appData: new FakeAppDataStore(),
      });
      const put = await app.inject({
        method: "PUT",
        url: `/_api/data/user/draft:${PLANTED_KEY}`,
        headers: {
          host: HOST,
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${token}`,
        },
        payload: { note: "x" },
      });
      expect(put.statusCode).toBe(200);
      await app.close();

      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      expect(dump, "an app-data span leaked the written key").not.toContain(PLANTED_KEY);
    });
  });

  /**
   * T-0015: the auth host's `/connections/*` reverse proxy. The vendor's
   * redirect lands here with `code` and `state` in the URL (design.md
   * §Operator-visible signals fixes this route's spans to `url.path` only),
   * and the request carries material an attacker can plant themselves — the
   * forged internal header the proxy must strip. Drives the REAL route
   * through `buildApp` with everything planted, then scans every attribute of
   * every span, so a later attribute addition fails here instead of leaking.
   */
  describe("the /connections/* proxy route (T-0015)", () => {
    const CONSENT_CODE = "PLANTED-CONSENT-CODE";
    const CONSENT_STATE = "PLANTED-CONSENT-STATE";
    const FORGED_INTERNAL = "PLANTED-FORGED-INTERNAL-TOKEN";
    const AUTH_HOST = { host: "auth.local.helix.azxlabs.io" };

    function buildProxyEdge() {
      return buildApp({
        config: testEdgeConfig({ auth: testAuthConfig(), internalSecret: Buffer.alloc(32, 7) }),
        registry: new FakeRegistry([
          registryEntry({
            appId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            slug: "notes",
            blobPrefix: "apps/e/1/",
          }),
        ]),
        blob: new FakeBlobReader(),
        sessions: new FakeSessionStore(),
        oidc: new FakeOidcClient(),
        portal: new FakePortalProvider(),
      });
    }

    it("leaks no code, state, or internal-header value — across every attribute", async () => {
      const app = buildProxyEdge();
      const res = await app.inject({
        method: "GET",
        url: `/connections/callback?code=${CONSENT_CODE}&state=${CONSENT_STATE}`,
        headers: { ...AUTH_HOST, [INTERNAL_AUTH_HEADER]: FORGED_INTERNAL },
      });
      expect(res.statusCode).toBe(200);
      await app.close();

      expect(recording.spans().length).toBeGreaterThan(0);
      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      for (const secret of [CONSENT_CODE, CONSENT_STATE, FORGED_INTERNAL]) {
        expect(dump, `a span attribute leaked ${secret}`).not.toContain(secret);
      }
      // The query is dropped wholesale — not even a `?` survives.
      expect(dump).not.toContain("?");
      for (const span of recording.spans()) {
        for (const key of Object.keys(span.attributes)) {
          expect(FORBIDDEN_URL_ATTRS, `${key} is a whole-URL attribute`).not.toContain(key);
        }
      }
      // And the route is still identifiable — `url.path` only, no query.
      const routeSpan = recording.spans().find((s) => s.name === "helix.auth.connections.proxy");
      expect(routeSpan?.attributes["url.path"]).toBe("/connections/callback");
    });
  });

  /**
   * T-0014: the consent start route. The URL carries an app-chosen `attempt`
   * correlation tag (unbounded, attacker-choosable on a public-URL route — the
   * ADR-0042 finding-1 class of value), and the consult's answer is a vendor
   * authorize URL carrying `state` + the PKCE challenge, which the route 302s
   * to. Neither may reach a span: the query is dropped wholesale, and the
   * redirect target is never an attribute. Drives the REAL route on both the
   * guarded-refusal and the started paths, then scans every attribute of
   * every span.
   */
  describe("the consent start route (T-0014)", () => {
    const APP_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const HOST = { host: "notes.local.helix.azxlabs.io" };
    const ORIGIN = `https://notes.local.helix.azxlabs.io:8080`;
    const POPUP_HEADERS = {
      "sec-fetch-site": "same-origin",
      referer: `${ORIGIN}/page`,
    };
    const ATTEMPT_TAG = "PLANTED-ATTEMPT-CORRELATION-TAG";
    const VENDOR_STATE = "PLANTED-VENDOR-OAUTH-STATE";
    const VENDOR_CHALLENGE = "PLANTED-PKCE-CHALLENGE";
    const START = `/_api/connections/asana/start?attempt=${ATTEMPT_TAG}`;

    it("leaks no attempt tag or vendor protocol value — on the refusal path", async () => {
      // A cross-site navigation (every hostile header combination refuses) —
      // the cheapest route to the span, and the one a prober drives.
      const app = buildApp({
        config: testEdgeConfig({ auth: testAuthConfig(), internalSecret: Buffer.alloc(32, 7) }),
        registry: new FakeRegistry([
          registryEntry({ appId: APP_ID, slug: "notes", blobPrefix: "apps/f/1/" }),
        ]),
        blob: new FakeBlobReader(),
        sessions: new FakeSessionStore(),
        oidc: new FakeOidcClient(),
        portal: new FakePortalProvider(),
      });
      const res = await app.inject({ method: "GET", url: START, headers: HOST });
      expect(res.statusCode).toBe(403);
      await app.close();

      expect(recording.spans().length).toBeGreaterThan(0);
      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      expect(dump, "a span attribute leaked the attempt tag").not.toContain(ATTEMPT_TAG);
      expect(dump).not.toContain("?");
      for (const span of recording.spans()) {
        for (const key of Object.keys(span.attributes)) {
          expect(FORBIDDEN_URL_ATTRS, `${key} is a whole-URL attribute`).not.toContain(key);
        }
      }
    });

    it("leaks nothing from the started path — the authorize URL never touches a span", async () => {
      const sessions = new FakeSessionStore();
      // The consult answers `started` with a vendor authorize URL carrying the
      // state + PKCE challenge; the route 302s it. Neither value may reach a
      // span attribute.
      const portal = new FakePortalProvider();
      portal.status = 200;
      portal.headers = { "content-type": "application/json" };
      portal.body = JSON.stringify({
        outcome: "started",
        authorizeUrl: `https://vendor.example/oauth/authorize?state=${VENDOR_STATE}&code_challenge=${VENDOR_CHALLENGE}&code_challenge_method=S256`,
      });

      const token = newSessionToken();
      const id = randomUUID();
      await sessions.createPending({
        id,
        appId: APP_ID,
        user: {
          oid: "alice",
          displayName: "Alice",
          name: null,
          email: null,
          kind: "user",
          groups: [],
        },
        refreshDueAt: new Date(Date.now() + 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await sessions.redeem(id, APP_ID, hashSessionToken(token));
      const app = buildApp({
        config: testEdgeConfig({ auth: testAuthConfig(), internalSecret: Buffer.alloc(32, 7) }),
        registry: new FakeRegistry([
          registryEntry({ appId: APP_ID, slug: "notes", blobPrefix: "apps/f/1/" }),
        ]),
        blob: new FakeBlobReader(),
        sessions,
        oidc: new FakeOidcClient(),
        portal,
      });
      const res = await app.inject({
        method: "GET",
        url: START,
        headers: { ...HOST, cookie: `${SESSION_COOKIE}=${token}`, ...POPUP_HEADERS },
      });
      expect(res.statusCode).toBe(302);
      await app.close();

      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      for (const secret of [ATTEMPT_TAG, VENDOR_STATE, VENDOR_CHALLENGE]) {
        expect(dump, `a span attribute leaked ${secret}`).not.toContain(secret);
      }
      expect(dump).not.toContain("?");
      expect(dump).not.toContain("vendor.example");
      const routeSpan = recording.spans().find((s) => s.name === "helix.consent.start");
      expect(routeSpan?.attributes["url.path"]).toBe("/_api/connections/asana/start");
    });
  });
});
