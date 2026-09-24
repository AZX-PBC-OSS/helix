/**
 * Portal-only group search and name resolution (ADR-0040). Implementations
 * use global fetch with an injected credential and no runtime dependencies.
 * The edge does not call Graph or hold its credential.
 *
 * Do not add member enumeration without a new ADR. GroupMember.Read.All also
 * permits reading every group's members, but this interface intentionally
 * exposes only search and id-to-name lookup. See the permission probe linked
 * from ADR-0040.
 */

/** Microsoft Graph application permission this provider is built against. */
export const GRAPH_GROUP_PERMISSION = "GroupMember.Read.All";

export interface GroupSummary {
  /** Object id — a GUID under Entra, a readable fixture name in dev. */
  id: string;
  displayName: string;
  /**
   * Only security groups appear in the configured groups claim. Return this flag
   * so the picker can disable ineligible groups with an explanation.
   */
  securityEnabled: boolean;
}

export interface GroupName {
  id: string;
  displayName: string;
  /**
   * Batch resolution may omit this flag. Preserve undefined as unknown; treating
   * it as true would disagree with search results for non-security groups.
   */
  securityEnabled?: boolean;
}

/**
 * Non-transient states that the UI reports with a fallback to manual group ids:
 * - no-consent: the tenant has not granted GRAPH_GROUP_PERMISSION.
 * - no-credential: the portal cannot acquire a Graph token (for example, missing
 *   credentials or a tenant mismatch).
 * - not-configured: no directory backend is configured.
 * Group visibility enforcement works without these lookups.
 */
export type DirectoryUnavailableReason = "no-consent" | "no-credential" | "not-configured";

/**
 * Expected unavailability is a result value, allowing a banner and manual-id
 * fallback. Timeouts, exhausted 5xx retries, and malformed responses throw
 * DirectoryError so callers can show an error and offer a retry.
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
   * Find groups matching query. Implementations must enforce minimum query
   * length and result caps themselves because this is a tenant-wide read.
   */
  searchGroups(query: string, top: number): Promise<DirectoryOutcome<GroupSummary[]>>;

  /**
   * Resolve ids to display names. Omit missing or deleted groups; callers should
   * display the raw id for any unresolved selection.
   */
  getGroups(ids: string[]): Promise<DirectoryOutcome<GroupName[]>>;
}

/** Shortest search term a provider will accept (ADR-0040 consequences). */
export const MIN_SEARCH_LENGTH = 3;

/** Hard cap on results per search, whatever the caller asks for. */
export const MAX_SEARCH_RESULTS = 25;

/**
 * Default provider for deployments without a directory (ADR-0040 decision 8).
 * Routes can return unavailability without nullable-provider checks.
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
