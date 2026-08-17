import yauzl from "yauzl";
import { type BundleEntry, type BundlePlan, planBundle } from "@azx-pbc/shared/bundlePlan";
import { MAX_ENTRIES } from "./limits.js";

/**
 * Turn a rejected upload into a whole-archive diagnosis (ADR-0038 decision 9).
 *
 * `validateBundle` fails fast on the first offending entry, so its message often
 * names a macOS sidecar the user never created. This runs **only on the failure
 * path**: it re-reads the spooled zip's central directory — names and declared
 * sizes, never inflating a byte, so no decompression-bomb exposure — hands the
 * layout to the shared planner, and phrases what the archive actually is and
 * where its build appears to be.
 *
 * Advisory only. It never changes what is accepted or rejected, and any failure
 * to read the archive leaves the original error message in place.
 */
export async function diagnoseBundle(
  zipPath: string,
): Promise<{ message: string; details: unknown } | undefined> {
  let entries: BundleEntry[];
  try {
    entries = await collectEntries(zipPath);
  } catch {
    return undefined; // unreadable as a zip — let the original message stand
  }
  if (entries.length === 0) return undefined;

  // No htmlText and no declaredDir: the server hasn't inflated anything, so the
  // reference lint contributes nothing here — root detection still works.
  const plan = planBundle(entries);
  const message = phrase(plan);
  if (!message) return undefined;
  return { message, details: { salvage: summarize(plan) } };
}

/** Enumerate regular-file entries (name + declared uncompressed size), no inflation. */
function collectEntries(zipPath: string): Promise<BundleEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("could not open bundle as a zip archive"));
        return;
      }
      const entries: BundleEntry[] = [];
      zipfile.on("entry", (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith("/")) {
          entries.push({ path: entry.fileName, bytes: entry.uncompressedSize });
        }
        // Bound the work on the failure path (ADR-0038 #1): a rejected zip can
        // carry far more entries than a valid bundle, and enumeration + planning
        // must not become an event-loop DoS. Stop once we're past the deploy cap;
        // the diagnosis of an over-cap archive is already "too many files".
        if (entries.length >= MAX_ENTRIES) {
          resolve(entries);
          zipfile.close();
          return;
        }
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

/** A one-line, human diagnosis — or undefined when the planner has nothing to add. */
function phrase(plan: BundlePlan): string | undefined {
  const junk = plan.drops.filter((d) => d.reason === "junk").length;
  const junkTail = junk > 0 ? ` (plus ${junk} macOS/OS junk file${junk === 1 ? "" : "s"})` : "";

  switch (plan.outcome) {
    case "unsalvageable":
      return (
        "This upload has no index.html anywhere, so there's no page to serve. " +
        "Build your app first, then upload the contents of the build output (usually dist/)."
      );
    case "ambiguous": {
      const roots = plan.candidates
        .slice(0, 3)
        .map((c) => c.root || "the archive root")
        .join(", ");
      return (
        `We couldn't tell which folder holds your build (candidates: ${roots}). ` +
        "Upload the contents of the right one — or deploy through the portal, which lets you choose."
      );
    }
    case "rerooted":
      return (
        `This looks like your whole project, not just the build${junkTail}. ` +
        `Your site appears to be in \`${plan.root}\` (${plan.files.length} file${plan.files.length === 1 ? "" : "s"}) — ` +
        `upload the *contents* of that folder, not the folder around it. ` +
        "Or deploy through the portal, which fixes this automatically."
      );
    case "canonical":
    case "nested":
      return undefined; // nothing a re-root would improve
  }
}

/** A compact, structured summary for `ApiError.details`. */
function summarize(plan: BundlePlan): unknown {
  const drops: Record<string, number> = {};
  for (const d of plan.drops) drops[d.reason] = (drops[d.reason] ?? 0) + 1;
  return {
    outcome: plan.outcome,
    root: plan.root,
    keep: plan.files.length,
    drops,
    candidates: plan.candidates.slice(0, 3).map((c) => c.root),
  };
}
