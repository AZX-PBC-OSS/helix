import {
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_LENGTH,
  DirectoryError,
  type DirectoryOutcome,
  type DirectoryProvider,
  type GroupName,
  type GroupSummary,
} from "./provider.js";

/**
 * An in-memory directory for local development and CI — the counterpart to
 * `DevEnvelopeSecretStore`, and what keeps the whole suite free of Microsoft
 * Graph (ADR-0040 decision 3).
 *
 * **Its ids are readable strings, not GUIDs, and that is on purpose.**
 * `apps/dev-idp` emits `eng-team` in the `groups` claim while Entra emits object
 * GUIDs, so dev and prod differ in shape by design (ADR-0040's consequences say
 * so, and add: no test may assume a GUID shape). The gate and this seam are both
 * indifferent — which is exactly the property worth exercising locally, because
 * a hidden GUID assumption anywhere would pass every local test and fail in a
 * tenant.
 *
 * It matches on substring rather than prefix for the same reason `EntraDirectory`
 * uses `$search`: a prefix match here would make local behaviour *differ* from
 * production in the one way the probe found to be a correctness bug, so the
 * picker would look fine in dev and silently omit groups in a real tenant.
 */
export class StaticDirectory implements DirectoryProvider {
  readonly #groups: GroupSummary[];

  constructor(groups: GroupSummary[]) {
    this.#groups = groups;
  }

  async searchGroups(query: string, top: number): Promise<DirectoryOutcome<GroupSummary[]>> {
    const term = query.trim().toLowerCase();
    // Enforced here too, not just in the Entra provider: a minimum-length rule
    // that only the production backend applies is a rule no test ever exercises.
    if (term.length < MIN_SEARCH_LENGTH) {
      throw new DirectoryError(
        `directory search needs at least ${MIN_SEARCH_LENGTH} characters`,
        400,
      );
    }
    const limit = Math.max(1, Math.min(top, MAX_SEARCH_RESULTS));
    const hits = this.#groups
      .filter(
        (g) => g.displayName.toLowerCase().includes(term) || g.id.toLowerCase().includes(term),
      )
      .slice(0, limit);
    return { available: true, value: hits };
  }

  async getGroups(ids: string[]): Promise<DirectoryOutcome<GroupName[]>> {
    const wanted = new Set(ids);
    // Unknown ids are omitted rather than errors — the same contract Graph's
    // `getByIds` gives us, so callers behave identically against either backend.
    // Reports the flag: the fixtures carry it, so omitting it here would make dev
    // exercise a path production never takes.
    const value = this.#groups
      .filter((g) => wanted.has(g.id))
      .map(({ id, displayName, securityEnabled }) => ({ id, displayName, securityEnabled }));
    return { available: true, value };
  }
}

/**
 * The dev fixture set. Ids match `apps/dev-idp`'s `groups` claim values
 * (`fixtures.ts`), so scoping a local app to `eng-team` and signing in as Alice
 * actually admits her — the picker, the claim and the gate agree end to end
 * without Graph.
 *
 * `platform-admin` is here because it is a real value in the local claim (it is
 * the portal's admin App Role), and leaving it out would make the caller's
 * "your groups" view silently incomplete in dev. It is marked
 * `securityEnabled: false` to model the production truth: an App Role is not a
 * security group, and the picker should discourage scoping an app to one.
 */
export const DEV_FIXTURE_GROUPS: GroupSummary[] = [
  { id: "eng-team", displayName: "Engineering", securityEnabled: true },
  { id: "product-team", displayName: "Product", securityEnabled: true },
  { id: "design-team", displayName: "Design", securityEnabled: true },
  { id: "eng-platform", displayName: "Engineering Platform", securityEnabled: true },
  { id: "platform-admin", displayName: "Platform Admins (app role)", securityEnabled: false },
];
