import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { DataCapabilitySchema } from "@azx-pbc/shared";
import {
  ATTR_DATA_MATCH_COUNT,
  ATTR_DATA_VERB,
  ATTR_REASON,
  FORBIDDEN_URL_ATTRS,
  INSTR_GATEWAY_CALLS,
  SPAN_DATA,
} from "@azx-pbc/shared/telemetry";
import { buildApp } from "../app.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import {
  FakeAppDataStore,
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";

/**
 * ADR-0042 decision 7 — the list verb is a new route and the prefix check a new
 * decision point that can deny, so both are instrumented, and this file holds
 * the list verb to ADR-0037's rules with the same every-attribute scan the
 * other adversarial suites use:
 *
 *  - the span says WHICH route ran (`url.path`, query gone — the prefix and
 *    cursor live in the query) and HOW MANY keys matched, but never the prefix
 *    value and never a matched key — those are app data, and a span is a
 *    retained backend;
 *  - the deny path is distinguishable from the empty result on both the span
 *    (`helix.reason` vs `helix.data.match_count: 0`) and the counter
 *    (`outcome=forbidden` vs `ok`);
 *  - `userOid` is nowhere (it is never a dimension — ADR-0037 decision 8).
 */

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOST = "notes.local.helix.azxlabs.io";

/**
 * ONE recording for the whole file — a second `startRecordingTelemetry()` would
 * record nothing, because the module-level tracer caches its delegate on first
 * use (see `spans.test.ts` for the full explanation).
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

function buildListEdge(sharedReadPrefixes: string[]) {
  const store = new FakeAppDataStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "notes",
        blobPrefix: "apps/c/1/",
        visibilityMode: "public",
        // Schema-parse fills every array — the entry's `data` is the full shape.
        data: DataCapabilitySchema.parse({ user: false, sharedReadPrefixes }),
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    usage: new FakeUsageStore(),
    appData: store,
  });
  return { app, store };
}

/** The spans this request produced, filtered to the data-gateway root span. */
function dataSpans() {
  return recording.spans().filter((s) => s.name === SPAN_DATA);
}

describe("the shared list verb's span (ADR-0042 decision 7)", () => {
  it("records url.path, the verb and the match count — never the prefix or the keys", async () => {
    const { app, store } = buildListEdge(["record:"]);
    await store.putShared(APP_ID, "record:zzz", { secret: "PLANTED-VALUE" }, "prod", {
      kind: "ifNoneMatch",
    });

    const res = await app.inject({
      method: "GET",
      url: "/_api/data/shared?prefix=record:",
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const spans = dataSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0]!.attributes;
    expect(attrs["url.path"]).toBe("/_api/data/shared"); // the query — prefix and all — is gone
    // The span's verb dimension is the handler name (bounded by the handler
    // set); the ledger's `model` column carries the dotted form, `shared.list`.
    expect(attrs[ATTR_DATA_VERB]).toBe("listShared");
    expect(attrs[ATTR_DATA_MATCH_COUNT]).toBe(1);
    expect(attrs[ATTR_REASON]).toBeUndefined(); // ok path carries no deny reason

    // The every-attribute scan: neither the requested prefix value nor any
    // matched key nor the stored value may ride the span.
    const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
    expect(dump).not.toContain("record:zzz");
    expect(dump).not.toContain("PLANTED-VALUE");
    expect(dump).not.toContain("?");
    // And no whole-URL attribute key, same rule as every other span.
    for (const key of Object.keys(attrs)) {
      expect(FORBIDDEN_URL_ATTRS, `${key} is a whole-URL attribute`).not.toContain(key);
    }
  });

  it("carries the deny reason on a 403 and stays distinguishable from an empty result", async () => {
    const edge = buildListEdge(["record:"]);

    const denied = await edge.app.inject({
      method: "GET",
      url: "/_api/data/shared?prefix=PLANTED-DENIED-PREFIX:",
      headers: { host: HOST },
    });
    expect(denied.statusCode).toBe(403);
    await edge.app.close();

    const spans = dataSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0]!.attributes;
    expect(attrs[ATTR_REASON]).toBe("prefix_not_granted");
    expect(attrs[ATTR_DATA_MATCH_COUNT]).toBeUndefined();
    // The denied prefix value is app input; it does not ride the span.
    expect(JSON.stringify(recording.spans().map((s) => s.attributes))).not.toContain(
      "PLANTED-DENIED-PREFIX",
    );

    // Empty result on the same route: no reason, match count 0 — the two states
    // are distinguishable from the span alone.
    recording.reset();
    const empty = buildListEdge(["record:"]);
    const res = await empty.app.inject({
      method: "GET",
      url: "/_api/data/shared?prefix=record:",
      headers: { host: HOST },
    });
    expect(res.statusCode).toBe(200);
    await empty.app.close();
    expect(dataSpans()[0]!.attributes[ATTR_DATA_MATCH_COUNT]).toBe(0);
    expect(dataSpans()[0]!.attributes[ATTR_REASON]).toBeUndefined();
  });

  it("meters ok and forbidden on the existing gateway counter, with no user identifier", async () => {
    const denied = buildListEdge(["record:"]);
    const d = await denied.app.inject({
      method: "GET",
      url: "/_api/data/shared?prefix=nope:",
      headers: { host: HOST },
    });
    expect(d.statusCode).toBe(403);
    await denied.app.close();

    const ok = buildListEdge(["record:"]);
    const o = await ok.app.inject({
      method: "GET",
      url: "/_api/data/shared?prefix=record:",
      headers: { host: HOST },
    });
    expect(o.statusCode).toBe(200);
    await ok.app.close();

    const points = (await recording.metrics()).filter((p) => p.name === INSTR_GATEWAY_CALLS);
    const outcomes = points.map((p) => p.attributes["helix.outcome"]).sort();
    expect(outcomes).toEqual(["forbidden", "ok"]);
    for (const point of points) {
      expect(point.attributes["helix.capability"]).toBe("data");
      // userOid is never a dimension — bounded, non-personal only (ADR-0037
      // decision 8); appId is the per-app breakdown and is present.
      expect(Object.keys(point.attributes)).not.toContain("helix.user_oid");
      expect(point.attributes["helix.app_id"]).toBe(APP_ID);
    }
  });
});
