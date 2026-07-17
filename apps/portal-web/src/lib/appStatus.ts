import type { App, Version } from "@azx-pbc/shared";
import type { StatusKind } from "../components/primitives";

/** Derive the card/header status from registry truth. */
export function appStatus(app: App, versions?: Version[]): StatusKind {
  if (app.archivedAt) return "archived";
  if (app.currentVersionId) return "live";
  if (versions?.some((v) => v.status === "preview")) return "preview";
  return "empty";
}

export function liveVersion(app: App, versions: Version[]): Version | undefined {
  return versions.find((v) => v.id === app.currentVersionId);
}

/** Preview versions newer than live — the "awaiting promote" signal (§5.1). */
export function awaitingPromote(app: App, versions: Version[]): Version | undefined {
  const live = liveVersion(app, versions);
  return versions.find(
    (v) => v.status === "preview" && (live === undefined || v.number > live.number),
  );
}

/**
 * Deploy cadence: version timestamps bucketed into `buckets` intervals from
 * first deploy to now — a real sparkline with no metering API.
 */
export function deployCadence(versions: Version[], buckets = 16): number[] {
  const out = new Array<number>(buckets).fill(0);
  if (versions.length === 0) return out;
  const times = versions.map((v) => new Date(v.createdAt).getTime());
  const start = Math.min(...times);
  const span = Math.max(Date.now() - start, 1);
  for (const t of times) {
    const i = Math.min(Math.floor(((t - start) / span) * buckets), buckets - 1);
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}
