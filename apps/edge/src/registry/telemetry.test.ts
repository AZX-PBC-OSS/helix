import { afterEach, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  INSTR_REGISTRY_LOAD_FAILURES,
  INSTR_REGISTRY_STALE_FOR_MS,
} from "@azx-pbc/shared/telemetry";
import { LiveRegistry, type RegistryLogger } from "./listener.js";

/**
 * The metrics half of ADR-0025's serve-stale reporting.
 *
 * This is what `TODO.md`'s open item needs: the signals have existed since
 * ADR-0025 but only as log events, so the alert "keeps not getting built"
 * because building it means KQL string-matching over log messages. A gauge and
 * a counter make it one threshold rule.
 */

/** A DSN that cannot resolve, so every load fails without waiting on a timeout. */
const UNREACHABLE_DSN = "postgresql://helix:helix@127.0.0.1:1/helix";

const silentLog: RegistryLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let recording: RecordingTelemetry | null = null;

afterEach(async () => {
  await recording?.restore();
  recording = null;
});

/** Let the reconcile chain tick a few times. */
function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("registry telemetry", () => {
  it("counts a cold start as never_loaded, not as an ordinary failure", async () => {
    recording = startRecordingTelemetry();
    const registry = new LiveRegistry({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log: silentLog,
    });
    try {
      await registry.start();

      const points = await recording.metrics();
      const failures = points.filter((p) => p.name === INSTR_REGISTRY_LOAD_FAILURES);
      expect(failures.length).toBeGreaterThan(0);
      // The split matters: "never loaded" means every app host is serving 503,
      // which is a different page from "serving a stale copy".
      for (const point of failures) {
        expect(point.attributes["helix.outcome"]).toBe("never_loaded");
      }
    } finally {
      await registry.stop();
    }
  });

  it("reports NO staleness gauge before the first successful load", async () => {
    // A gauge reading 0 here would say "perfectly fresh" when the truth is that
    // nothing has ever loaded and every app host is 503ing — the worst possible
    // direction to be wrong in. Absence is the honest answer; the counter above
    // is what carries the signal.
    recording = startRecordingTelemetry();
    const registry = new LiveRegistry({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log: silentLog,
    });
    try {
      await registry.start();
      await settle(50);

      const points = await recording.metrics();
      expect(points.filter((p) => p.name === INSTR_REGISTRY_STALE_FOR_MS)).toHaveLength(0);
    } finally {
      await registry.stop();
    }
  });

  it("keeps counting while loads keep failing, so a rule can see a streak", async () => {
    recording = startRecordingTelemetry();
    const registry = new LiveRegistry({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log: silentLog,
    });
    try {
      await registry.start();

      const failureTotal = async (): Promise<number> => {
        const points = await recording!.metrics();
        return points
          .filter((p) => p.name === INSTR_REGISTRY_LOAD_FAILURES)
          .reduce((sum, p) => sum + p.value, 0);
      };
      let total = 0;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && total <= 1) {
        await new Promise((r) => setTimeout(r, 10));
        total = await failureTotal();
      }
      // Cumulative, so a rule can alert on a streak rather than a single blip.
      expect(total).toBeGreaterThan(1);
    } finally {
      await registry.stop();
    }
  });

  it("detaches the gauge callback on stop, so a torn-down registry is not observed", async () => {
    // A callback left attached keeps the instance (and its pool-backed
    // projection) alive on the meter provider, and would be invoked on every
    // later collection.
    recording = startRecordingTelemetry();
    const registry = new LiveRegistry({
      databaseUrl: UNREACHABLE_DSN,
      reconcileIntervalMs: 1,
      log: silentLog,
    });
    await registry.start();
    await registry.stop();

    // Collecting after stop must not throw and must not produce a gauge point.
    const points = await recording.metrics();
    expect(points.filter((p) => p.name === INSTR_REGISTRY_STALE_FOR_MS)).toHaveLength(0);
  });
});
