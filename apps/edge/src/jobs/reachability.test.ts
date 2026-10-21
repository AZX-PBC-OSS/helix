import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { JOBS_REACHABILITY_CHECK } from "@azx-pbc/shared";
import { ATTR_OUTCOME, INSTR_JOBS_REACHABILITY_PROBES } from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import {
  JOBS_REACHABILITY_INTERVAL_MS,
  JOBS_REACHABILITY_STALE_AFTER_MS,
  JobsReachability,
  jobsReachabilityCheck,
  type JobsProbeAnswer,
  type JobsReachabilityLogger,
  type JobsReachabilitySnapshot,
} from "./reachability.js";

/**
 * The reachability loop's state machine, driven through an injected probe —
 * the boundary (the jobs server's HTTP endpoint) — so the per-server
 * transitions, the cadence and the release paths are pinned without a
 * network. The real probe against a real HTTP endpoint, and the health-body
 * composition those observations feed, are the integration suite's and the
 * app test's.
 */

interface CapturedLine {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
}

function silentLog(): { lines: CapturedLine[]; log: JobsReachabilityLogger } {
  const lines: CapturedLine[] = [];
  return {
    lines,
    log: {
      info: (fields, msg) => lines.push({ level: "info", fields, msg }),
      warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
      error: (fields, msg) => lines.push({ level: "error", fields, msg }),
    },
  };
}

const SERVERS = [
  { server: "jobs", endpoint: "http://jobs.internal:3003" },
  { server: "jobs-eu", endpoint: "http://jobs-eu.internal:3003" },
];

const REACHABLE: JobsProbeAnswer = { outcome: "reachable", reported: "ok" };
const NO_ANSWER: JobsProbeAnswer = { outcome: "unreachable", reason: "no_answer" };

function makeLoop(options: {
  probe: (endpoint: string, timeoutMs: number) => Promise<JobsProbeAnswer>;
  intervalMs?: number;
}): { loop: JobsReachability; lines: CapturedLine[] } {
  const { lines, log } = silentLog();
  const loop = new JobsReachability({
    servers: SERVERS,
    intervalMs: options.intervalMs,
    timeoutMs: 250,
    probe: options.probe,
    log,
  });
  return { loop, lines };
}

describe("the reachability loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  test("every server is pending — unhealthy, never ok — until its first probe lands", async () => {
    const { loop } = makeLoop({ probe: async () => REACHABLE });
    const before = loop.snapshot();
    expect(before.started).toBe(false);
    expect(before.servers.map((s) => s.state)).toEqual(["pending", "pending"]);

    loop.start();
    expect(loop.snapshot().started).toBe(true);
    // The first pass is in flight: still pending, still unobserved —
    // "nothing has answered yet" is not health.
    expect(loop.snapshot().servers.map((s) => s.state)).toEqual(["pending", "pending"]);
    await flush();
    const observed = loop.snapshot();
    expect(observed.servers.map((s) => s.state)).toEqual(["reachable", "reachable"]);
    expect(observed.servers.map((s) => s.reported)).toEqual(["ok", "ok"]);
    expect(observed.lastOkPassAt).not.toBeNull();
  });

  test("the loop keeps its cadence without any user request", async () => {
    let probes = 0;
    const { loop } = makeLoop({
      probe: async () => {
        probes += 1;
        return REACHABLE;
      },
      intervalMs: 1_000,
    });
    loop.start();
    await flush();
    expect(probes).toBe(2); // one pass, both servers
    await vi.advanceTimersByTimeAsync(3_000);
    expect(probes).toBe(8); // four passes, both servers each
  });

  test("an unreachable server records its episode; recovery resets it and the transitions log once", async () => {
    // Answers keyed per endpoint — the two servers are probed together, so a
    // shared call counter cannot express "both fail the next pass".
    let next: JobsProbeAnswer = REACHABLE;
    const { loop, lines } = makeLoop({ probe: async () => next });
    loop.start();
    await flush();
    expect(loop.snapshot().servers.every((s) => s.state === "reachable")).toBe(true);

    // Both servers miss their probes on the next pass.
    next = NO_ANSWER;
    await vi.advanceTimersByTimeAsync(JOBS_REACHABILITY_INTERVAL_MS);
    const down = loop.snapshot().servers;
    expect(down.every((s) => s.state === "unreachable")).toBe(true);
    expect(down.every((s) => s.unreachableSince !== null)).toBe(true);
    // The last known good instant survives the outage.
    expect(down.every((s) => s.lastReachableAt !== null)).toBe(true);
    // The transition, not every probe, is the log signal: one line per server.
    expect(
      lines.filter((l) => l.fields.event === "edge.jobs_reachability.unreachable"),
    ).toHaveLength(2);

    // One more failing pass adds no new transition lines.
    await vi.advanceTimersByTimeAsync(JOBS_REACHABILITY_INTERVAL_MS);
    expect(
      lines.filter((l) => l.fields.event === "edge.jobs_reachability.unreachable"),
    ).toHaveLength(2);

    // Recovery: the servers answer again, without a restart.
    next = REACHABLE;
    await vi.advanceTimersByTimeAsync(JOBS_REACHABILITY_INTERVAL_MS);
    const back = loop.snapshot().servers;
    expect(back.every((s) => s.state === "reachable")).toBe(true);
    expect(back.every((s) => s.unreachableSince === null)).toBe(true);
    expect(lines.filter((l) => l.fields.event === "edge.jobs_reachability.recovered")).toHaveLength(
      2,
    );
  });

  test("an answer that is not the health contract is unreachable (off_protocol), not reachable", async () => {
    const { loop, lines } = makeLoop({
      probe: async () => ({ outcome: "invalid_response" }),
    });
    loop.start();
    await flush();
    const states = loop.snapshot().servers;
    expect(states.every((s) => s.state === "unreachable")).toBe(true);
    expect(states.every((s) => s.reason === "off_protocol")).toBe(true);
    expect(
      lines.filter((l) => l.fields.event === "edge.jobs_reachability.unreachable"),
    ).toHaveLength(2);
  });

  test("a probe that throws is recorded as no answer, never skipped", async () => {
    const { loop } = makeLoop({
      probe: async () => {
        throw new Error("defect in the probe seam");
      },
    });
    loop.start();
    await flush();
    const states = loop.snapshot().servers;
    expect(states.every((s) => s.state === "unreachable")).toBe(true);
    expect(states.every((s) => s.reason === "no_answer")).toBe(true);
  });

  test("no log line ever carries the endpoint URL or a transport error's text", async () => {
    // The transition events' redaction contract (the same property the span
    // redaction suite pins for spans, at this seam's log channel): the lines
    // name the BOUNDED server id and a classified reason word — never the
    // endpoint (internal topology) and never a transport error's text (the
    // probe classifies endings precisely so nothing raw survives to a log).
    // A probe whose error text and endpoints carry canaries, every event the
    // loop emits across an outage and a recovery captured, and every line
    // scanned whole: the test is non-vacuous (the events did land) and dies
    // if a "helpful" field ever adds either.
    const URL_CANARY = "secret-jobs-host.internal";
    const ERROR_CANARY = "SENSITIVE-TRANSPORT-ERROR-TEXT";
    const { lines, log } = silentLog();
    let failing = true;
    const loop = new JobsReachability({
      servers: [
        { server: "jobs", endpoint: `http://${URL_CANARY}:3003` },
        { server: "jobs-eu", endpoint: `http://${URL_CANARY}-eu:3003` },
      ],
      timeoutMs: 250,
      probe: async () => {
        if (failing) throw new Error(ERROR_CANARY);
        return REACHABLE;
      },
      log,
    });
    loop.start();
    await flush(); // pass 1: both servers' probes throw — the outage transitions
    failing = false;
    await vi.advanceTimersByTimeAsync(JOBS_REACHABILITY_INTERVAL_MS); // pass 2: recovery

    // Non-vacuous: the outage and the recovery both reached the log.
    expect(
      lines.filter((l) => l.fields.event === "edge.jobs_reachability.unreachable"),
    ).toHaveLength(2);
    expect(lines.filter((l) => l.fields.event === "edge.jobs_reachability.recovered")).toHaveLength(
      2,
    );

    for (const line of lines) {
      const rendered = JSON.stringify(line);
      expect(rendered, `${line.fields.event} must not carry the endpoint`).not.toContain(
        URL_CANARY,
      );
      expect(rendered, `${line.fields.event} must not carry the error text`).not.toContain(
        ERROR_CANARY,
      );
      // The transition lines carry no error object at all: the classification
      // word is the contract's carrier.
      expect(line.fields, line.fields.event as string).not.toHaveProperty("err");
    }
    await loop.stop();
  });

  test("servers are probed independently: one down server does not obscure the other", async () => {
    // The second configured endpoint is the one that never answers; its own
    // entry must go down without touching the first's.
    const { loop } = makeLoop({
      probe: async (endpoint) => (endpoint.endsWith("jobs.internal:3003") ? REACHABLE : NO_ANSWER),
    });
    loop.start();
    await flush();
    const states = loop.snapshot().servers;
    expect(states.map((s) => s.state)).toEqual(["reachable", "unreachable"]);
    // The pass itself still completed its measurements.
    expect(loop.snapshot().lastOkPassAt).not.toBeNull();
  });

  test("what the server reported about itself rides the snapshot as evidence", async () => {
    const { loop } = makeLoop({
      probe: async () => ({ outcome: "reachable", reported: "error" }),
    });
    loop.start();
    await flush();
    expect(loop.snapshot().servers.map((s) => s.reported)).toEqual(["error", "error"]);
  });

  test("stop halts the cadence and is terminal; the snapshot reports the stop", async () => {
    const { loop } = makeLoop({ probe: async () => REACHABLE, intervalMs: 1_000 });
    loop.start();
    await flush();
    expect(loop.snapshot().passes).toBe(1);

    await loop.stop();
    expect(loop.snapshot().started).toBe(false);
    const passes = loop.snapshot().passes;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loop.snapshot().passes).toBe(passes);

    // Terminal by design: start after stop relaunches nothing.
    loop.start();
    expect(loop.snapshot().started).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loop.snapshot().passes).toBe(passes);
  });

  test("stop awaits the in-flight pass, so no recording is lost", async () => {
    // One shared deferred for the whole pass — both servers' probes await the
    // same gate, so releasing it settles the pass the way a real server
    // cluster answering would. (Two per-call promises would orphan the first
    // probe's forever.) The holder object rather than a plain captured `let`:
    // TypeScript's control-flow analysis cannot see through the promise
    // executor's callback, and narrows a captured `let` back to its
    // initializer — the call below would read as `never`.
    const gate: { release?: (answer: JobsProbeAnswer) => void } = {};
    const gated = new Promise<JobsProbeAnswer>((resolve) => {
      gate.release = resolve;
    });
    const { loop, lines } = makeLoop({ probe: () => gated });
    loop.start();
    // The first pass is in flight on the gated probe.
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.snapshot().servers[0]?.state).toBe("pending");

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); // the in-flight pass holds the release

    gate.release?.(REACHABLE);
    await stopping;
    expect(stopped).toBe(true);
    // The gated pass's recording landed before stop returned.
    expect(loop.snapshot().servers.every((s) => s.state === "reachable")).toBe(true);
    expect(lines.some((l) => l.fields.event === "edge.jobs_reachability.pass_rejected")).toBe(
      false,
    );
  });

  test("a second start() while running does not double the loop", async () => {
    let probes = 0;
    const { loop } = makeLoop({
      probe: async () => {
        probes += 1;
        return REACHABLE;
      },
      intervalMs: 1_000,
    });
    loop.start();
    loop.start();
    await flush();
    expect(probes).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    // Exactly one cadence: 6 passes × 2 servers.
    expect(probes).toBe(12);
  });

  test("stop before start is safe", async () => {
    const { loop } = makeLoop({ probe: async () => REACHABLE });
    await loop.stop();
    expect(loop.snapshot().started).toBe(false);
  });

  test("a returned snapshot is a copy — a consumer's mutation cannot corrupt the observation", () => {
    // snapshot() hands a reference to every /health request's grader and any
    // other consumer; its defensive copy is the only thing between a
    // mutating caller and the loop's own state. The array is readonly by
    // type, but the entries are not Readonly objects — a consumer rewriting
    // a server's state (which the type system allows) must not turn the
    // loop's pending observation into whatever the consumer preferred.
    const { loop } = makeLoop({ probe: async () => REACHABLE });
    const held = loop.snapshot();
    const first = held.servers[0];
    if (!first) throw new Error("the fixture's servers vanished");
    first.state = "reachable";
    first.reported = "ok";

    const fresh = loop.snapshot();
    expect(fresh.servers.map((s) => s.state)).toEqual(["pending", "pending"]);
    expect(fresh.servers.map((s) => s.reported)).toEqual([null, null]);
    // The premise: the consumer's copy really was mutated.
    expect(first.state).toBe("reachable");
  });
});

/**
 * The grading table for `jobs_reachability` — pure function, table-tested
 * without a loop. The load-bearing rule: missing or stale evidence never
 * reports ok.
 */
describe("jobsReachabilityCheck", () => {
  const NOW = Date.parse("2026-10-18T12:00:00.000Z");

  function snapshot(fields: Partial<JobsReachabilitySnapshot>): JobsReachabilitySnapshot {
    return {
      started: true,
      passes: 4,
      lastPassAt: new Date(NOW - 5_000).toISOString(),
      lastOkPassAt: new Date(NOW - 5_000).toISOString(),
      servers: SERVERS.map(({ server }) => ({
        server,
        state: "reachable",
        reported: "ok",
        lastReachableAt: new Date(NOW - 5_000).toISOString(),
        unreachableSince: null,
        reason: null,
      })),
      ...fields,
    };
  }

  test("all servers reachable reads ok, with the per-server counts as metrics", () => {
    const check = jobsReachabilityCheck(snapshot({}), { nowMs: NOW });
    expect(check.name).toBe(JOBS_REACHABILITY_CHECK);
    expect(check.status).toBe("ok");
    expect(check.lastSuccessAt).toBe(snapshot({}).lastOkPassAt);
    expect(check.metrics).toEqual({ passes: 4, servers: 2, reachable: 2, unreachable: 0 });
    expect(check.detail).toBeUndefined();
  });

  test("a loop that is not running reads error — unobserved servers are not health", () => {
    const check = jobsReachabilityCheck(snapshot({ started: false }), { nowMs: NOW });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/not running/);
  });

  test("a loop with no completed pass reads error", () => {
    const check = jobsReachabilityCheck(
      snapshot({
        lastOkPassAt: null,
        servers: snapshot({}).servers.map((s) => ({
          ...s,
          state: "pending" as const,
          reported: null,
          lastReachableAt: null,
        })),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no successful pass/);
  });

  test("a running loop that has settled no pass at all reads error, with no age to show", () => {
    // started, first pass still in flight: lastPassAt is null too, so the
    // detail cannot name an age — the never-ran reading stays distinct from
    // "ran but the pass failed" (which renders its last pass's age).
    const check = jobsReachabilityCheck(
      snapshot({ passes: 1, lastPassAt: null, lastOkPassAt: null }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no successful pass/);
    expect(check.detail).not.toMatch(/last pass was/);
  });

  test("a pass at exactly the staleness bound still reads ok — degradation begins after it", () => {
    const check = jobsReachabilityCheck(
      snapshot({ lastOkPassAt: new Date(NOW - JOBS_REACHABILITY_STALE_AFTER_MS).toISOString() }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("ok");
  });

  test("a stale observation degrades — stale evidence never reads ok", () => {
    const check = jobsReachabilityCheck(
      snapshot({
        lastOkPassAt: new Date(NOW - JOBS_REACHABILITY_STALE_AFTER_MS - 1).toISOString(),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toMatch(/stale/);
  });

  test("a fresh observation sits just inside the staleness bound", () => {
    const check = jobsReachabilityCheck(
      snapshot({
        lastOkPassAt: new Date(NOW - JOBS_REACHABILITY_STALE_AFTER_MS + 1_000).toISOString(),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("ok");
  });

  test("a server still pending after a fresh pass is refused as error", () => {
    const check = jobsReachabilityCheck(
      snapshot({
        servers: snapshot({}).servers.map((s, i) =>
          i === 0 ? { ...s, state: "pending" as const, reported: null } : s,
        ),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/never answered/);
  });

  test("several pending servers are named together — joined, and reading as a plural", () => {
    // The pending arm renders every unobserved server in one line: the join
    // and the verb must both survive an edit (the operator reads "a, b have
    // never answered" as one finding naming both, not as prose about one).
    const check = jobsReachabilityCheck(
      snapshot({
        servers: snapshot({}).servers.map((s) => ({
          ...s,
          state: "pending" as const,
          reported: null,
        })),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("error");
    expect(check.detail).toContain("jobs, jobs-eu have never answered");
  });

  test("some servers unreachable degrades, naming each one, its age and its reason", () => {
    const check = jobsReachabilityCheck(
      snapshot({
        servers: snapshot({}).servers.map((s, i) =>
          i === 1
            ? {
                ...s,
                state: "unreachable" as const,
                reason: "no_answer",
                unreachableSince: new Date(NOW - 45_000).toISOString(),
              }
            : s,
        ),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("jobs-eu");
    expect(check.detail).toContain("45s");
    expect(check.detail).toContain("no_answer");
    // The last-known-good anchor rides the down evidence: this server HAD
    // answered (the fixture stamps its instant), and the detail says when.
    expect(check.detail).toContain("last answered");
    expect(check.metrics).toEqual({ passes: 4, servers: 2, reachable: 1, unreachable: 1 });
  });

  test("a down server that never answered reads differently from one that died", () => {
    // A server whose FIRST probe failed went pending → unreachable with no
    // last-known-good instant: the detail must distinguish "down since boot"
    // from "died recently" — the operator's first question either way.
    const check = jobsReachabilityCheck(
      snapshot({
        servers: snapshot({}).servers.map((s, i) =>
          i === 1
            ? {
                ...s,
                state: "unreachable" as const,
                reason: "no_answer",
                unreachableSince: new Date(NOW - 45_000).toISOString(),
                lastReachableAt: null,
              }
            : s,
        ),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("never answered");
    expect(check.detail).not.toContain("last answered");
  });

  test("a corrupted instant degrades the wording, it never throws — the check's own contract", () => {
    // The null defences in downSince are snapshot-corruption guards; the same
    // corruption taken one step further — an instant that is present but not
    // a date — must degrade the same way. The check's contract is never to
    // throw: its output lands in the /health body, whose handler builds the
    // check list unguarded, so a throw here is a 500 — the always-200
    // contract broken by the check meant to report the outage.
    const check = jobsReachabilityCheck(
      snapshot({
        servers: snapshot({}).servers.map((s, i) =>
          i === 1
            ? {
                ...s,
                state: "unreachable" as const,
                reason: "no_answer",
                unreachableSince: new Date(NOW - 45_000).toISOString(),
                lastReachableAt: "not-a-date",
              }
            : s,
        ),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("degraded");
    expect(check.detail).toContain("jobs-eu");
  });

  test("every corrupted-instant shape degrades the wording — no NaNs, no throw, the renderings pinned", () => {
    // The attack leg pins the never-throw property; the ticket's fix names
    // four degrade renderings, and a regression to the old `NaNs` detail —
    // the corruption half-handled — would pass a leg that only names the
    // server. Each branch of the wording contract, through the public
    // grader: a malformed since-instant drops the age; a malformed
    // last-answered instant says so in words; a future one clamps to 0s
    // (Math.max's branch); the loop's own null state renders as it always
    // did. A throw on any of these fails the test outright — the always-200
    // contract is the point.
    const corrupted = (fields: Partial<JobsReachabilitySnapshot["servers"][number]>) =>
      snapshot({
        servers: snapshot({}).servers.map((s, i) =>
          i === 1 ? { ...s, state: "unreachable" as const, reason: "no_answer", ...fields } : s,
        ),
      });

    // A malformed since-instant: the age is dropped, never rendered as NaN.
    const badSince = jobsReachabilityCheck(
      corrupted({ unreachableSince: "not-a-date", lastReachableAt: new Date(NOW).toISOString() }),
      { nowMs: NOW },
    );
    expect(badSince.status).toBe("degraded");
    expect(badSince.detail).toContain("jobs-eu (no_answer)");
    expect(badSince.detail).not.toContain("NaN");

    // The loop's own null state (no episode recorded) reads the same shape.
    const nullSince = jobsReachabilityCheck(corrupted({ unreachableSince: null }), { nowMs: NOW });
    expect(nullSince.status).toBe("degraded");
    expect(nullSince.detail).toContain("jobs-eu (no_answer)");

    // A malformed last-answered instant: named in words, the age kept.
    const badAnchor = jobsReachabilityCheck(
      corrupted({
        unreachableSince: new Date(NOW - 45_000).toISOString(),
        lastReachableAt: "not-a-date",
      }),
      { nowMs: NOW },
    );
    expect(badAnchor.status).toBe("degraded");
    expect(badAnchor.detail).toContain(
      "jobs-eu (no_answer, 45s, an unreadable last-answered instant)",
    );

    // A future since-instant (clock corruption): the age clamps to 0s.
    const futureSince = jobsReachabilityCheck(
      corrupted({
        unreachableSince: new Date(NOW + 60_000).toISOString(),
        lastReachableAt: new Date(NOW).toISOString(),
      }),
      { nowMs: NOW },
    );
    expect(futureSince.status).toBe("degraded");
    expect(futureSince.detail).toContain("jobs-eu (no_answer, 0s, last answered");
  });

  test("every server unreachable errors — the whole configured jobs plane refuses this edge", () => {
    const check = jobsReachabilityCheck(
      snapshot({
        servers: snapshot({}).servers.map((s) => ({
          ...s,
          state: "unreachable" as const,
          reason: "off_protocol",
          unreachableSince: new Date(NOW - 90_000).toISOString(),
        })),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/every configured jobs server is unreachable/);
  });

  test("a reachable server's self-reported degradation is evidence in the detail, not the grade", () => {
    // The jobs service's own body is authoritative for its internal state;
    // this check speaks for reachability. The join rides the detail so an
    // operator reading one body still sees it.
    const check = jobsReachabilityCheck(
      snapshot({
        servers: snapshot({}).servers.map((s) => ({ ...s, reported: "degraded" as const })),
      }),
      { nowMs: NOW },
    );
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("jobs reports degraded");
    expect(check.detail).toContain("jobs-eu reports degraded");
  });

  test("a wired check with no servers is a wiring defect, refused as error", () => {
    const check = jobsReachabilityCheck(snapshot({ servers: [] }), { nowMs: NOW });
    expect(check.status).toBe("error");
    expect(check.detail).toMatch(/no jobs servers/);
  });
});

describe("the probe counter", () => {
  let recording: RecordingTelemetry;

  beforeEach(() => {
    recording = startRecordingTelemetry();
  });

  afterEach(async () => {
    await recording.restore();
  });

  test("every probe is counted by its bounded outcome — one point per server per pass", async () => {
    // Real timers at a trivial cadence: what this pins is the counting and
    // the bounded dimensions, not the scheduling (pinned above on fake
    // timers). The second server answers off-protocol every pass; the first
    // answers reachable once and then no_answer — so the three vocabulary
    // words all land, whatever a polling race does to the pass count.
    const INVALID: JobsProbeAnswer = { outcome: "invalid_response" };
    let jobsAnswer: JobsProbeAnswer = REACHABLE;
    const { log } = silentLog();
    const loop = new JobsReachability({
      servers: SERVERS,
      intervalMs: 10,
      timeoutMs: 250,
      probe: async (endpoint) => (endpoint.endsWith("jobs.internal:3003") ? jobsAnswer : INVALID),
      log,
    });
    try {
      loop.start();
      const settledBy = Date.now() + 5_000;
      while (Date.now() < settledBy && loop.snapshot().passes < 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      jobsAnswer = NO_ANSWER;
      while (Date.now() < settledBy && loop.snapshot().passes < 2) {
        await new Promise((r) => setTimeout(r, 5));
      }
      await loop.stop();
      expect(loop.snapshot().passes).toBeGreaterThanOrEqual(2);

      const passes = loop.snapshot().passes;
      const points = await recording.metrics();
      const probes = points.filter((p) => p.name === INSTR_JOBS_REACHABILITY_PROBES);
      const byOutcome = new Map(probes.map((p) => [p.attributes[ATTR_OUTCOME], p.value]));
      // One reachable answer (the first pass), one invalid_response per pass,
      // one no_answer per pass after the first — the counts of a loop the
      // stop() released mid-nothing.
      expect(byOutcome.get("reachable")).toBe(1);
      expect(byOutcome.get("invalid_response")).toBe(passes);
      expect(byOutcome.get("unreachable")).toBe(passes - 1);
      expect(byOutcome.size).toBe(3);
      // Bounded, non-personal dimensions: the outcome, nothing else — no
      // endpoint URL, no server name, no transport error text.
      for (const point of probes) {
        expect(Object.keys(point.attributes)).toEqual([ATTR_OUTCOME]);
      }
    } finally {
      await loop.stop();
    }
  });
});

/**
 * A reporting sink that throws (a broken log transport) — the class the
 * storage supervisor's own suite pins for its loop. The loop's answer is the
 * same shape: the failed measurement stays unrecorded and freshness ages it,
 * the pass reports its failure, the cadence never stops for it, and nothing
 * escapes as an unhandled rejection.
 */
describe("a reporting sink that throws", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  function sinkThatThrowsOn(
    throwing: "warn" | "error",
    lines: CapturedLine[],
  ): JobsReachabilityLogger {
    const record =
      (level: "info" | "warn" | "error") => (fields: Record<string, unknown>, msg: string) =>
        lines.push({ level, fields, msg });
    return {
      info: record("info"),
      warn: (fields, msg) => {
        if (throwing === "warn") throw new Error("the reporting sink is down");
        record("warn")(fields, msg);
      },
      error: (fields, msg) => {
        if (throwing === "error") throw new Error("the reporting sink is down");
        record("error")(fields, msg);
      },
    };
  }

  test("a transition whose report threw stays unrecorded, the pass reports failed, and the cadence continues", async () => {
    const lines: CapturedLine[] = [];
    let next: JobsProbeAnswer = REACHABLE;
    const loop = new JobsReachability({
      servers: SERVERS,
      timeoutMs: 250,
      probe: async () => next,
      log: sinkThatThrowsOn("warn", lines),
    });
    loop.start();
    await flush();
    expect(loop.snapshot().passes).toBe(1);
    const okAt = loop.snapshot().lastOkPassAt;
    expect(okAt).not.toBeNull();

    // The next pass's first failure reports through warn — which throws, so
    // the pass's bookkeeping dies mid-recording.
    next = NO_ANSWER;
    await vi.advanceTimersByTimeAsync(JOBS_REACHABILITY_INTERVAL_MS);
    const after = loop.snapshot();
    expect(after.passes).toBe(2);
    // The measurement whose report threw is unrecorded: the evidence stays
    // where it was, and the freshness skeleton — not the snapshot — ages it.
    expect(after.servers.map((s) => s.state)).toEqual(["reachable", "reachable"]);
    expect(after.lastOkPassAt).toBe(okAt); // a failed pass never reads as success
    expect(after.lastPassAt).not.toBe(okAt); // the pass itself was observed to run
    expect(
      lines.filter((l) => l.fields.event === "edge.jobs_reachability.pass_failed"),
    ).toHaveLength(1);

    // The cadence survived its own reporting's death.
    await vi.advanceTimersByTimeAsync(JOBS_REACHABILITY_INTERVAL_MS);
    expect(loop.snapshot().passes).toBe(3);
    await loop.stop();
  });

  test("stop releases through an in-flight pass whose reporting threw — the release chain survives", async () => {
    const lines: CapturedLine[] = [];
    const gate: { release?: (answer: JobsProbeAnswer) => void } = {};
    const gated = new Promise<JobsProbeAnswer>((resolve) => {
      gate.release = resolve;
    });
    const loop = new JobsReachability({
      servers: SERVERS,
      timeoutMs: 250,
      probe: () => gated,
      log: sinkThatThrowsOn("warn", lines),
    });
    loop.start();
    await flush(); // the first pass is in flight on the gated probe

    const stopping = loop.stop();
    gate.release?.(NO_ANSWER); // the pass ends; its transition report throws
    await expect(stopping).resolves.toBeUndefined();
    expect(loop.snapshot().started).toBe(false);
    // The failed pass never reads as success, and its failure was reported.
    expect(loop.snapshot().lastOkPassAt).toBeNull();
    expect(loop.snapshot().passes).toBe(1);
    expect(
      lines.filter((l) => l.fields.event === "edge.jobs_reachability.pass_failed"),
    ).toHaveLength(1);
  });

  test("a fully dead reporting sink is never an unhandled rejection and never stops the cadence", async () => {
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const dead: JobsReachabilityLogger = {
      info: () => {
        throw new Error("the reporting sink is down");
      },
      warn: () => {
        throw new Error("the reporting sink is down");
      },
      error: () => {
        throw new Error("the reporting sink is down");
      },
    };
    const loop = new JobsReachability({
      servers: SERVERS,
      timeoutMs: 250,
      probe: async () => NO_ANSWER,
      log: dead,
    });
    try {
      loop.start();
      await flush();
      await vi.advanceTimersByTimeAsync(JOBS_REACHABILITY_INTERVAL_MS);
      expect(loop.snapshot().passes).toBe(2); // the cadence survived
      expect(captured).toEqual([]); // nothing escaped as an unhandled rejection
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await loop.stop();
    }
  });
});
