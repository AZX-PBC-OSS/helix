/**
 * The `DirectoryProvider` seam (ADR-0040 decision 3) — how the **control plane**
 * turns a directory group id into a name, and a search term into candidate
 * groups. Modelled deliberately on `@azx-pbc/secret-store` (ADR-0006): zero
 * runtime dependencies, hand-rolled REST over global `fetch`, and the credential
 * injected as a one-function seam so nothing here has an opinion about how the
 * process authenticates.
 *
 * **Two methods, and the absent third one is the decision.**
 *
 * The empirical probe behind ADR-0040 (`docs/reviews/2026-08-20-entra-group-
 * permissions-probe.md`) confirmed that `GET /groups/{id}/members` returns 200
 * under the single permission we ask for, `GroupMember.Read.All`. The grant we
 * hold therefore *permits* reading the membership of every group in the tenant —
 * the organisation's social graph. We never need it, and leaving it out of this
 * interface is what makes the real blast radius auditable by reading one file
 * instead of auditing every call site. It also stops a later contributor
 * reaching for `/members` on the grounds that it happens to work.
 *
 * So: **do not add a member-enumeration method here.** If a feature ever
 * genuinely needs one, that is a new ADR, not a new method.
 *
 * **This lives in the portal only.** The edge never calls Graph, never holds the
 * credential, and gains no dependency from any of this (ADR-0003) — the only
 * thing the data plane does with groups is intersect two string arrays.
 */

/** Microsoft Graph application permission this provider is built against. */
export const GRAPH_GROUP_PERMISSION = "GroupMember.Read.All";

/** A group as the picker shows it. */
export interface GroupSummary {
  /** Object id — a GUID under Entra, a readable fixture name in dev. */
  id: string;
  displayName: string;
  /**
   * Whether this is a *security* group (the only kind the `groups` claim
   * carries, so the only kind worth scoping an app to).
   *
   * Reported rather than filtered: the picker marks a non-security group instead
   * of hiding it, because "the group I searched for isn't in the list" is a much
   * worse failure than "the group is listed and greyed out with a reason".
   */
  securityEnabled: boolean;
}

/** An id resolved to a name. */
export interface GroupName {
  id: string;
  displayName: string;
  /**
   * Optional because the batch resolve endpoint does not always report it, and
   * **"we did not read this" must be distinguishable from `true`.** Defaulting an
   * unread flag to `true` made the same group render eligible in the caller's
   * own-groups view and ineligible in search results, so which one an operator saw
   * depended on the order the two queries happened to resolve in.
   */
  securityEnabled?: boolean;
}

/**
 * Why the directory can't answer, when the reason is **structural** rather than
 * transient — a state that retrying cannot fix, and that the UI must degrade
 * around permanently rather than surface as an error.
 *
 * - `no-consent` — the tenant has not granted {@link GRAPH_GROUP_PERMISSION}.
 *   ADR-0040 decision 8: a customer administrator may be mid-negotiation or may
 *   simply decline, and there is no narrower ask available to offer them
 *   (Graph application permissions are tenant-wide by construction). Group
 *   visibility keeps working end to end regardless, because *enforcement* never
 *   depended on Graph — only the picker does.
 * - `no-credential` — a directory *is* configured, but no Graph token could be
 *   acquired: no managed identity, no `az login`, no `AZURE_*` environment
 *   credential, or a tenant mismatch. Distinct from `no-consent` because the fix
 *   is completely different — the operator has a credential problem, not a
 *   consent one — and telling them to go ask an administrator for
 *   {@link GRAPH_GROUP_PERMISSION} when the real answer is "the portal cannot
 *   authenticate" sends them to the wrong person.
 * - `not-configured` — this deployment wired no directory at all.
 */
export type DirectoryUnavailableReason = "no-consent" | "no-credential" | "not-configured";

/**
 * The result of a directory read.
 *
 * Structural absence is a **value**, not an exception, and that split is the
 * point. A missing consent grant is a permanent, expected, operator-fixable
 * condition that the Access tab has to render a banner for; modelling it as a
 * thrown error would put the picker in a failure state and make the documented
 * fallback (free-text GUID entry) the hard path instead of the easy one.
 *
 * Transient failures — a timeout, a 5xx that outlived its retries, a malformed
 * response — still **throw** {@link DirectoryError}. Those are worth an error
 * surface and a retry, and conflating them with "your tenant said no" would hide
 * a real outage behind a consent banner.
 */
export type DirectoryOutcome<T> =
  | { available: true; value: T }
  | { available: false; reason: DirectoryUnavailableReason; detail: string };

/**
 * A transient directory failure. Carries `status`/`code` so a caller can tell a
 * transport timeout from an upstream refusal. Never carries a token.
 */
export class DirectoryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DirectoryError";
  }
}

export interface DirectoryProvider {
  /**
   * Groups whose display name matches `query`.
   *
   * Implementations must enforce a minimum query length and a hard result cap
   * themselves rather than trusting the caller: this is a tenant-wide read, and
   * ADR-0040's consequences commit to shipping it restrictive.
   */
  searchGroups(query: string, top: number): Promise<DirectoryOutcome<GroupSummary[]>>;

  /**
   * Resolve ids to display names.
   *
   * **Ids that do not resolve are omitted, not errors.** A stale or deleted group
   * id is an ordinary state — an app can be scoped to a group somebody later
   * deletes — and the probe confirmed both degradations are clean (a `404` on a
   * point read, a `200` with an empty array from the batch endpoint). Callers
   * render what came back and show the bare id for the rest.
   */
  getGroups(ids: string[]): Promise<DirectoryOutcome<GroupName[]>>;
}

/** Shortest search term a provider will accept (ADR-0040 consequences). */
export const MIN_SEARCH_LENGTH = 3;

/** Hard cap on results per search, whatever the caller asks for. */
export const MAX_SEARCH_RESULTS = 25;

/**
 * A provider that reports its own absence instead of throwing (ADR-0040
 * decision 8's "unavailable variant").
 *
 * Exists so the portal can always decorate itself with *a* provider and the
 * routes never branch on null. The alternative — a nullable decorator — pushes
 * a null check into every call site, and the one that gets forgotten throws a
 * 500 on the Access tab, which is precisely the failure decision 8 forbids.
 */
export class UnavailableDirectory implements DirectoryProvider {
  readonly #detail: string;

  constructor(detail = "no directory provider is configured on this deployment") {
    this.#detail = detail;
  }

  async searchGroups(): Promise<DirectoryOutcome<GroupSummary[]>> {
    return { available: false, reason: "not-configured", detail: this.#detail };
  }

  async getGroups(): Promise<DirectoryOutcome<GroupName[]>> {
    return { available: false, reason: "not-configured", detail: this.#detail };
  }
}
