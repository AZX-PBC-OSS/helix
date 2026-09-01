import { afterEach, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  INSTR_SESSION_GATE_DENIED,
  SESSION_DENIAL_REASONS,
  type SessionDenialReason,
} from "@azx-pbc/shared/telemetry";

/**
 * `helix.session.gate_denied` (ADR-0037 decision 8).
 *
 * Two properties matter, and neither is "the counter increments":
 *  - the `reason` dimension stays **bounded**, because an unbounded metric label
 *    multiplies every time series;
 *  - counting a denial changes **nothing** a caller can observe. `errors.ts`'s
 *    senders are deliberately indistinguishable so a guard doesn't disclose
 *    which one fired, and a metric must not become the side channel that undoes
 *    that. The response-shape half is covered by the existing `gate.test.ts`
 *    and `adversarial.test.ts` suites, which this must not change.
 */

let recording: RecordingTelemetry | null = null;

afterEach(async () => {
  await recording?.restore();
  recording = null;
});

describe("the session-gate denial counter", () => {
  it("uses only reasons from the declared set", async () => {
    // The set is the contract an alert rule and a dashboard split on. A reason
    // invented at a call site would create a series nothing queries.
    const { instruments } = await import("../telemetry.js");
    recording = startRecordingTelemetry();

    for (const reason of SESSION_DENIAL_REASONS) {
      instruments().sessionGateDenied.add(1, { "helix.reason": reason });
    }

    const points = (await recording.metrics()).filter((p) => p.name === INSTR_SESSION_GATE_DENIED);
    expect(points).toHaveLength(SESSION_DENIAL_REASONS.length);
    for (const point of points) {
      expect(SESSION_DENIAL_REASONS).toContain(
        point.attributes["helix.reason"] as SessionDenialReason,
      );
    }
  });

  it("carries no per-user or per-app dimension", async () => {
    // `userOid` is unbounded AND personal data; it belongs in the ledger, never
    // on a metric label (ADR-0037 decision 8). `appId` is bounded but is not
    // worth the multiplication here — the gate fires before authorization, and
    // the question a denial answers is "which guard, how often".
    const { instruments } = await import("../telemetry.js");
    recording = startRecordingTelemetry();
    instruments().sessionGateDenied.add(1, { "helix.reason": "no_session" });

    const points = (await recording.metrics()).filter((p) => p.name === INSTR_SESSION_GATE_DENIED);
    for (const point of points) {
      expect(Object.keys(point.attributes)).toEqual(["helix.reason"]);
    }
  });

  it("keeps the reason set small enough to be a metric label", () => {
    expect(SESSION_DENIAL_REASONS.length).toBeLessThanOrEqual(8);
  });
});
