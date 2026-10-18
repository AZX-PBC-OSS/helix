import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type JWTPayload, jwtVerify } from "jose";
import { INSTRUCTION_AUDIENCE, INSTRUCTION_JWT_TYP } from "@azx-pbc/shared";
import {
  ATTR_APP_ID,
  ATTR_CAPABILITY,
  ATTR_CONNECTION,
  ATTR_PROVIDER_REF,
  ATTR_TARGET_ORIGIN,
  ATTR_TARGET_PATH,
  INSTR_GATEWAY_CALLS,
} from "@azx-pbc/shared/telemetry";
import {
  startRecordingTelemetry,
  type RecordedMetric,
  type RecordingTelemetry,
} from "@azx-pbc/telemetry/testing";
import type { ProxiedOriginCredential } from "../registry/projection.js";
import { FakeUsageStore, registryEntry } from "../test/fakes.js";
import { until } from "../test/socket.js";
import { withRootSpan } from "../telemetry.js";
import { deriveInstructionKey } from "./instruction.js";
import { InMemoryCounterStore } from "./counterStore.js";
import { DenialThrottle } from "./denialThrottle.js";
import type { EgressProvider, EgressRequest, EgressResponse } from "./egressProvider.js";
import {
  runFetchPolicy,
  type FetchPolicyCall,
  type FetchPolicyDeps,
  type FetchPolicyLog,
} from "./fetchPolicy.js";

/**
 * The shared fetch-policy core (ADR-0006) — the explicit caller-authority
 * distinction the signed jobs callback consumes. The browser authority is
 * exercised end to end through the route in `fetch.test.ts` (which also covers
 * the egress outcome mapping); these cases pin at the core what both adapters
 * inherit and no route test can reach: the unattended authority's delegated
 * prohibition with no keyless fallback, the lifecycle-generation fence and its
 * place in the gate order, the denial metering every pre-egress refusal
 * shares, and the per-target span attributes the core sets once the allowlist
 * has matched.
 */

// One recording for the file, per the testing package's lifecycle contract for
// span-asserting files: the edge's module-level ProxyTracer caches its first
// provider, so a mid-file re-registration records nowhere. Metric assertions
// therefore read before/after deltas over the cumulative counters.
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

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secret = randomBytes(32);
const key = deriveInstructionKey(secret);

/** The metered identity an unattended adapter constructs from signed claims. */
const TRIGGERING_IDENTITY = {
  userOid: "oid-triggering-user",
  userName: null,
  userEmail: null,
  userKind: "user" as const,
};

class CapturingEgress implements EgressProvider {
  calls: EgressRequest[] = [];
  /** When set, the forward rejects — standing in for a transport failure. */
  failure: Error | null = null;

  async proxy(req: EgressRequest): Promise<EgressResponse> {
    if (this.failure) throw this.failure;
    this.calls.push(req);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from(JSON.stringify({ ok: true }))]),
      outcome: "ok",
    };
  }

  async close(): Promise<void> {}
}

class RecordingLog implements FetchPolicyLog {
  warnings: { obj: Record<string, unknown>; msg: string }[] = [];
  warn(obj: Record<string, unknown>, msg: string): void {
    this.warnings.push({ obj, msg });
  }
}

function policyEntry(
  connections: Map<string, ProxiedOriginCredential>,
  overrides: { jobsGeneration?: string; requestsPerDay?: number | null } = {},
) {
  return registryEntry({
    slug: "demo",
    appId: APP_ID,
    fetch: {
      connections,
      requestsPerDay: overrides.requestsPerDay ?? null,
      shim: false,
    },
    ...(overrides.jobsGeneration !== undefined ? { jobsGeneration: overrides.jobsGeneration } : {}),
  });
}

function build(
  connections: Map<string, ProxiedOriginCredential>,
  overrides: { jobsGeneration?: string; requestsPerDay?: number | null } = {},
) {
  const egress = new CapturingEgress();
  const usage = new FakeUsageStore();
  const log = new RecordingLog();
  const deps: FetchPolicyDeps = {
    egress,
    usage,
    instructionKey: key,
    denialThrottle: null,
    maxBodyBytes: 10 * 1024 * 1024,
  };
  const base: FetchPolicyCall = {
    entry: policyEntry(connections, overrides),
    env: "prod",
    authority: {
      kind: "unattended",
      identity: TRIGGERING_IDENTITY,
      generation: overrides.jobsGeneration ?? "1",
    },
    target: new URL("https://api.github.com/users/octocat"),
    method: "GET",
    headers: {},
    body: null,
    declaredRequestBytes: null,
    signal: new AbortController().signal,
    correlationId: "req-1",
    log,
  };
  return { deps, base, egress, usage, log };
}

async function decode(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, key, { typ: INSTRUCTION_JWT_TYP });
  return payload;
}

describe("runFetchPolicy — the delegated mint's principal kind", () => {
  it("never fabricates a principal kind for a kindless browser caller", async () => {
    // A session predating the principal-kind column resolves with
    // `userKind: null`. On a delegated origin the mint must carry the provider
    // ref and NO kind: `userKind` is what tells egress to treat the caller as
    // a real principal of that kind, and defaulting the null to something
    // plausible would hand a caller the edge never identified the delegated
    // credential that kind exists to gate. The strict verify's refusal of the
    // kindless mint is the fail-closed answer; fabrication would be the
    // fail-open one.
    const { deps, base, egress } = build(
      new Map<string, ProxiedOriginCredential>([
        ["https://api.github.com", { kind: "provider", provider: "github-app", required: false }],
      ]),
    );
    const result = await runFetchPolicy(deps, {
      ...base,
      authority: {
        kind: "browser",
        identity: { userOid: "oid-kindless", userName: null, userEmail: null, userKind: null },
      },
    });

    expect(result.kind).toBe("forwarded");
    expect(egress.calls).toHaveLength(1);
    const claims = await decode(egress.calls[0]!.instruction);
    expect(claims.provider).toBe("github-app");
    expect(claims.userKind).toBeUndefined();
  });
});

describe("runFetchPolicy — unattended authority", () => {
  it("refuses a provider-bound origin before minting, with no keyless fallback", async () => {
    // A delegated origin spends a user's OAuth connection — unattended work
    // may never spend one, and it must not be stripped and retried keyless:
    // the refusal is the answer, not a downgrade.
    const { deps, base, egress, usage } = build(
      new Map<string, ProxiedOriginCredential>([
        ["https://api.github.com", { kind: "provider", provider: "github-app", required: false }],
        ["https://api.stripe.com", { kind: "keyless" }],
      ]),
    );
    const result = await runFetchPolicy(deps, base);

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.denial.reason).toBe("delegated_unattended");
      expect(result.denial.origin).toBe("https://api.github.com");
    }
    expect(egress.calls).toHaveLength(0);
    // The triggering principal stays the attribution on the refusal row.
    expect(usage.records).toContainEqual(
      expect.objectContaining({
        capability: "fetch",
        model: "https://api.github.com",
        outcome: "forbidden",
        statusCode: 403,
        userOid: "oid-triggering-user",
        userKind: "user",
      }),
    );
  });

  it("fences a stale lifecycle generation before dispatch, and admits the current one", async () => {
    // The job was accepted under generation 1; the app has since been
    // archived and unarchived (generation now 2). The callback presenting 1
    // refuses without dialling; the same origin under the current generation
    // dispatches.
    const connections = new Map<string, ProxiedOriginCredential>([
      ["https://api.github.com", { kind: "keyless" }],
    ]);
    const stale = build(connections, { jobsGeneration: "2" });
    const staleResult = await runFetchPolicy(stale.deps, {
      ...stale.base,
      authority: { kind: "unattended", identity: TRIGGERING_IDENTITY, generation: "1" },
    });
    expect(staleResult.kind).toBe("denied");
    if (staleResult.kind === "denied") expect(staleResult.denial.reason).toBe("generation_stale");
    expect(stale.egress.calls).toHaveLength(0);
    expect(stale.usage.records).toContainEqual(
      expect.objectContaining({
        capability: "fetch",
        outcome: "forbidden",
        statusCode: 403,
        model: "https://api.github.com",
      }),
    );

    const current = build(connections, { jobsGeneration: "2" });
    const currentResult = await runFetchPolicy(current.deps, {
      ...current.base,
      authority: { kind: "unattended", identity: TRIGGERING_IDENTITY, generation: "2" },
    });
    expect(currentResult.kind).toBe("forwarded");
    expect(current.egress.calls).toHaveLength(1);
  });

  it("mints a keyless instruction attributed to the triggering principal", async () => {
    const { deps, base, egress, usage } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
    );
    const result = await runFetchPolicy(deps, base);

    expect(result.kind).toBe("forwarded");
    expect(egress.calls).toHaveLength(1);
    expect(egress.calls[0]!.target).toBe("https://api.github.com/users/octocat");
    expect(egress.calls[0]!.method).toBe("GET");
    const claims = await decode(egress.calls[0]!.instruction);
    expect(claims.origin).toBe("https://api.github.com");
    // The triggering principal is the attribution — after session expiry too.
    expect(claims.userOid).toBe("oid-triggering-user");
    // Unattended mints carry no delegated evidence and no session kind.
    expect(claims.provider).toBeUndefined();
    expect(claims.userKind).toBeUndefined();
    expect(claims.connection).toBeUndefined();
    expect(claims.aud).toBe(INSTRUCTION_AUDIENCE);
    expect(await usage.fetchRequestsToday()).toBe(1);
    expect(usage.records).toContainEqual(
      expect.objectContaining({
        capability: "fetch",
        outcome: "ok",
        userOid: "oid-triggering-user",
        userKind: "user",
        userName: null,
        userEmail: null,
        path: "/users/octocat",
        method: "GET",
      }),
    );
  });

  it("names the stored connection for a secret-bound origin", async () => {
    // Stored-secret origins stay allowed unattended: the secret lives in
    // egress, the instruction names it, and neither the app nor the job ever
    // sees it.
    const { deps, base, egress } = build(
      new Map<string, ProxiedOriginCredential>([
        ["https://api.github.com", { kind: "secret", connection: "github-token" }],
      ]),
    );
    const result = await runFetchPolicy(deps, base);

    expect(result.kind).toBe("forwarded");
    const claims = await decode(egress.calls[0]!.instruction);
    expect(claims.connection).toBe("github-token");
    expect(claims.provider).toBeUndefined();
    expect(claims.userKind).toBeUndefined();
  });

  it("refuses on the daily budget before minting, as a quota_blocked row", async () => {
    const { deps, base, egress, usage } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
      { requestsPerDay: 1 },
    );
    usage.fetchToday = 1;
    const result = await runFetchPolicy(deps, base);

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.denial.reason).toBe("budget_exhausted");
    expect(egress.calls).toHaveLength(0);
    expect(usage.records).toContainEqual(
      expect.objectContaining({
        capability: "fetch",
        outcome: "quota_blocked",
        statusCode: 429,
        userOid: "oid-triggering-user",
      }),
    );
  });

  it("ledgers a failed forward and hands the error to the adapter", async () => {
    // The row is the core's to write for every adapter; the error is the
    // adapter's to classify into its own response vocabulary.
    const { deps, base, egress, usage } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
    );
    egress.failure = new Error("dial failed");
    const result = await runFetchPolicy(deps, base);

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toBe(egress.failure);
    expect(usage.records).toContainEqual(
      expect.objectContaining({ capability: "fetch", outcome: "error", statusCode: null }),
    );
  });

  it("fences a stale generation before the allowlist look", async () => {
    // The gate order is itself the contract: a call presenting a generation
    // the app has moved past refuses as `generation_stale` even when its
    // origin would also have failed the allowlist — the callback adapter maps
    // the two refusals to different answers, and the stale word is the one
    // that says "the app changed, not the call".
    const { deps, base, egress } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
      { jobsGeneration: "2" },
    );
    const result = await runFetchPolicy(deps, {
      ...base,
      target: new URL("https://api.evil.com/steal"),
      // The call presents the generation the job was accepted under (1); the
      // app has since moved to 2.
      authority: { kind: "unattended", identity: TRIGGERING_IDENTITY, generation: "1" },
    });

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.denial.reason).toBe("generation_stale");
    expect(egress.calls).toHaveLength(0);
  });

  it("refuses a delegated origin before the budget gate, so the refusal spends none of it", async () => {
    // The delegated prohibition sits ahead of the quota read: an unattended
    // call against a delegated origin is refused as `forbidden` — a
    // `quota_blocked` row would claim the budget gate saw and refused it,
    // which is a different event an operator sizes a requestsPerDay bump by.
    const { deps, base, egress, usage } = build(
      new Map<string, ProxiedOriginCredential>([
        ["https://api.github.com", { kind: "provider", provider: "github-app", required: false }],
      ]),
      { requestsPerDay: 1 },
    );
    usage.fetchToday = 1;
    const result = await runFetchPolicy(deps, base);

    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.denial.reason).toBe("delegated_unattended");
    expect(egress.calls).toHaveLength(0);
    expect(usage.records).not.toContainEqual(expect.objectContaining({ outcome: "quota_blocked" }));
    expect(usage.records).toContainEqual(expect.objectContaining({ outcome: "forbidden" }));
  });
});

describe("runFetchPolicy — the shared denial metering", () => {
  it("caps the denial rows past the budget, never the metric, and reports the magnitude once", async () => {
    // Every pre-egress denial the core can reach meters through one mechanism
    // (the allowlist refusal's cap is pinned through the browser route in
    // fetch.test.ts; this drives the two unattended refusals through the same
    // throttle). Both halves are pinned: past the budget the ledger row is
    // dropped while `helix.gateway.calls` still counts every refusal — the
    // deliberate divergence that makes the counter and the ledger provably
    // irreconcilable (ADR-0037 decision 9) — and the flood logs one magnitude
    // summary, not one line per dropped row.
    const throttle = new DenialThrottle(new InMemoryCounterStore(), { max: 1, windowMs: 60_000 });
    const { deps, base, usage, log } = build(
      new Map<string, ProxiedOriginCredential>([
        ["https://api.github.com", { kind: "keyless" }],
        ["https://api.stripe.com", { kind: "provider", provider: "github-app", required: false }],
      ]),
    );
    const throttled = { ...deps, denialThrottle: throttle };
    const before = await recording.metrics();

    const stale = await runFetchPolicy(throttled, {
      ...base,
      authority: { kind: "unattended", identity: TRIGGERING_IDENTITY, generation: "9" },
    });
    expect(stale).toMatchObject({ kind: "denied", denial: { reason: "generation_stale" } });

    const delegated = await runFetchPolicy(throttled, {
      ...base,
      target: new URL("https://api.stripe.com/v1/charges"),
    });
    expect(delegated).toMatchObject({
      kind: "denied",
      denial: { reason: "delegated_unattended" },
    });

    // One forbidden row — the second denial's was suppressed by the budget…
    expect(usage.records.filter((r) => r.outcome === "forbidden")).toHaveLength(1);
    // …while the counter moved for both refusals.
    const after = await recording.metrics();
    expect(forbiddenDelta(after) - forbiddenDelta(before)).toBe(2);

    // One magnitude summary, on the first suppressed attempt, carrying the
    // bounded attribution — never the target's path or query.
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toMatchObject({
      obj: { appId: APP_ID, env: "prod", origin: "https://api.stripe.com", attempts: 2 },
      msg: expect.stringContaining("suppressed"),
    });
  });

  function forbiddenDelta(points: RecordedMetric[]): number {
    return points
      .filter(
        (p) =>
          p.name === INSTR_GATEWAY_CALLS &&
          p.attributes["helix.capability"] === "fetch" &&
          p.attributes["helix.outcome"] === "forbidden",
      )
      .reduce((n, p) => n + p.value, 0);
  }
});

describe("runFetchPolicy — a ledger failure never changes the policy's answer", () => {
  /** A ledger the store cannot write to — the failure mode every record site in the core must contain. */
  class RejectingUsageStore extends FakeUsageStore {
    override async record(): Promise<void> {
      throw new Error("ledger down");
    }
  }

  /** Flush the fire-and-forget denial record's rejection into its catch. */
  async function flushRecordFailure(log: RecordingLog): Promise<void> {
    await until(() => log.warnings.length > 0, "the record-failure warning");
  }

  it("contains a record rejection on the unawaited denial path — warning, never an unhandled rejection", async () => {
    // The denial row is deliberately fire-and-forget (`void`, unawaited): a
    // rejection with nowhere to go is an unhandled rejection — which Node
    // answers by killing the process. The containment is the contract: the
    // caller gets its denial, the ledger failure lands in a warn.
    const log = new RecordingLog();
    const deps = {
      ...build(
        new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
      ).deps,
      usage: new RejectingUsageStore(),
    };
    const { base } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
    );
    const result = await runFetchPolicy(deps, {
      ...base,
      target: new URL("https://api.evil.com/steal"),
      log,
    });
    expect(result.kind).toBe("denied");
    await flushRecordFailure(log);
    expect(log.warnings[0]).toMatchObject({ msg: expect.stringContaining("usage record failed") });
  });

  it("contains a record rejection on the budget denial and failed-forward paths — the denials still return", async () => {
    // The other two record sites are awaited with a catch — a broken ledger
    // degrades to the warn and the caller's answer stands: the budget refusal
    // stays a refusal, the failed forward stays a failed forward.
    const connections = new Map<string, ProxiedOriginCredential>([
      ["https://api.github.com", { kind: "keyless" }],
    ]);

    const budgeted = build(connections, { requestsPerDay: 1 });
    const budgetUsage = new RejectingUsageStore();
    budgetUsage.fetchToday = 1;
    const budgetResult = await runFetchPolicy(
      { ...budgeted.deps, usage: budgetUsage },
      budgeted.base,
    );
    expect(budgetResult.kind).toBe("denied");

    const failing = build(connections);
    failing.egress.failure = new Error("dial failed");
    const failedResult = await runFetchPolicy(
      { ...failing.deps, usage: new RejectingUsageStore() },
      failing.base,
    );
    expect(failedResult.kind).toBe("failed");

    for (const log of [budgeted.log, failing.log]) {
      expect(log.warnings).toHaveLength(1);
      expect(String(log.warnings[0]?.obj.err)).toContain("ledger down");
      expect(log.warnings[0]?.msg).toContain("usage record failed");
    }
  });
});

describe("runFetchPolicy — the request-body cap as the reusable core states it", () => {
  it("refuses a materialized body past the cap even when the declared size lies", async () => {
    // `FetchPolicyCall.body` is typed `Readable | Buffer | string | null` and
    // promises "byte-capped on the way out"; the cap is described as the real,
    // framing-independent enforcement that a lying content-length cannot
    // bypass. That counter only wraps `Readable` bodies — a Buffer is handed
    // to egress as-is, so a lying declaration walks a materialized body past
    // the cap whole. The cap contract, as the core states it, is what is
    // asserted: an over-cap body must be refused (`request_too_large`), never
    // forwarded.
    const { deps, base, egress } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
    );
    const result = await runFetchPolicy(
      { ...deps, maxBodyBytes: 1024 },
      {
        ...base,
        method: "POST",
        body: Buffer.alloc(64 * 1024, 0x61),
        declaredRequestBytes: 5, // the lie the byte counter is supposed to make irrelevant
      },
    );

    expect(result).toMatchObject({ kind: "denied", denial: { reason: "request_too_large" } });
    const forwarded = egress.calls[0]?.body;
    const forwardedBytes = Buffer.isBuffer(forwarded) ? forwarded.length : 0;
    expect(forwardedBytes).toBeLessThanOrEqual(1024);
  });

  it("meters the fast-path request_too_large denial like every other pre-egress denial", async () => {
    // The core's own invariant: "Every pre-egress policy denial is ledgered —
    // capped, metric unconditional." Four of the five denial reasons hold to
    // it; the fast-path refusal (a truthful oversized content-length) returns
    // without metering, so a flood of oversized uploads is invisible in both
    // the counter and the audit trail — while the SAME failure caught a moment
    // later by the byte counter (a lying content-length) ledgers as a refusal.
    // The docblock's invariant is what is asserted, on both halves.
    const { deps, base, usage } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
    );
    const before = await recording.metrics();

    const result = await runFetchPolicy(deps, {
      ...base,
      method: "POST",
      body: Readable.from([Buffer.alloc(8)]),
      declaredRequestBytes: deps.maxBodyBytes + 1,
    });
    expect(result).toMatchObject({ kind: "denied", denial: { reason: "request_too_large" } });

    const after = await recording.metrics();
    expect(gatewayCallsDelta(after) - gatewayCallsDelta(before)).toBeGreaterThan(0);
    // The denial row is fire-and-forget once metered — flush it rather than
    // race it.
    await until(() => usage.records.length > 0, "the fast-path denial's ledger row");
    expect(usage.records.length).toBeGreaterThan(0);
    // The row mirrors the answer the caller actually gets — the whole point of
    // `meterPolicyDenial`'s outcome/statusCode parameters. The 413 fast path is
    // the one denial whose values differ from the 403 default, so it is where a
    // hardcoded 403 (or a dropped parameter) would first contradict the audit
    // trail an operator filters by status.
    expect(usage.records[0]).toMatchObject({
      capability: "fetch",
      outcome: "forbidden",
      statusCode: 413,
      errorDetail: "request body exceeds the size cap",
      method: "POST",
    });
  });

  it("keeps the boundary exact: a body at the cap forwards whole, one byte over refuses", async () => {
    // The fast path's comparison is `>`: a body exactly at the cap is within
    // allowance, cap+1 is not. A `>=` flip or an off-by-one here either
    // refuses a legitimate call or passes an oversized one — both sides
    // pinned, no declaration in play (the direct comparison is the only gate).
    const connections = new Map<string, ProxiedOriginCredential>([
      ["https://api.github.com", { kind: "keyless" }],
    ]);
    const atCap = build(connections);
    const atCapResult = await runFetchPolicy(
      { ...atCap.deps, maxBodyBytes: 1024 },
      { ...atCap.base, method: "POST", body: Buffer.alloc(1024, 0x61), declaredRequestBytes: null },
    );
    expect(atCapResult).toMatchObject({ kind: "forwarded" });
    expect(atCap.egress.calls).toHaveLength(1);
    expect(atCap.egress.calls[0]?.body).toEqual(Buffer.alloc(1024, 0x61));

    const over = build(connections);
    const overResult = await runFetchPolicy(
      { ...over.deps, maxBodyBytes: 1024 },
      { ...over.base, method: "POST", body: Buffer.alloc(1025, 0x61), declaredRequestBytes: null },
    );
    expect(overResult).toMatchObject({ kind: "denied", denial: { reason: "request_too_large" } });
    expect(over.egress.calls).toHaveLength(0);
  });

  it("measures a string body in bytes, not characters — a multi-byte body over the cap refuses", async () => {
    // 700 `é` characters are 700 UTF-16 units but 1400 UTF-8 bytes: a
    // `.length` measurement would forward this body past a 1024-byte cap with
    // no declaration to catch it. `Buffer.byteLength` is the arm's whole
    // point; the refusal and the no-false-trip mirror are both pinned.
    const connections = new Map<string, ProxiedOriginCredential>([
      ["https://api.github.com", { kind: "keyless" }],
    ]);
    const over = build(connections);
    const overResult = await runFetchPolicy(
      { ...over.deps, maxBodyBytes: 1024 },
      {
        ...over.base,
        method: "POST",
        body: "\u00e9".repeat(700),
        declaredRequestBytes: null,
      },
    );
    expect(overResult).toMatchObject({ kind: "denied", denial: { reason: "request_too_large" } });
    expect(over.egress.calls).toHaveLength(0);

    const under = build(connections);
    const underResult = await runFetchPolicy(
      { ...under.deps, maxBodyBytes: 1024 },
      { ...under.base, method: "POST", body: "a".repeat(700), declaredRequestBytes: null },
    );
    expect(underResult).toMatchObject({ kind: "forwarded" });
    expect(under.egress.calls[0]?.body).toBe("a".repeat(700));
  });

  it("does not mistake a bodyless method's bogus content-length for an over-cap body", async () => {
    // A GET carries no body, so it has nothing to cap — but nothing stops a
    // client from sending a huge content-length header anyway. The bodyless
    // exemption (`!bodyless`) is the only thing between that stray header and
    // a blanket 413 on every GET that carries one.
    const { deps, base, egress } = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
    );
    const result = await runFetchPolicy(deps, {
      ...base,
      method: "GET",
      declaredRequestBytes: deps.maxBodyBytes + 1, // the stray header
    });
    expect(result).toMatchObject({ kind: "forwarded" });
    expect(egress.calls).toHaveLength(1);
  });

  function gatewayCallsDelta(points: RecordedMetric[]): number {
    return points
      .filter(
        (p) =>
          p.name === INSTR_GATEWAY_CALLS &&
          p.attributes[ATTR_CAPABILITY] === "fetch" &&
          p.attributes[ATTR_APP_ID] === APP_ID,
      )
      .reduce((n, p) => n + p.value, 0);
  }
});

describe("runFetchPolicy — the per-target span attributes", () => {
  it("records the granted origin and its credential source once the allowlist matches — and nothing before it", async () => {
    // The attributes live in the core so every adapter's span says which
    // upstream was called — but only after the origin matched the manifest
    // allowlist, or cleared the generation fence: an origin the app merely
    // attempted is not a value worth recording under a stable key.
    const granted = build(
      new Map<string, ProxiedOriginCredential>([
        ["https://api.github.com", { kind: "keyless" }],
        ["https://api.stripe.com", { kind: "secret", connection: "stripe" }],
      ]),
    );
    await withRootSpan("policy.forwarded.keyless", {}, async () => {
      await runFetchPolicy(granted.deps, granted.base);
    });
    await withRootSpan("policy.forwarded.secret", {}, async () => {
      await runFetchPolicy(granted.deps, {
        ...granted.base,
        target: new URL("https://api.stripe.com/v1/charges"),
      });
    });

    const stale = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
      { jobsGeneration: "2" },
    );
    await withRootSpan("policy.denied.stale", {}, async () => {
      await runFetchPolicy(stale.deps, {
        ...stale.base,
        authority: { kind: "unattended", identity: TRIGGERING_IDENTITY, generation: "1" },
      });
    });

    const ungranted = build(
      new Map<string, ProxiedOriginCredential>([["https://api.github.com", { kind: "keyless" }]]),
    );
    await withRootSpan("policy.denied.ungranted", {}, async () => {
      await runFetchPolicy(ungranted.deps, {
        ...ungranted.base,
        target: new URL("https://api.evil.com/steal"),
      });
    });

    const span = (name: string) => {
      const found = recording.spans().find((s) => s.name === name);
      expect(found, name).toBeDefined();
      return found?.attributes;
    };

    // A forwarded keyless call: which upstream, which path — no credential
    // source, because a keyless origin has none.
    const keyless = span("policy.forwarded.keyless");
    expect(keyless).toMatchObject({
      [ATTR_TARGET_ORIGIN]: "https://api.github.com",
      [ATTR_TARGET_PATH]: "/users/octocat",
    });
    expect(keyless?.[ATTR_CONNECTION]).toBeUndefined();
    expect(keyless?.[ATTR_PROVIDER_REF]).toBeUndefined();

    // A forwarded secret-bound call names the connection — the same word the
    // instruction carries, never a secret value.
    const secret = span("policy.forwarded.secret");
    expect(secret).toMatchObject({
      [ATTR_TARGET_ORIGIN]: "https://api.stripe.com",
      [ATTR_CONNECTION]: "stripe",
    });
    expect(secret?.[ATTR_PROVIDER_REF]).toBeUndefined();

    // Neither refusal records the attempted origin under the target keys.
    for (const name of ["policy.denied.stale", "policy.denied.ungranted"]) {
      const denied = span(name);
      expect(denied?.[ATTR_TARGET_ORIGIN]).toBeUndefined();
      expect(denied?.[ATTR_TARGET_PATH]).toBeUndefined();
      expect(denied?.[ATTR_CONNECTION]).toBeUndefined();
      expect(denied?.[ATTR_PROVIDER_REF]).toBeUndefined();
    }
  });
});
