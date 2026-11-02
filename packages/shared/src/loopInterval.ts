/**
 * The lowest cadence a background loop may be configured to. Below it a loop
 * is a busy-poll against its store or peer.
 */
export const MIN_LOOP_INTERVAL_MS = 100;

/**
 * Resolve an optional override of a background loop's steady cadence.
 *
 * An override may only shorten the cadence, never lengthen it. The platform's
 * time bounds (the 48-hour removal bound, the 60-second delivery-overdue
 * bound, every three-cadence stale threshold) are stated against the default
 * cadence, so a slower loop would quietly break them. The intended use is the
 * real-stack test harness, which runs the services' real loops at a test
 * cadence instead of waiting out production timers.
 *
 * Absent or blank means the default. Anything else that is not an integer
 * between {@link MIN_LOOP_INTERVAL_MS} and `defaultMs` is a boot error naming
 * the variable.
 */
export function resolveLoopIntervalMs(
  raw: string | undefined,
  defaultMs: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_LOOP_INTERVAL_MS || value > defaultMs) {
    throw new Error(
      `${name} must be an integer number of milliseconds from ${MIN_LOOP_INTERVAL_MS} to ` +
        `${defaultMs} (the default cadence) — got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
