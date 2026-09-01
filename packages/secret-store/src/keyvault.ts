import { randomBytes } from "node:crypto";
import type { SecretStore } from "./store.js";
import type { GetVaultToken } from "./token.js";

/**
 * Azure Key Vault as the store (secrets design §3; ADR-0006 and its 2026-07-29
 * amendment, which this implements).
 *
 * The value lives in Key Vault; the `app_secrets.material` column holds only a
 * reference, so a stolen database backup is inert without the vault *and* an
 * identity RBAC admits to it. Access is via managed identity — no app-held key.
 *
 * **Transport.** Hand-rolled Key Vault data-plane REST over Node's global
 * `fetch`, not `@azure/keyvault-secrets`. This package is consumed by
 * `helix-egress` — the mechanism plane, the one process holding plaintext — and
 * ADR-0031 asks that the edge's dependency-minimal reasoning extend to egress by
 * degree, so the package stays **zero-dependency**. The same REST call already
 * has a precedent at `apps/portal/scripts/migrate-deploy.ts`. The credential is
 * injected as a one-function {@link GetVaultToken} seam, so egress can supply a
 * hand-rolled managed-identity provider while the portal supplies
 * `DefaultAzureCredential` (which it already depends on, and which also lets
 * operator scripts run under `az login`).
 *
 * **Material contract** — `kv:<name>/<version>`:
 *  - `name` is `hx-` + 32 random hex chars. Opaque on purpose: vault metadata
 *    (which is visible to anyone who can list the vault) leaks no app id, tenant,
 *    or secret name. Random names also never collide with a soft-delete tombstone.
 *  - `version` pins an **immutable** vault version. This is what makes the
 *    plaintext cache below safe: rotation mints a brand-new name *and* version, so
 *    the material token itself changes and a cache hit can never serve a stale
 *    value. That is a property of the format, not a hope.
 *
 * **Timeout / retry** (the ADR-0006 challenge amendment — the dev path is pure
 * CPU and cannot surface these failure modes):
 *  - Per-attempt timeout: 3 s on the `open()` hot path, 10 s for `seal()` /
 *    `destroy()` (control plane, not latency-critical). This covers **token
 *    acquisition as well as the vault call** — the identity endpoint is a network
 *    hop with its own failure modes, and leaving it unbounded made the deadline
 *    below unenforceable however healthy the vault was.
 *  - A **total deadline** bounds the whole call (8 s / 25 s), so retries can never
 *    stack past the egress request budget however slow the vault *or the identity
 *    endpoint* is.
 *  - Retry only on a transport error, `429`, or `5xx`; `2` extra attempts.
 *    `Retry-After` is honoured when present; a hint larger than the remaining
 *    budget fails immediately rather than sleeping out the budget to no purpose.
 *    Otherwise exponential backoff with jitter.
 *  - `403` / `404` / any other `4xx` are **terminal** — an RBAC or integrity
 *    failure must fail fast rather than burn the budget.
 */

const API_VERSION = "7.4";
const SCHEME = "kv";
/** KV secret names are limited to `^[0-9a-zA-Z-]+$`; versions are hex. */
const NAME_RE = /^[0-9a-zA-Z-]+$/;
const VERSION_RE = /^[0-9a-zA-Z]+$/;

const DEFAULT_OPEN_TIMEOUT_MS = 3_000;
const DEFAULT_OPEN_TOTAL_MS = 8_000;
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
const DEFAULT_WRITE_TOTAL_MS = 25_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 100;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX = 512;

/**
 * A Key Vault data-plane failure. `status` lets callers separate an integrity
 * failure (`404` — the row references a vault entry that is gone) from an
 * authorization failure (`403` — RBAC or the private endpoint). Never carries a
 * secret value.
 */
export class KeyVaultError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "KeyVaultError";
  }
}

export interface KeyVaultSecretStoreOptions {
  /** e.g. `https://helix-prod-kvc.vault.azure.net`. */
  vaultUrl: string;
  /** Bearer token for the `https://vault.azure.net` audience. */
  getToken: GetVaultToken;
  /** Injectable transport for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (house convention, cf. loginThrottle). */
  now?: () => number;
  /** Injectable sleep, so retry tests don't wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  cacheTtlMs?: number;
  cacheMax?: number;
  openTimeoutMs?: number;
  openTotalMs?: number;
  writeTimeoutMs?: number;
  writeTotalMs?: number;
  retries?: number;
  retryBaseMs?: number;
}

interface VaultRef {
  name: string;
  version: string;
}

/** Parse `kv:<name>/<version>`, rejecting anything that could escape the URL path. */
function parseMaterial(material: string): VaultRef {
  const sep = material.indexOf(":");
  const scheme = sep === -1 ? null : material.slice(0, sep);
  if (scheme !== SCHEME) {
    // No fallback to the dev `aesgcm:` scheme — a cross-scheme read would be a
    // downgrade seam, letting DB-resident ciphertext substitute for the vault.
    //
    // Name the scheme we found. It is not a secret, and it is the only signal an
    // operator gets: an environment whose rows were sealed under the dev envelope
    // and then pointed at a vault fails *every* secret, and "malformed" alone
    // reads as corruption rather than "these rows are under the other backend".
    throw new KeyVaultError(
      scheme && /^[a-z0-9-]{1,16}$/.test(scheme)
        ? `secret material is not Key Vault material (scheme "${scheme}") — ` +
            `rows sealed under a different custody backend cannot be read here`
        : "malformed secret material",
    );
  }
  const rest = material.slice(sep + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) throw new KeyVaultError("malformed secret material");
  const name = rest.slice(0, slash);
  const version = rest.slice(slash + 1);
  if (!NAME_RE.test(name) || !VERSION_RE.test(version)) {
    throw new KeyVaultError("malformed secret material");
  }
  return { name, version };
}

/** The trailing path segment of a vault `id` URL is the version. */
function versionFromId(id: unknown): string {
  if (typeof id !== "string") {
    throw new KeyVaultError("key vault response missing secret id");
  }
  const version = id.slice(id.lastIndexOf("/") + 1);
  if (!VERSION_RE.test(version)) {
    throw new KeyVaultError("key vault response had an unparseable secret id");
  }
  return version;
}

/** Seconds, or an HTTP-date. Returns ms, or null when absent/unparseable. */
function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when a raced promise misses its deadline. Retryable, like a transport error. */
class DeadlineError extends Error {}

/**
 * Wait for `promise`, but no longer than `ms`.
 *
 * Deliberately a **race, not a cancellation**. The one caller is token acquisition, and
 * `ManagedIdentityTokenProvider.getToken()` is single-flight — every concurrent caller
 * shares one promise backed by one HTTP call. Cancelling it on behalf of whichever caller
 * happens to run out of budget first would fail every other waiter too, exactly under the
 * burst that single-flight exists to collapse. Letting the refresh run to completion under
 * its own timeout instead means it still populates the provider's cache, so the request
 * after this one gets a hit — the abandoned work warms the cache rather than being wasted.
 *
 * The `.catch` on the loser is not optional: an unobserved late rejection is fatal under
 * `--unhandled-rejections=strict`.
 */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${label} exceeded ${ms}ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer);
  }) as Promise<T>;
}

export class KeyVaultSecretStore implements SecretStore {
  readonly #base: string;
  readonly #getToken: GetVaultToken;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #cacheTtlMs: number;
  readonly #cacheMax: number;
  readonly #openTimeoutMs: number;
  readonly #openTotalMs: number;
  readonly #writeTimeoutMs: number;
  readonly #writeTotalMs: number;
  readonly #retries: number;
  readonly #retryBaseMs: number;

  /**
   * Plaintext cache keyed by the **full material** (name *and* version), so an
   * entry can only ever be served for the exact immutable vault version it came
   * from. Insertion-ordered `Map` doubles as the LRU: a hit re-inserts to move the
   * entry to the tail, and an overflow evicts the head.
   */
  readonly #cache = new Map<string, { value: string; expiresAtMs: number }>();
  /** Single-flight per material: a burst of requests makes one vault call. */
  readonly #inFlight = new Map<string, Promise<string>>();
  /**
   * Materials released by `destroy()` while an `open()` for them was already in flight.
   * Without this the in-flight read resolves *after* the delete and re-caches plaintext
   * the operator just released, for a full TTL. Scoped to the in-flight window and cleared
   * alongside it, so it stays bounded — unlike an open-ended tombstone set.
   */
  readonly #released = new Set<string>();

  constructor(opts: KeyVaultSecretStoreOptions) {
    // Parse rather than trim. An `http://` typo in AZURE_KEY_VAULT_URL would send the
    // vault bearer token — a credential for the whole kv-connections data plane — in
    // cleartext, and receive secrets back the same way. Building off `origin` also drops
    // any stray path/query that would otherwise be concatenated into every request path.
    // Throwing here is the right failure: the portal catches it into a 503 and egress
    // refuses to boot, both fail-closed.
    const parsed = new URL(opts.vaultUrl);
    if (parsed.protocol !== "https:") {
      throw new Error(`secret-store: vault URL must be https (got ${parsed.protocol}//)`);
    }
    this.#base = parsed.origin;
    this.#getToken = opts.getToken;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#cacheMax = opts.cacheMax ?? DEFAULT_CACHE_MAX;
    this.#openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.#openTotalMs = opts.openTotalMs ?? DEFAULT_OPEN_TOTAL_MS;
    this.#writeTimeoutMs = opts.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.#writeTotalMs = opts.writeTotalMs ?? DEFAULT_WRITE_TOTAL_MS;
    this.#retries = opts.retries ?? DEFAULT_RETRIES;
    this.#retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  /**
   * How many plaintext entries the cache currently holds. A count only — never the
   * materials and never the values. Exists so "an expired entry is *swept*, not merely
   * unservable" is assertable (the difference is invisible from behaviour alone, which is
   * exactly how the missing sweep went unnoticed), and it is the natural hook if this ever
   * wants a gauge.
   */
  cachedCount(): number {
    return this.#cache.size;
  }

  async seal(value: string): Promise<string> {
    const name = `hx-${randomBytes(16).toString("hex")}`;
    const body = await this.#call("PUT", `/secrets/${name}`, {
      perAttemptMs: this.#writeTimeoutMs,
      totalMs: this.#writeTotalMs,
      json: { value },
    });
    return `${SCHEME}:${name}/${versionFromId(body.id)}`;
  }

  async open(material: string): Promise<string> {
    const ref = parseMaterial(material);

    const hit = this.#cache.get(material);
    if (hit) {
      if (this.#now() < hit.expiresAtMs) {
        // Re-insert to move to the LRU tail.
        this.#cache.delete(material);
        this.#cache.set(material, hit);
        return hit.value;
      }
      this.#cache.delete(material);
    }

    const existing = this.#inFlight.get(material);
    if (existing) return existing;

    const pending = this.#fetchAndCache(material, ref).finally(() => {
      this.#inFlight.delete(material);
      this.#released.delete(material);
    });
    this.#inFlight.set(material, pending);
    return pending;
  }

  async destroy(material: string): Promise<void> {
    const ref = parseMaterial(material);
    // Drop the cached plaintext *first*: if the vault delete then fails, we have
    // not left a warm copy of a secret the operator asked us to release.
    this.#cache.delete(material);
    // …and stop an already-in-flight read from putting it straight back.
    if (this.#inFlight.has(material)) this.#released.add(material);
    await this.#call("DELETE", `/secrets/${ref.name}`, {
      perAttemptMs: this.#writeTimeoutMs,
      totalMs: this.#writeTotalMs,
      // Already gone is the state we wanted; deleting all versions of the name is
      // correct because `seal` never reuses a name.
      okStatuses: [404],
    });
  }

  async #fetchAndCache(material: string, ref: VaultRef): Promise<string> {
    const body = await this.#call("GET", `/secrets/${ref.name}/${ref.version}`, {
      perAttemptMs: this.#openTimeoutMs,
      totalMs: this.#openTotalMs,
    });
    const value = body.value;
    if (typeof value !== "string") {
      throw new KeyVaultError("key vault response missing secret value");
    }
    // A `destroy()` landed while this read was in flight — the operator released this
    // material, so return the value to the caller that asked but do not warm the cache.
    if (this.#released.has(material)) return value;

    const now = this.#now();
    // Sweep expired entries rather than waiting for a later `open()` of the same material
    // to notice. They are never *served* stale (the TTL is checked on read), but an
    // unswept entry keeps a revoked credential resident in the egress heap indefinitely,
    // where a core dump or a memory-disclosure bug can still recover it.
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAtMs <= now) this.#cache.delete(key);
    }

    // Only successful reads are cached — a failure must not be memoized.
    this.#cache.set(material, { value, expiresAtMs: now + this.#cacheTtlMs });
    if (this.#cache.size > this.#cacheMax) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    return value;
  }

  /**
   * One Key Vault data-plane call with the timeout/retry policy above. Returns
   * the parsed JSON body (`{}` for a no-content or `okStatuses` short-circuit).
   */
  async #call(
    method: string,
    path: string,
    opts: {
      perAttemptMs: number;
      totalMs: number;
      json?: unknown;
      okStatuses?: number[];
    },
  ): Promise<Record<string, unknown>> {
    const url = `${this.#base}${path}?api-version=${API_VERSION}`;
    const deadline = this.#now() + opts.totalMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) break;

      let status: number;
      let text: string;
      let retryAfter: string | null;
      try {
        // Bound the token call too. It is a network hop (the ACA identity endpoint) with
        // its own failure modes, and leaving it outside the budget made the documented
        // `open()` deadline unenforceable — a slow identity endpoint could blow the whole
        // 8s on its own before the vault was touched.
        const token = await raceTimeout(
          this.#getToken(),
          Math.min(opts.perAttemptMs, remaining),
          "key vault token acquisition",
        );
        // Recompute: `remaining` predates the token call, so deriving the request timeout
        // from it would hand the vault a budget that was already spent.
        const left = deadline - this.#now();
        if (left <= 0) {
          lastError = new KeyVaultError(
            `key vault ${method} ${path} exhausted its ${opts.totalMs}ms budget acquiring a token`,
          );
          break;
        }
        const headers: Record<string, string> = { authorization: `Bearer ${token}` };
        if (opts.json !== undefined) headers["content-type"] = "application/json";
        const res = await this.#fetch(url, {
          method,
          headers,
          body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
          signal: AbortSignal.timeout(Math.min(opts.perAttemptMs, left)),
        });
        status = res.status;
        text = await res.text();
        retryAfter = res.headers.get("retry-after");
      } catch (err) {
        // Transport error, token deadline, or per-attempt timeout — all retryable.
        lastError = new KeyVaultError(`key vault ${method} ${path} failed`, undefined, undefined, {
          cause: err,
        });
        if (attempt === this.#retries) break;
        if (!(await this.#backoff(attempt, null, deadline))) break;
        continue;
      }

      if (status >= 200 && status < 300) {
        if (!text) return {};
        try {
          return JSON.parse(text) as Record<string, unknown>;
        } catch {
          // A 2xx with a non-JSON body (a proxy or private-endpoint interstitial, say)
          // must still honour the KeyVaultError contract — callers branch on `.status`.
          // The body is deliberately not attached: a GET body starts `{"value":"<cred>`
          // and V8's `Unexpected token …` form echoes its input.
          throw new KeyVaultError(
            `key vault ${method} ${path} returned an unparseable body`,
            status,
          );
        }
      }
      if (opts.okStatuses?.includes(status)) return {};

      const code = errorCode(text);
      if (status === 429 || status >= 500) {
        lastError = new KeyVaultError(
          `key vault ${method} ${path} returned ${status}`,
          status,
          code,
        );
        if (attempt === this.#retries) break;
        if (!(await this.#backoff(attempt, retryAfter, deadline))) break;
        continue;
      }
      // 4xx other than 429: RBAC (403), missing entry (404), bad request. All
      // terminal — retrying cannot change the answer and only burns the budget.
      throw new KeyVaultError(`key vault ${method} ${path} returned ${status}`, status, code);
    }

    throw (
      lastError ??
      new KeyVaultError(`key vault ${method} ${path} exhausted its ${opts.totalMs}ms budget`)
    );
  }

  /**
   * Sleep before the next attempt. Returns `false` when there is no point retrying, so
   * the caller must `break` rather than `continue`.
   *
   * The `false` cases matter for more than tidiness. An unsatisfiable `Retry-After` (the
   * vault says 30 s, the budget has 8 s) previously slept the *entire* remaining budget
   * and then failed anyway — holding an egress request and the edge's undici connection
   * for 8 s to accomplish nothing, which under sustained throttling turns a vault-side
   * rate limit into egress-side connection exhaustion. Failing now is strictly better.
   *
   * Note this has to be a verdict, not an early `return`: returning without sleeping would
   * fall through to `continue`, and since no time was consumed the loop's `remaining <= 0`
   * guard would not fire — turning a throttle into an immediate retry storm.
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

/** Pull `error.code` out of a Key Vault error body, if it looks like one. */
function errorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}
