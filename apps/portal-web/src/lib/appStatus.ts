import type { App, AppListItem, Version } from "@azx-pbc/shared";
import type { StatusKind } from "../components/primitives";

/**
 * What a screen needs to know about an app's deploys, independent of where it
 * learned it.
 *
 * Two surfaces ask the same questions from different data: the apps table reads
 * aggregates the list endpoint rolled up (`AppListItem`), while an app's own page
 * has already fetched its full version list. Normalising both into this shape is
 * what keeps one status derivation instead of two — the previous split is why the
 * registry table, which had no version rows to consult, reported an app with a
 * preview waiting as if it had never been deployed.
 */
export interface DeployFacts {
  /** ISO timestamp of the newest version; null before the first deploy. */
  lastDeployAt: string | null;
  /** `number` of the version being served; null before the first promote. */
  liveNumber: number | null;
  /** Highest `preview`-status version; null when none exists. */
  latestPreviewNumber: number | null;
}

const EMPTY: DeployFacts = {
  lastDeployAt: null,
  liveNumber: null,
  latestPreviewNumber: null,
};

function isListItem(app: App | AppListItem): app is AppListItem {
  return "latestPreviewNumber" in app;
}

/**
 * Read deploy facts off whichever source the caller has. Pass `versions` when the
 * screen already fetched them; otherwise a list item's projected fields are used.
 * A plain `App` with neither yields zeroes — "nothing deployed", which is also
 * how it renders.
 */
export function deployFacts(app: App | AppListItem, versions?: Version[]): DeployFacts {
  if (versions) {
    const live = versions.find((v) => v.id === app.currentVersionId);
    const previews = versions.filter((v) => v.status === "preview").map((v) => v.number);
    const times = versions.map((v) => v.createdAt).sort();
    return {
      lastDeployAt: times.at(-1) ?? null,
      liveNumber: live?.number ?? null,
      latestPreviewNumber: previews.length > 0 ? Math.max(...previews) : null,
    };
  }
  if (isListItem(app)) {
    return {
      lastDeployAt: app.lastDeployAt,
      liveNumber: app.liveVersionNumber,
      latestPreviewNumber: app.latestPreviewNumber,
    };
  }
  return EMPTY;
}

/** Derive the row/header status from registry truth plus deploy facts. */
export function appStatus(app: App | AppListItem, facts?: DeployFacts): StatusKind {
  if (app.archivedAt) return "archived";
  if (app.currentVersionId) return "live";
  if ((facts ?? deployFacts(app)).latestPreviewNumber !== null) return "preview";
  return "empty";
}

/**
 * The "awaiting promote" signal (§5.1): a preview version newer than what is
 * live — including the case where nothing is live yet. Null when there is
 * nothing to promote.
 */
export function awaitingPromoteNumber(facts: DeployFacts): number | null {
  const { latestPreviewNumber: preview, liveNumber: live } = facts;
  if (preview === null) return null;
  return live === null || preview > live ? preview : null;
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
