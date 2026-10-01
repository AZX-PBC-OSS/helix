import { type App, type Visibility, type VisibilityMode } from "@azx-pbc/shared";

/**
 * The pure transition planner for the Access tab's unified selector
 * (`AccessTab`). The five selectable states are the four visibility modes plus
 * `archived` — a lifecycle flag the registry keeps alongside visibility, which
 * the selector surfaces as a fifth state: the current state is `archived` when
 * the app is archived, whatever visibility it retains underneath.
 *
 * Everything the confirm step needs comes from here, so the dialog cannot drift
 * from what actually fires: the exact mutation sequence, whether the change
 * opens an admin-approval request, and the title/label. Pure and render-free —
 * unit-tested against the full transition matrix in `accessTransition.test.ts`.
 *
 * Compound transitions exist because the server's endpoints are per-concern:
 * password apps can only migrate through `internal` (disabling always lands
 * there — routes/apps.ts), and unarchiving is its own call. Steps run
 * sequentially and stop at the first failure; every endpoint involved is
 * idempotent, so retrying a partially-applied sequence is safe. Ordering is
 * chosen so a partial failure fails safe: visibility applies before unarchive,
 * because an app left archived is not serving anything.
 */

/** The five states the Access tab's selector offers. */
export type AccessState = VisibilityMode | "archived";

/** One mutation call the runner executes, in order. */
export type TransitionStep =
  | { kind: "setVisibility"; visibility: Visibility }
  | { kind: "enablePassword" }
  | { kind: "disablePassword" }
  | { kind: "setArchived"; archived: boolean };

export interface TransitionPlan {
  steps: TransitionStep[];
  /** True when confirming opens an admin-approval request (→ public). */
  elevated: boolean;
  title: string;
  confirmLabel: string;
}

/** The state the selector shows as current: archived wins over visibility. */
export function accessStateOf(app: App): AccessState {
  return app.archivedAt !== null ? "archived" : app.visibility.mode;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

/** The wire visibility for a live (non-archived) target, or null. */
function visibilityFor(target: AccessState, groupIds: string[]): Visibility | null {
  switch (target) {
    case "internal":
      return { mode: "internal" };
    case "group":
      return { mode: "group", groupIds };
    case "public":
      return { mode: "public" };
    default:
      return null;
  }
}

function targetWording(target: AccessState, name: string): { title: string; confirmLabel: string } {
  switch (target) {
    case "internal":
      return { title: `Make ${name} internal?`, confirmLabel: "Make internal" };
    case "group":
      return { title: `Restrict ${name} to groups?`, confirmLabel: "Restrict to groups" };
    case "public":
      return { title: `Request public access for ${name}?`, confirmLabel: "Request approval" };
    case "password":
      return {
        title: `Enable password access for ${name}?`,
        confirmLabel: "Enable password access",
      };
    case "archived":
      return { title: `Archive ${name}?`, confirmLabel: "Archive" };
  }
}

/**
 * Plan the transition from the app's current state to `target`.
 *
 * Returns `null` when confirming would change nothing: the target equals the
 * current state, or — the one exception — the target is `group` on an app that
 * is already group-scoped with the same group set, which is exactly where a
 * group-ids edit is expressed instead.
 *
 * @param groupIds the draft group set; only read when `target` is `group`.
 */
export function planTransition(
  app: App,
  target: AccessState,
  groupIds: string[],
): TransitionPlan | null {
  const current = accessStateOf(app);
  const name = app.displayName;
  const preserved = app.visibility;
  const preservedIds = preserved.mode === "group" ? preserved.groupIds : [];

  if (current === target) {
    // Selecting the current state is a no-op — unless it is `group`, whose
    // panel is "edit which groups": the one edit an owner makes precisely
    // because the app is already group-scoped (ADR-0040).
    if (current !== "group" || sameIds(groupIds, preservedIds)) return null;
    return {
      steps: [{ kind: "setVisibility", visibility: { mode: "group", groupIds } }],
      elevated: false,
      title: `Change the groups for ${name}?`,
      confirmLabel: "Save groups",
    };
  }

  if (target === "archived") {
    return {
      steps: [{ kind: "setArchived", archived: true }],
      elevated: false,
      title: `Archive ${name}?`,
      confirmLabel: "Archive",
    };
  }

  // From the archive: restoring the preserved visibility unchanged is just
  // unarchive; anything else applies the new visibility first (a partial
  // failure leaves the app archived and not serving) and then unarchives.
  if (current === "archived") {
    const preservedRestored =
      target === preserved.mode && (target !== "group" || sameIds(groupIds, preservedIds));
    if (preservedRestored) {
      return {
        steps: [{ kind: "setArchived", archived: false }],
        elevated: false,
        title: `Unarchive ${name}?`,
        confirmLabel: "Unarchive",
      };
    }
    if (target === "public") {
      // Going public opens an approval and applies nothing — so the app stays
      // archived until the request lands and the owner unarchives.
      return {
        steps: [{ kind: "setVisibility", visibility: { mode: "public" } }],
        elevated: true,
        title: `Request public access for ${name}?`,
        confirmLabel: "Request approval",
      };
    }
    const visibility = visibilityFor(target, groupIds);
    if (visibility === null) return null;
    return {
      steps: [
        { kind: "setVisibility", visibility },
        { kind: "setArchived", archived: false },
      ],
      elevated: false,
      ...targetWording(target, name),
    };
  }

  // From `password`: disabling always lands on `internal` (routes/apps.ts), so
  // every other target migrates through it — disable, then apply.
  if (current === "password") {
    if (target === "internal") {
      return {
        steps: [{ kind: "disablePassword" }],
        elevated: false,
        title: `Disable password access for ${name}?`,
        confirmLabel: "Disable",
      };
    }
    const visibility = visibilityFor(target, groupIds);
    if (visibility === null) return null;
    return {
      steps: [{ kind: "disablePassword" }, { kind: "setVisibility", visibility }],
      elevated: target === "public",
      ...targetWording(target, name),
    };
  }

  // Live mode → password: one call. Enabling flips visibility and mints (or
  // hands back) the credential in the same endpoint, CAS-guarded.
  if (target === "password") {
    return {
      steps: [{ kind: "enablePassword" }],
      elevated: false,
      ...targetWording(target, name),
    };
  }

  const visibility = visibilityFor(target, groupIds);
  if (visibility === null) return null;
  return {
    steps: [{ kind: "setVisibility", visibility }],
    elevated: target === "public",
    ...targetWording(target, name),
  };
}
