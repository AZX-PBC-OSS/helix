import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import { FORBIDDEN_URL_ATTRS } from "@azx-pbc/shared/telemetry";
import { withRootSpan } from "./telemetry.js";

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
});
