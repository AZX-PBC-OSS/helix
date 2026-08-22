import {
  DirectoryError,
  GRAPH_GROUP_PERMISSION,
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_LENGTH,
  type DirectoryOutcome,
  type DirectoryProvider,
  type GroupName,
  type GroupSummary,
} from "./provider.js";

/**
 * Microsoft Graph v1.0 group reads, hand-rolled over global `fetch`.
 *
 * **Transport.** No `@microsoft/microsoft-graph-client`. This package keeps
 * `@azx-pbc/secret-store`'s zero-dependency posture (ADR-0040 decision 3 says so
 * explicitly), and the two calls below are a GET and a POST — a client library
 * would be more dependency than code. The credential arrives as a
 * {@link GetGraphToken}, so this class holds no opinion about managed identity
 * vs `az login` vs a test stub.
 *
 * **Two calls, and the query shapes are not interchangeable.** Both were settled
 * against a sixteen-probe experiment rather than the Graph documentation, which
 * is loose about which permission covers which query shape
 * (`docs/reviews/2026-08-20-entra-group-permissions-probe.md`).
 */

/** AAD scope for Microsoft Graph. */
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Entra object ids are GUIDs; see {@link EntraDirectory.getGroups}. */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Graph's error code for "the app registration lacks the permission". */
const DENIED_CODE = "Authorization_RequestDenied";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_MS = 12_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 100;

/**
 * The credential seam: anything that can produce a bearer token for the Graph
 * data plane. The portal satisfies it with `DefaultAzureCredential` — it already
 * depends on `@azure/identity` for Key Vault and Blob, and ADR-0027's line is
 * "acceptable on the privileged control plane, never the edge".
 *
 * Note this package needs none of `secret-store`'s hand-rolled managed-identity
 * HTTP: that exists because **egress** must stay off `@azure/identity`, and this
 * provider is portal-only.
 */
export type GetGraphToken = () => Promise<string>;

/** Injectable transport for tests. Defaults to global `fetch`. */
export interface EntraDirectoryOptions {
  getToken: GetGraphToken;
  fetchImpl?: typeof fetch;
  /** Injectable clock (house convention, cf. loginThrottle). */
  now?: () => number;
  /** Injectable sleep, so retry tests don't wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  totalMs?: number;
  retries?: number;
  retryBaseMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class EntraDirectory implements DirectoryProvider {
  readonly #getToken: GetGraphToken;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #totalMs: number;
  readonly #retries: number;
  readonly #retryBaseMs: number;

  constructor(opts: EntraDirectoryOptions) {
    this.#getToken = opts.getToken;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#totalMs = opts.totalMs ?? DEFAULT_TOTAL_MS;
    this.#retries = opts.retries ?? DEFAULT_RETRIES;
    this.#retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  /**
   * `GET /groups?$search="displayName:<q>"&$count=true` with
   * `ConsistencyLevel: eventual`.
   *
   * **`$search`, not `startswith`.** This is a correctness choice, not a UX
   * preference. For one probe term `$search` found 3 groups and
   * `startswith(displayName, …)` found 2 — the miss was a group carrying the term
   * as its *second* word. A prefix filter does not merely rank worse, it
   * silently omits matching groups, and in a picker an omitted group reads as
   * "that group doesn't exist" rather than "your query was too specific".
   *
   * **`ConsistencyLevel: eventual` is mandatory** — Graph answers 400
   * `Request_UnsupportedQuery` without it — which is exactly why it is set here
   * and never at a call site. A header a caller can forget is a header that
   * eventually gets forgotten.
   */
  async searchGroups(query: string, top: number): Promise<DirectoryOutcome<GroupSummary[]>> {
    const term = query.trim();
    if (term.length < MIN_SEARCH_LENGTH) {
      throw new DirectoryError(
        `directory search needs at least ${MIN_SEARCH_LENGTH} characters`,
        400,
      );
    }
    // The term is interpolated inside a quoted Graph search expression
    // (`"displayName:<term>"`), which makes a double quote the one character
    // that can break out of it and rewrite the query. Refuse rather than escape:
    // escaping rules for OData `$search` are subtle enough that a wrong one is a
    // silent injection, and no real group name needs a quote to be found.
    if (/["\\]/.test(term)) {
      throw new DirectoryError('directory search terms cannot contain " or \\', 400);
    }
    const limit = Math.max(1, Math.min(top, MAX_SEARCH_RESULTS));
    const path =
      `/groups?$search=${encodeURIComponent(`"displayName:${term}"`)}` +
      `&$count=true&$select=id,displayName,securityEnabled&$top=${limit}`;

    const res = await this.#graph("GET", path);
    if (!res.available) return res;
    // `$select` asks for securityEnabled here, so an absent flag is anomalous
    // rather than unfetched — default it to eligible instead of hiding the group.
    return {
      available: true,
      value: readGroups(res.value).map((g) => ({
        ...g,
        securityEnabled: g.securityEnabled ?? true,
      })),
    };
  }

  /**
   * `POST /directoryObjects/getByIds` with `types: ["group"]`.
   *
   * Batch, not N point reads: one round trip, and the probe confirmed unknown or
   * soft-deleted ids come back as a `200` with them simply absent from `value`
   * rather than failing the batch. That is what lets a caller render
   * "unknown group (<id>)" with no special-casing.
   *
   * **Non-GUID ids are dropped before the call, deliberately.** `Actor.groups` in
   * the portal is the *union* of the `groups` and `roles` claims (see
   * `apps/portal/src/auth/verifier.ts`), so it legitimately holds App Role values
   * like `platform-admin` next to group GUIDs. Handing one of those to Graph is a
   * 400 that fails the whole batch and takes the caller's real groups down with
   * it. Filtering here rather than at the call site keeps callers indifferent to
   * id shape — which matters because the dev provider's ids are readable names,
   * not GUIDs, and no caller should have to know which backend it is talking to.
   */
  async getGroups(ids: string[]): Promise<DirectoryOutcome<GroupName[]>> {
    const guids = [...new Set(ids.filter((id) => GUID_RE.test(id)))];
    if (guids.length === 0) return { available: true, value: [] };

    const res = await this.#graph("POST", "/directoryObjects/getByIds", {
      ids: guids,
      types: ["group"],
    });
    if (!res.available) return res;
    // The flag is passed through only when the payload actually carried one. Not
    // defaulted: an unread flag that looks like `true` is worse than an absent
    // one, because the picker cannot tell it from a real answer.
    return { available: true, value: readGroups(res.value) };
  }

  /**
   * One Graph call with a retry budget, mirroring `KeyVaultSecretStore.#call`.
   *
   * 429 and 5xx retry against a total deadline; every other 4xx is terminal
   * because retrying cannot change the answer and only burns the budget. The one
   * status with special meaning is **403 `Authorization_RequestDenied`**, which
   * is not a failure at all but the tenant telling us the permission was never
   * granted — returned as an unavailable outcome (ADR-0040 decision 8).
   */
  async #graph(
    method: "GET" | "POST",
    path: string,
    json?: unknown,
  ): Promise<DirectoryOutcome<unknown>> {
    const url = `${GRAPH_BASE}${path}`;
    const deadline = this.#now() + this.#totalMs;
    let lastError: DirectoryError | undefined;
    /**
     * Whether the last failure was acquiring the token rather than calling Graph.
     * Tracked because the two need different answers: a Graph 5xx is an outage
     * worth an error and a retry, while "we cannot get a token at all" is almost
     * always configuration — no managed identity, no `az login`, the wrong tenant
     * — and surfacing that as an opaque 500 on the group picker tells the operator
     * nothing about which. Still retried first, so a transient credential blip is
     * not reported as a misconfiguration.
     *
     * BOTH flags are needed, and a single "was the last failure a credential one"
     * flag was wrong. It recorded only the most recent attempt, so a real Graph
     * outage plus one transient token hiccup on the final attempt reported
     * `no-credential` — a permanent, operator-must-act outcome the SPA renders as
     * "check that a managed identity is attached", which never surfaces as an error
     * and never retries. That is exactly the "hide a real outage behind a consent
     * banner" failure `DirectoryOutcome`'s own doc warns against. `no-credential`
     * is now claimed only when Graph was never reached at all.
     */
    let sawCredentialFailure = false;
    /**
     * The last Graph-side failure, kept separately from `lastError`.
     *
     * When both kinds happened, this is the one worth raising: "graph returned
     * 503" is the actionable fact, and the token blip that happened to come last
     * is noise. Throwing merely the *latest* error would report a token failure
     * with no status while Graph was the thing that was down.
     */
    let lastGraphError: DirectoryError | undefined;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) break;

      let status: number;
      let text: string;
      // No initializer, like `status`/`text` above: every path out of the catch
      // below continues or breaks, so these are provably assigned wherever they
      // are read, and an initializer would just be dead.
      let retryAfter: string | null;
      let token: string;
      try {
        token = await this.#getToken();
      } catch (err) {
        sawCredentialFailure = true;
        lastError = new DirectoryError("graph token acquisition failed", undefined, undefined, {
          cause: err,
        });
        if (attempt === this.#retries) break;
        if (!(await this.#backoff(attempt, null, deadline))) break;
        continue;
      }

      try {
        // Recompute: `remaining` predates the token call, so deriving the request
        // timeout from it would hand Graph a budget already spent.
        const left = deadline - this.#now();
        if (left <= 0) break;
        const headers: Record<string, string> = {
          authorization: `Bearer ${token}`,
          // Required for $search/$count. Set here, never at a call site.
          ConsistencyLevel: "eventual",
        };
        if (json !== undefined) headers["content-type"] = "application/json";
        const res = await this.#fetch(url, {
          method,
          headers,
          body: json === undefined ? undefined : JSON.stringify(json),
          signal: AbortSignal.timeout(Math.min(this.#timeoutMs, left)),
        });
        status = res.status;
        retryAfter = res.headers.get("retry-after");
        text = await res.text();
      } catch (err) {
        lastGraphError = new DirectoryError(
          `graph ${method} ${path} failed`,
          undefined,
          undefined,
          { cause: err },
        );
        lastError = lastGraphError;
        if (attempt === this.#retries) break;
        if (!(await this.#backoff(attempt, null, deadline))) break;
        continue;
      }

      if (status >= 200 && status < 300) {
        if (!text) return { available: true, value: {} };
        try {
          return { available: true, value: JSON.parse(text) as unknown };
        } catch {
          throw new DirectoryError(`graph ${method} ${path} returned an unparseable body`, status);
        }
      }

      const code = errorCode(text);
      if (status === 403 && code === DENIED_CODE) {
        return {
          available: false,
          reason: "no-consent",
          detail:
            `Microsoft Graph refused the request: this tenant has not granted ` +
            `${GRAPH_GROUP_PERMISSION} to the portal's identity.`,
        };
      }
      if (status === 429 || status >= 500) {
        lastGraphError = new DirectoryError(
          `graph ${method} ${path} returned ${status}`,
          status,
          code,
        );
        lastError = lastGraphError;
        if (attempt === this.#retries) break;
        if (!(await this.#backoff(attempt, retryAfter, deadline))) break;
        continue;
      }
      throw new DirectoryError(`graph ${method} ${path} returned ${status}`, status, code);
    }

    // Only when the credential is the *whole* story. If any attempt got as far as
    // Graph and Graph failed, that is an outage: throw, so it is retryable and
    // visible as an error rather than as a settled configuration verdict.
    if (sawCredentialFailure && !lastGraphError) {
      return {
        available: false,
        reason: "no-credential",
        detail:
          "the portal could not acquire a Microsoft Graph token. Check that a managed identity " +
          "is attached (AZURE_CLIENT_ID), or that AZURE_TENANT_ID + AZURE_CLIENT_ID plus a " +
          "secret or certificate are set, or run `az login`.",
      };
    }
    throw (
      lastGraphError ??
      lastError ??
      new DirectoryError(`graph ${method} ${path} exhausted its ${this.#totalMs}ms budget`)
    );
  }

  /**
   * Sleep before the next attempt; `false` means stop, so the caller must
   * `break` rather than `continue` — returning without consuming time would let
   * the loop's `remaining <= 0` guard miss and turn a throttle into a retry
   * storm. Same reasoning, verbatim, as `KeyVaultSecretStore.#backoff`.
   */
  async #backoff(attempt: number, retryAfter: string | null, deadline: number): Promise<boolean> {
    const now = this.#now();
    const budget = deadline - now;
    if (budget <= 0) return false;
    const hinted = parseRetryAfter(retryAfter, now);
    if (hinted !== null && hinted > budget) return false;
    const backoff = this.#retryBaseMs * 3 ** attempt;
    const jittered = backoff + Math.random() * backoff * 0.5;
    await this.#sleep(Math.max(0, Math.min(hinted ?? jittered, budget)));
    return true;
  }
}

/**
 * Read `value[]` out of a Graph collection response.
 *
 * **A null `displayName` is dropped, not coerced to `""`.** The probe's nastiest
 * result: under a delegated token `/me/memberOf` answers 200 with the correct
 * *number* of groups and every property `null` — no error, no annotation. We
 * deliberately never call that endpoint, but the failure mode generalises to any
 * property read, and the two plausible mistakes are both bad: coercing to `""`
 * renders the right number of blank rows (reads as a UI defect rather than a
 * consent one), and `filter(g => g.securityEnabled)` on nulls matches zero while
 * looking obviously correct in review. Skipping the row keeps the list honest —
 * a missing entry shows up as "unknown group (<id>)" downstream, which points at
 * the directory rather than at us.
 */
function readGroups(body: unknown): Array<GroupName & { securityEnabled?: boolean }> {
  if (typeof body !== "object" || body === null) return [];
  const value = (body as { value?: unknown }).value;
  if (!Array.isArray(value)) return [];
  const out: Array<GroupName & { securityEnabled?: boolean }> = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const g = raw as { id?: unknown; displayName?: unknown; securityEnabled?: unknown };
    if (typeof g.id !== "string" || g.id.length === 0) continue;
    if (typeof g.displayName !== "string" || g.displayName.length === 0) continue;
    out.push({
      id: g.id,
      displayName: g.displayName,
      // Reported only when present. A group we can name but whose security flag
      // we never asked for is not "not a security group" — and it is not
      // "definitely a security group" either.
      ...(typeof g.securityEnabled === "boolean" ? { securityEnabled: g.securityEnabled } : {}),
    });
  }
  return out;
}

/** Pull `error.code` out of a Graph error body, if it looks like one. */
function errorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** `Retry-After` as milliseconds from `now`; null when absent or unparseable. */
function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}
