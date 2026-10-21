import { describe, expect, it } from "vitest";
import { JOBS_DIAGNOSTIC_QUALIFIED_TYPE } from "@azx-pbc/shared";
import { loadEdgeJobsConfig } from "../config.js";
import {
  buildDevJobsEdge,
  buildJobsEdge,
  FakeJobsForwarder,
  isJobsError,
  JOBS_DEV_BEARER,
  JOBS_DEV_ORIGIN,
  seedJobsSession,
} from "../test/jobsGateway.js";

/**
 * The production edge's diagnostic-type refusal (the config-level
 * `refuseDiagnosticTypes` filter). A production edge answers a diagnostic
 * submission with the ordinary ungranted 403 — the same `forbidden` outcome a
 * missing grant produces, so the existing span/metric/ledger recording
 * applies — and never binds the diagnostic type into a record instruction's
 * grants. The non-production postures that forward the type live in
 * `gateway/jobs.test.ts`; here they are the contrast cases.
 */

const SUBMIT_URL = "/_api/jobs/jobs/types/diagnostic";
const PAYLOAD = JSON.stringify({ steps: 1 });

describe("a production edge refuses the diagnostic type", () => {
  it("a granted diagnostic submission is the ungranted 403, and nothing is forwarded", async () => {
    const harness = buildJobsEdge({
      refuseDiagnosticTypes: true,
      jobs: { types: ["jobs:fetch", JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
    });
    const token = await seedJobsSession(harness.sessions, "alice");
    const res = await harness.app.inject({
      method: "POST",
      url: SUBMIT_URL,
      headers: {
        host: "demo.local.helix.azxlabs.io",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
        origin: "https://demo.local.helix.azxlabs.io:8080",
        cookie: `__Host-session=${token}`,
      },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(403);
    expect(isJobsError(res.json(), "forbidden")).toBe(true);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });

  it("client-supplied enable attempts change nothing", async () => {
    const harness = buildJobsEdge({
      refuseDiagnosticTypes: true,
      jobs: { types: ["jobs:fetch", JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
    });
    const token = await seedJobsSession(harness.sessions, "alice");
    const base = {
      host: "demo.local.helix.azxlabs.io",
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
      origin: "https://demo.local.helix.azxlabs.io:8080",
      cookie: `__Host-session=${token}`,
    };
    // Every spelling a client might invent for an opt-in: headers, a query
    // string, and a body control. None of them is a configuration surface —
    // the refusal comes from the process's own NODE_ENV.
    const attempts: Array<{ url: string; headers: Record<string, string>; payload: string }> = [
      { url: SUBMIT_URL, headers: { ...base, "x-helix-diagnostics": "1" }, payload: PAYLOAD },
      {
        url: SUBMIT_URL,
        headers: { ...base, "x-helix-jobs-diagnostics": "true" },
        payload: PAYLOAD,
      },
      { url: SUBMIT_URL, headers: { ...base, "x-jobs-diagnostics": "enabled" }, payload: PAYLOAD },
      { url: `${SUBMIT_URL}?diagnostics=1`, headers: base, payload: PAYLOAD },
      { url: SUBMIT_URL, headers: base, payload: JSON.stringify({ steps: 1, diagnostics: true }) },
    ];
    for (const attempt of attempts) {
      const res = await harness.app.inject({ method: "POST", ...attempt });
      expect(res.statusCode, `url ${attempt.url} headers ${JSON.stringify(attempt.headers)}`).toBe(
        403,
      );
      expect(isJobsError(res.json(), "forbidden")).toBe(true);
    }
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });

  it("a fetch submission still forwards, with the diagnostic grant filtered out of allowedTypes", async () => {
    const harness = buildJobsEdge({
      refuseDiagnosticTypes: true,
      jobs: { types: ["jobs:fetch", JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
    });
    const token = await seedJobsSession(harness.sessions, "alice");
    const res = await harness.app.inject({
      method: "POST",
      url: "/_api/jobs/jobs/types/fetch",
      headers: {
        host: "demo.local.helix.azxlabs.io",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
        origin: "https://demo.local.helix.azxlabs.io:8080",
        cookie: `__Host-session=${token}`,
      },
      payload: '{"url":"https://api.vendor.test/v1"}',
    });
    expect(res.statusCode).toBe(202);
    expect(harness.forwarder.submitSpecs).toHaveLength(1);
    expect(harness.forwarder.submitSpecs[0]!.identity.allowedTypes).toEqual(["jobs:fetch"]);

    // A poll of the accepted job forwards with the same narrowed grants: the
    // record instruction never binds the diagnostic type either.
    harness.forwarder.recordSpecs.length = 0;
    const poll = await harness.app.inject({
      method: "GET",
      url: "/_api/jobs/jobs/job-123",
      headers: { host: "demo.local.helix.azxlabs.io", cookie: `__Host-session=${token}` },
    });
    expect(poll.statusCode).toBe(200);
    expect(harness.forwarder.recordSpecs).toHaveLength(1);
    expect(harness.forwarder.recordSpecs[0]!.identity.allowedTypes).toEqual(["jobs:fetch"]);
  });

  it("an ungranted diagnostic type is 403 on a non-production edge too — the filter is not the grant", async () => {
    const harness = buildJobsEdge({
      refuseDiagnosticTypes: false,
      jobs: { types: ["jobs:fetch"] },
    });
    const token = await seedJobsSession(harness.sessions, "alice");
    const res = await harness.app.inject({
      method: "POST",
      url: SUBMIT_URL,
      headers: {
        host: "demo.local.helix.azxlabs.io",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
        origin: "https://demo.local.helix.azxlabs.io:8080",
        cookie: `__Host-session=${token}`,
      },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(403);
    expect(isJobsError(res.json(), "forbidden")).toBe(true);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });
});

describe("a non-production edge forwards the diagnostic type", () => {
  it("a granted diagnostic submission reaches the forwarder as jobs:diagnostic", async () => {
    const harness = buildJobsEdge({
      refuseDiagnosticTypes: false,
      jobs: { types: ["jobs:fetch", JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
    });
    const token = await seedJobsSession(harness.sessions, "alice");
    const res = await harness.app.inject({
      method: "POST",
      url: SUBMIT_URL,
      headers: {
        host: "demo.local.helix.azxlabs.io",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
        origin: "https://demo.local.helix.azxlabs.io:8080",
        cookie: `__Host-session=${token}`,
      },
      payload: PAYLOAD,
    });
    expect(res.statusCode).toBe(202);
    expect(harness.forwarder.submitSpecs).toHaveLength(1);
    expect(harness.forwarder.submitSpecs[0]!.type).toBe(JOBS_DIAGNOSTIC_QUALIFIED_TYPE);
    expect(harness.forwarder.submitSpecs[0]!.identity.allowedTypes).toEqual([
      "jobs:fetch",
      JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
    ]);
  });
});

describe("the dev gateway refuses the same way in production mode", () => {
  it("a diagnostic submission is the ungranted 403 and nothing is forwarded", async () => {
    const forwarder = new FakeJobsForwarder("jobs");
    const app = await buildDevJobsEdge(forwarder, {
      refuseDiagnosticTypes: true,
      jobs: { types: ["jobs:fetch", JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/myapp/_api/jobs/jobs/types/diagnostic",
        headers: {
          host: "dev-api.local.helix.azxlabs.io",
          "content-type": "application/json",
          origin: JOBS_DEV_ORIGIN,
          authorization: `Bearer ${JOBS_DEV_BEARER}`,
        },
        payload: PAYLOAD,
      });
      expect(res.statusCode).toBe(403);
      expect(isJobsError(res.json(), "forbidden")).toBe(true);
      expect(forwarder.submitSpecs).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe("loadEdgeJobsConfig sets the refusal from NODE_ENV", () => {
  const DOCUMENT = JSON.stringify({
    servers: {
      jobs: {
        endpoint: "https://jobs.internal.helix",
        edgeToJobsRoot: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        jobsToEdgeRoot: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      },
    },
  });

  it("production refuses; absent NODE_ENV and non-production values do not", () => {
    expect(
      loadEdgeJobsConfig({ NODE_ENV: "production", EDGE_JOBS_CONFIG: DOCUMENT })
        .refuseDiagnosticTypes,
    ).toBe(true);
    expect(loadEdgeJobsConfig({ NODE_ENV: "production" }).refuseDiagnosticTypes).toBe(true);
    expect(loadEdgeJobsConfig({ EDGE_JOBS_CONFIG: DOCUMENT }).refuseDiagnosticTypes).toBe(false);
    expect(
      loadEdgeJobsConfig({ NODE_ENV: "test", EDGE_JOBS_CONFIG: DOCUMENT }).refuseDiagnosticTypes,
    ).toBe(false);
    expect(loadEdgeJobsConfig({}).refuseDiagnosticTypes).toBe(false);
  });
});
