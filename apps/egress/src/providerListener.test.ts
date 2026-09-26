import { afterEach, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  INSTR_PROVIDERS_LISTEN_STATUS,
  INSTR_PROVIDERS_RECONCILES,
} from "@azx-pbc/shared/telemetry";

import { jitteredDelayMs, LiveProviders, type ProvidersLogger } from "./providerListener.js";

/**
 * The listener's failure posture, driven against a DSN that can't connect
 * (port 1 → ECONNREFUSED, fast and deterministic): the cold-start shape where
 * every load and every connect fails. The happy-path timer chain rides the
 * real trigger → NOTIFY → reload loop in providers.integration.test.ts, and
 * the metric assertions here are what ADR-0037's "telemetry ships with the
 * change" rule pins for this new background loop.
 */
const UNREACHABLE_DSN = "postgresql://helix:helix@127.0.0.1:1/helix";

interface Line {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

function recorder(): { lines: Line[]; log: ProvidersLogger } {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (fields, msg) => lines.push({ level: "info", fields, msg }),
      warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
      error: (fields, msg) => lines.push({ level: "error", fields, msg }),
    },
  };
}

const eventsOf = (lines: Line[], event: string): Line[] =>
  lines.filter((l) => l.fields.event === event);

/** Poll until `predicate` holds or the budget runs out. */
async function eventually(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("jitteredDelayMs", () => {
  it("spreads the delay ±20% across the random range", () => {
    expect(jitteredDelayMs(60_000, () => 0)).toBe(48_000); // 0.8×
    expect(jitteredDelayMs(60_000, () => 0.5)).toBe(60_000); // 1.0×
    expect(jitteredDelayMs(60_000, () => 1)).toBe(72_000); // 1.2×
  });

  it("falls back to a sane interval rather than hot-looping on an unusable input", () => {
    // `Math.max(0, NaN)` is `NaN`, which `setTimeout` coerces to ~0 ms — a hot
    // reconcile loop on every replica, the opposite of what this is for. The
    // config layer rejects such a value at boot; this is the belt-and-braces half.
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const delay = jitteredDelayMs(bad, () => 0.5);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(60_000);
    }
  });

  it("never returns a negative or non-finite delay", () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      for (const base of [1, 500, 60_000, Number.NaN, -1]) {
        const delay = jitteredDelayMs(base, random);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("LiveProviders against a DB it can never reach", () => {
  it("keeps trying to reconnect with backoff instead of dying quietly", async () => {
    const { lines, log } = recorder();
    const listener = new LiveProviders({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log,
    });
    try {
      // Boot never hangs on a down DB — the retry machinery takes over.
      await listener.start();
      expect(listener.isLoaded()).toBe(false);

      // The first failure is the error-level line, and it says what it means
      // for callers: provider lookups fail closed.
      await eventually(() => eventsOf(lines, "providers.load_failed").length >= 1);
      const first = eventsOf(lines, "providers.load_failed")[0];
      expect(first?.level).toBe("error");
      expect(first?.msg).toContain("fail closed");

      // The LISTEN connect fails too, and reconnects on a backoff — observable,
      // recurring, never a crash and never a silent dead listener.
      await eventually(() => eventsOf(lines, "providers.listen_down").length >= 3, 6000);
      for (const line of eventsOf(lines, "providers.listen_down")) {
        expect(line.level).toBe("warn");
        expect(line.fields.err).toBeDefined();
        expect(line.fields.delayMs).toBeGreaterThanOrEqual(0);
      }
      // Backoff doubles across attempts (jittered, so within the ±20% band).
      const delays = eventsOf(lines, "providers.listen_down").map((l) => l.fields.delayMs);
      expect(delays[1] as number).toBeGreaterThan(delays[0] as number);
    } finally {
      await listener.stop();
    }
  });

  it("stays silent about failures caused by its own shutdown", async () => {
    const { lines, log } = recorder();
    const listener = new LiveProviders({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log,
    });
    await listener.start();
    await eventually(() => eventsOf(lines, "providers.load_failed").length >= 2);

    await listener.stop();
    const after = lines.length;
    // A load in flight when the pool ended, and the reconnect timer's next
    // attempt, both fail against a torn-down listener. Reporting that would
    // emit the error-level first-failure line on every graceful shutdown.
    await eventually(() => false, 300);
    expect(lines.slice(after)).toEqual([]);
  });
});

describe("provider listener telemetry", () => {
  let recording: RecordingTelemetry | null = null;

  afterEach(async () => {
    await recording?.restore();
    recording = null;
  });

  it("counts failed reconciles and reports the listener as down", async () => {
    recording = startRecordingTelemetry();
    const { lines, log } = recorder();
    const listener = new LiveProviders({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log,
    });
    try {
      await listener.start();
      await eventually(() => eventsOf(lines, "providers.listen_down").length >= 1);

      const points = await recording.metrics();
      const reconciles = points.filter((p) => p.name === INSTR_PROVIDERS_RECONCILES);
      expect(reconciles.length).toBeGreaterThan(0);
      // Bounded, non-personal dimensions: outcome only.
      for (const point of reconciles) {
        expect(Object.keys(point.attributes)).toEqual(["helix.outcome"]);
        expect(point.attributes["helix.outcome"]).toBe("failed");
      }

      // The gauge reads 0 — the listener is genuinely down, and pretending
      // otherwise is the one direction a status gauge must not lie in.
      const status = points.filter((p) => p.name === INSTR_PROVIDERS_LISTEN_STATUS);
      expect(status.length).toBeGreaterThan(0);
      for (const point of status) {
        expect(point.value).toBe(0);
        expect(point.attributes).toEqual({});
      }
    } finally {
      await listener.stop();
    }
  });

  it("detaches the gauge callback on stop, so a torn-down listener is not observed", async () => {
    recording = startRecordingTelemetry();
    const { log } = recorder();
    const listener = new LiveProviders({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log,
    });
    await listener.start();
    await listener.stop();

    // Collecting after stop must not throw and must not produce a gauge point.
    const points = await recording.metrics();
    expect(points.filter((p) => p.name === INSTR_PROVIDERS_LISTEN_STATUS)).toHaveLength(0);
  });
});
