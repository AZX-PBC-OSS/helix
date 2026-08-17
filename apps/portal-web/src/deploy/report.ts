import type { DeployReport } from "@azx-pbc/shared";
import { type BundlePlan, PLANNER_VERSION } from "@azx-pbc/shared/bundlePlan";

/**
 * Distil a rich `BundlePlan` into the compact, client-asserted `DeployReport`
 * stored on the version row (ADR-0038). Counts and kinds only — never the file
 * list — so it stays small and carries nothing sensitive.
 */
export function toDeployReport(plan: BundlePlan): DeployReport {
  const drops: Record<string, number> = {};
  for (const d of plan.drops) drops[d.reason] = (drops[d.reason] ?? 0) + 1;
  return {
    plannerVersion: PLANNER_VERSION,
    outcome: plan.outcome,
    root: plan.root,
    fileCount: plan.files.length,
    drops,
    problems: [...new Set(plan.problems.map((p) => p.kind))],
    candidates: plan.candidates.slice(0, 10).map((c) => c.root),
  };
}
