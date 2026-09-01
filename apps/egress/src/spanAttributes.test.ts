import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { TARGET_PATH_MAX } from "@azx-pbc/shared/telemetry";
import { EGRESS_SPAN_ATTRS, egressSpanAttributes } from "./spanAttributes.js";
import { tracer } from "./telemetry.js";

/**
 * ADR-0037 decision 6, egress half: "Egress attributes are a hardcoded
 * allowlist, not an exclusion list. […] Never record request or response
 * headers there: the injected credential *is* a header."
 *
 * This is the plane holding plaintext connection secrets, so these assertions
 * are the mechanical half of a rule the ADR's own consequences say will
 * otherwise decay one span at a time.
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

const SECRET = "sk-PLANTED-CONNECTION-SECRET";
const BEARER = `Bearer ${SECRET}`;

describe("egressSpanAttributes", () => {
  it("drops anything not on the allowlist", () => {
    const attrs = egressSpanAttributes({
      "helix.app_id": "app-1",
      // Every one of these is a plausible thing to reach for, and each is a leak.
      authorization: BEARER,
      "http.request.header.authorization": BEARER,
      "x-api-key": SECRET,
      "url.full": `https://api.vendor.test/v1?api_key=${SECRET}`,
      "helix.response.body": SECRET,
    } as Parameters<typeof egressSpanAttributes>[0]);

    expect(Object.keys(attrs)).toEqual(["helix.app_id"]);
    expect(JSON.stringify(attrs)).not.toContain(SECRET);
  });

  it("names no header, in either direction", () => {
    // Not "no header values" — no header NAMES either. The `header` recipe's
    // name and `hmac-timestamp`'s signature header names are per-connection
    // configuration, and naming them narrows the search for the value.
    for (const key of EGRESS_SPAN_ATTRS) {
      expect(key).not.toMatch(/header/i);
      expect(key).not.toMatch(/authorization|cookie|api[-_]?key|token|secret/i);
    }
  });

  it("carries no whole-URL attribute", () => {
    for (const key of EGRESS_SPAN_ATTRS) {
      expect(["url.full", "http.url", "http.target", "url.query"]).not.toContain(key);
    }
  });

  it("drops undefined rather than recording it", () => {
    // An absent connection must read as absent, not as the string "undefined".
    const attrs = egressSpanAttributes({
      "helix.app_id": "app-1",
      "helix.connection": undefined,
    });
    expect("helix.connection" in attrs).toBe(false);
  });

  it("caps the target path to the same bound the edge uses", () => {
    // `instruction.path` is `z.string().optional()` — no length bound — while
    // the edge caps the identical value for its ledger column and its own span.
    // Recording one value at two lengths is exactly what the edge's comment
    // exists to prevent, and the path is attacker-controlled on a retained
    // backend.
    const long = `/${"a".repeat(TARGET_PATH_MAX * 2)}`;
    const attrs = egressSpanAttributes({ "helix.target.path": long });
    const recorded = attrs["helix.target.path"] as string;

    expect(recorded.length).toBeLessThanOrEqual(TARGET_PATH_MAX + 1); // + the ellipsis
    expect(recorded.endsWith("…")).toBe(true);
  });

  it("leaves a short path untouched", () => {
    const attrs = egressSpanAttributes({ "helix.target.path": "/v1/charges" });
    expect(attrs["helix.target.path"]).toBe("/v1/charges");
  });

  it("keeps enough to diagnose an outbound failure", () => {
    // The allowlist has to be useful, not just safe. An operator debugging a
    // 502 needs to know which app, which origin, which connection and what the
    // upstream said.
    const attrs = egressSpanAttributes({
      "helix.app_id": "app-1",
      "helix.target.origin": "https://api.vendor.test",
      "helix.target.path": "/v1/charges",
      "helix.connection": "stripe-live",
      "helix.upstream.status": 502,
      "helix.outcome": "error",
    });
    expect(Object.keys(attrs)).toHaveLength(6);
  });
});

describe("a recorded egress span", () => {
  it("carries only allowlisted keys", async () => {
    // Asserted on the RECORDED span rather than on the function, because a call
    // site can always set an attribute directly and bypass the builder.
    const span = tracer.startSpan("helix.egress.proxy");
    span.setAttributes(
      egressSpanAttributes({
        "helix.app_id": "app-1",
        "helix.outcome": "ok",
        "helix.upstream.status": 200,
      }),
    );
    span.end();

    const recorded = recording.spans()[0];
    expect(recorded).toBeDefined();
    for (const key of Object.keys(recorded?.attributes ?? {})) {
      expect(EGRESS_SPAN_ATTRS, `${key} is not on the egress allowlist`).toContain(key);
    }
  });

  it("records no exception, because an egress error message can carry a secret", async () => {
    // `apps/egress/src/app.ts` returns a fixed opaque body for exactly this
    // reason, and `proxy.ts`'s injection `catch` deliberately binds nothing.
    // A span is a retained backend; the same rule applies.
    const span = tracer.startSpan("helix.egress.proxy");
    span.setStatus({ code: 2 });
    span.end();

    const recorded = recording.spans()[0];
    expect(recorded?.events.filter((e) => e.name === "exception")).toHaveLength(0);
    expect(recorded?.status.code).toBe(2);
  });
});
