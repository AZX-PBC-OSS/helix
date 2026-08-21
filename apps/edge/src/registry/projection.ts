/**
 * The edge's cached registry projection (architecture §7): an in-memory
 * slug → entry map loaded from Postgres with hand-written SQL (no ORM in the
 * edge — project plan §1). The portal owns the schema; the edge only reads.
 *
 * Failure stance: serve stale. A load error keeps the previous map, so the
 * data path doesn't depend on the portal or a healthy DB connection — only
 * the very first load gates serving (isLoaded()). Because that means a
 * sustained failure would otherwise serve an out-of-date access rule silently
 * and indefinitely, every load also updates `freshness()` — the state `/health`
 * degrades on and the load-failure log event reports (ADR-0025 item 1).
 */
import {
  CapabilitiesSchema,
  DataCapabilitySchema,
  FetchCapabilitySchema,
  LlmCapabilitySchema,
  OfflineCapabilitySchema,
  isValidServiceWorkerScope,
  type DataCapability,
  type LlmCapability,
  type VisibilityMode,
} from "@azx-pbc/shared";
import { normalizeRequestPath } from "../serving/paths.js";

/** The edge's per-app view of the fetch-proxy grant (fetch-proxy design §7). */
export interface FetchProxyGrant {
  /**
   * Canonical proxied origin → connection (secret) name, or null for a keyless
   * proxied origin. The egress allowlist: a target origin not present here is
   * 403'd before anything leaves the edge.
   */
  connections: Map<string, string | null>;
  /** Per-app daily proxied-request budget; null ⇒ unbounded. */
  requestsPerDay: number | null;
  /** Whether to inject the transparent fetch shim at serve time (§3.2). */
  shim: boolean;
}

export interface RegistryEntry {
  appId: string;
  slug: string;
  archived: boolean;
  /** Live version's blob prefix (`apps/<appId>/<n>/`), null if nothing live. */
  blobPrefix: string | null;
  /** Access rule (architecture §4.2); checked at login and on every request. */
  visibilityMode: VisibilityMode;
  /**
   * The groups that may open the app — only when `visibilityMode` is `group`,
   * and **any-of**: membership in one of them is enough (ADR-0040 §5). Empty
   * when the mode is anything else, and empty is also a legal `group` state that
   * denies everyone (`visibilityAllows` fails closed on it).
   */
  visibilityGroupIds: string[];
  /**
   * scrypt hash + salt of the shared password — only when `visibilityMode` is
   * `password` (docs/features/authentication.md). The edge verifies a login
   * against these and holds nothing decryptable; the portal keeps the cleartext
   * (encrypted) for re-display. Both null otherwise.
   */
  passwordHash: string | null;
  passwordSalt: string | null;
  /**
   * The app's LLM grant (manifest `capabilities.llm`, architecture §6.3), or
   * null when the app has no LLM capability — the gateway 403s those. Parsed
   * from the `capabilities` JSON at load time; malformed JSON yields null
   * (fail-closed) rather than crashing the projection.
   */
  llm: LlmCapability | null;
  /**
   * The app's data grant (manifest `capabilities.data`, app-data design §4), or
   * null when the app has no data capability — the data gateway 403s those.
   * Parsed fail-closed exactly like `llm`.
   */
  data: DataCapability | null;
  /**
   * Approved external origins (manifest `capabilities.externalOrigins`, §6.2)
   * the app's CSP `connect-src`/`img-src` are widened to — these are **direct**
   * browser calls. Empty unless the approvals loop granted one. Fail-closed.
   */
  externalOrigins: string[];
  /**
   * The fetch-proxy grant (manifest `capabilities.fetch`): the **proxied**
   * origins the edge will route through `azx-egress`, with their secret
   * connections, plus the per-app budget and shim flag. Always present (empty
   * allowlist when the app has no fetch capability). Parsed fail-closed.
   */
  fetch: FetchProxyGrant;
  /**
   * The offline grant (manifest `capabilities.offline`, ADR-0035): the path
   * prefix the platform-owned service worker is confined to, or null when the
   * app has no grant — the worker route then serves the tombstone instead.
   * Parsed fail-closed, and the scope is **re-validated here** (below).
   */
  offline: { scope: string } | null;
}

/**
 * Normalize the `visibilityGroupIds` array column, fail-closed to `[]`.
 *
 * `node-postgres` hands back a `text[]` as a JS `string[]` with no configuration,
 * so on the happy path this is a shape assertion rather than a parse. It exists
 * because this is the only authorization-bearing field on the entry that is
 * neither constrained by a Postgres enum (like `visibility_mode`) nor already
 * run through a fail-closed helper (like everything out of `capabilities`) — and
 * an unexpected shape must deny rather than throw inside the reconcile loop and
 * strand the whole projection. `[]` denies, per `visibilityAllows`.
 */
function parseVisibilityGroupIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Extract `capabilities.llm` from the raw JSON column, fail-closed to null. */
function parseLlmCapability(capabilities: unknown): LlmCapability | null {
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const llm = (capabilities as Record<string, unknown>).llm;
  if (llm === undefined) return null;
  const parsed = LlmCapabilitySchema.safeParse(llm);
  return parsed.success ? parsed.data : null;
}

/** Extract `capabilities.data` from the raw JSON column, fail-closed to null. */
function parseDataCapability(capabilities: unknown): DataCapability | null {
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const data = (capabilities as Record<string, unknown>).data;
  if (data === undefined) return null;
  const parsed = DataCapabilitySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** Extract `capabilities.externalOrigins` from the raw JSON, fail-closed to []. */
function parseExternalOrigins(capabilities: unknown): string[] {
  const parsed = CapabilitiesSchema.safeParse(capabilities ?? {});
  return parsed.success ? parsed.data.externalOrigins : [];
}

/** Extract `capabilities.fetch` into the edge's proxy grant, fail-closed to empty. */
function parseFetchGrant(capabilities: unknown): FetchProxyGrant {
  const empty: FetchProxyGrant = { connections: new Map(), requestsPerDay: null, shim: false };
  if (typeof capabilities !== "object" || capabilities === null) return empty;
  const raw = (capabilities as Record<string, unknown>).fetch;
  if (raw === undefined) return empty;
  const parsed = FetchCapabilitySchema.safeParse(raw);
  if (!parsed.success) return empty;
  const connections = new Map<string, string | null>();
  for (const o of parsed.data.origins) {
    try {
      // Canonicalize the origin so request-time `new URL(target).origin` matches.
      connections.set(new URL(o.origin).origin, o.connection ?? null);
    } catch {
      // A malformed origin (shouldn't pass zod's url()) is simply skipped.
    }
  }
  return {
    connections,
    requestsPerDay: parsed.data.requestsPerDay ?? null,
    shim: parsed.data.shim,
  };
}

/**
 * Extract `capabilities.offline` (ADR-0035), fail-closed to null.
 *
 * The scope is validated **twice on purpose**. The portal already refused an
 * illegal one on write, but this value is about to become a
 * `Service-Worker-Allowed` response header and a serving-path prefix, and the
 * edge trusts nothing it reads out of a JSON column — a row written by an older
 * build, a migration, or a direct `UPDATE` must not be able to hand the worker
 * root scope or a platform namespace. Re-running the shared rule costs nothing;
 * `normalizeRequestPath` on top of it re-applies the edge's own traversal
 * defense to the same string, so the header and the blob key agree.
 */
function parseOfflineGrant(capabilities: unknown): { scope: string } | null {
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const raw = (capabilities as Record<string, unknown>).offline;
  if (raw === undefined) return null;
  const parsed = OfflineCapabilitySchema.safeParse(raw);
  if (!parsed.success) return null;
  const { scope } = parsed.data;
  if (!isValidServiceWorkerScope(scope)) return null;
  // A scope is a directory prefix; `normalizeRequestPath` returns it without
  // the trailing slash, so compare on the normalized form and re-add it.
  const normalized = normalizeRequestPath(scope);
  if (normalized === null || `${normalized}/` !== scope) return null;
  return { scope };
}

/**
 * Invoke a reporting observer without letting it affect the load. A load's
 * outcome must depend on the query alone — see the note at the end of
 * `#loadOnce`.
 *
 * Silent by design: the only plausible thrower is the log sink itself, so
 * reporting a logging failure through the logger is circular, and the platform
 * has no second channel (no metrics pipeline — ADR-0003). The safety net is that
 * `freshness()` now stays truthful, so `/health` still reflects reality even
 * with the sink dead. (A sink that returns a *rejected promise* is out of reach
 * here, but the `=> void` return type already forbids one.)
 */
function notify<T>(observer: (info: T) => void, info: T): void {
  try {
    observer(info);
  } catch {
    // Deliberately swallowed — see above.
  }
}

export interface RegistryReader {
  /** undefined = unknown slug. */
  getApp(slug: string): RegistryEntry | undefined;
  /** False until the first successful load — app hosts 503 until then. */
  isLoaded(): boolean;
}

/**
 * Load freshness, for `/health` and the staleness-alerting path (ADR-0025 item
 * 1). Serving stale is the deliberate failure stance, so the *only* thing that
 * makes a sustained DB failure visible is this state — without it the edge
 * serves an out-of-date access rule forever and reads green.
 *
 * Deliberately a **separate seam** from `RegistryReader`: the ~15 modules that
 * consume the registry route on `getApp`/`isLoaded` and have no business
 * knowing about freshness. Only `/health` reads this.
 */
export interface RegistryFreshness {
  /** Mirrors `isLoaded()`: false until the first success, and never cleared. */
  loaded: boolean;
  /** Wall-clock ISO of the last success; null when never loaded. Report-only. */
  lastSuccessfulLoadAt: string | null;
  /**
   * Age of the served copy in ms, measured **monotonically** — a wall-clock
   * jump (NTP step, VM migration) must not fake freshness or fake a staleness
   * alert. Null when never loaded.
   */
  staleForMs: number | null;
  /** Failures since the last success; 0 when the last load succeeded. */
  consecutiveLoadFailures: number;
  /** Wall-clock ISO of the most recent failure; null if none since boot. */
  lastLoadFailureAt: string | null;
}

export interface RegistryFreshnessReader {
  freshness(): RegistryFreshness;
}

/** Passed to `onLoadFailure` — the error plus what the operator needs with it. */
export interface RegistryLoadFailure {
  err: unknown;
  /** 1 on the first failure since the last success (the escalation trigger). */
  consecutiveLoadFailures: number;
  staleForMs: number | null;
  lastSuccessfulLoadAt: string | null;
}

/** Passed to `onLoadRecovered` — only fires when failures preceded the success. */
export interface RegistryLoadRecovery {
  failures: number;
  /** Monotonic ms the served copy was stale; null when this was the first load. */
  staleForMs: number | null;
}

/**
 * Clock seam: monotonic for age, wall-clock for the operator-facing timestamp.
 * Injected so freshness is deterministic in tests without fake timers.
 */
export interface ProjectionClock {
  monotonicMs(): number;
  wallClockIso(): string;
}

const SYSTEM_CLOCK: ProjectionClock = {
  monotonicMs: () => performance.now(),
  wallClockIso: () => new Date().toISOString(),
};

interface ProjectionRow {
  id: string;
  slug: string;
  archived: boolean;
  blob_prefix: string | null;
  /**
   * Narrow again now that the expand/contract rename is finished: the Postgres
   * enum and `VISIBILITY_MODES` are back in exact correspondence (the portal's
   * drift guard asserts it), so the database itself constrains this column to
   * the four modes and the type is accurate rather than aspirational. The gate
   * keeps its deny-by-default fall-through regardless — cheap, and the only
   * thing standing between a future label and a served request.
   */
  visibility_mode: VisibilityMode;
  visibility_group_ids: unknown;
  password_hash: string | null;
  password_salt: string | null;
  /** The `capabilities` JSONB column (pg parses it to an object). */
  capabilities: unknown;
}

/** Narrow query seam: `pg.Pool#query` shaped, fake-able in unit tests. */
export interface ProjectionQuerier {
  query(sql: string): Promise<{ rows: ProjectionRow[] }>;
}

// Prisma created camelCase columns (no @map), so identifiers must be quoted —
// unquoted they would silently lowercase and fail.
const PROJECTION_SQL = `
  SELECT a.id, a.slug, a."archivedAt" IS NOT NULL AS archived, v."blobPrefix" AS blob_prefix,
         a."visibilityMode"::text AS visibility_mode, a."visibilityGroupIds" AS visibility_group_ids,
         a."passwordHash" AS password_hash, a."passwordSalt" AS password_salt,
         a.capabilities AS capabilities
  FROM apps a
  LEFT JOIN versions v ON v.id = a."currentVersionId"
`;

// The dev-gateway (role helix_dev) reads the same registry but must NEVER read the
// prod password columns (dev-mode §5.3 — a compromise here can't touch a prod
// secret). It runs under a column-scoped GRANT that omits passwordHash/Salt/Enc,
// so its projection selects NULL for them (and touches no password column — the
// column grant would otherwise deny the query). The dev tier never serves the
// `password` login challenge, so a null hash is correct: the dev-gateway only
// needs the slug/visibility/capabilities to route `/_api/*`.
const PROJECTION_SQL_NO_PASSWORD = `
  SELECT a.id, a.slug, a."archivedAt" IS NOT NULL AS archived, v."blobPrefix" AS blob_prefix,
         a."visibilityMode"::text AS visibility_mode, a."visibilityGroupIds" AS visibility_group_ids,
         NULL::text AS password_hash, NULL::text AS password_salt,
         a.capabilities AS capabilities
  FROM apps a
  LEFT JOIN versions v ON v.id = a."currentVersionId"
`;

export class RegistryProjection implements RegistryReader, RegistryFreshnessReader {
  #querier: ProjectionQuerier;
  #sql: string;
  #map = new Map<string, RegistryEntry>();
  #loaded = false;
  #inFlight: Promise<void> | null = null;
  #dirty = false;
  #onLoadFailure: (info: RegistryLoadFailure) => void;
  #onLoadRecovered: (info: RegistryLoadRecovery) => void;
  #clock: ProjectionClock;

  // Freshness (ADR-0025). Two clocks on purpose: the monotonic one decides
  // staleness, the wall-clock one is what an operator reads.
  #lastSuccessMonoMs: number | null = null;
  #lastSuccessIso: string | null = null;
  #consecutiveLoadFailures = 0;
  #lastFailureIso: string | null = null;

  constructor(
    querier: ProjectionQuerier,
    opts: {
      onLoadFailure?: (info: RegistryLoadFailure) => void;
      onLoadRecovered?: (info: RegistryLoadRecovery) => void;
      includePasswords?: boolean;
      /** Test seam; defaults to `performance.now()` + `Date`. */
      clock?: ProjectionClock;
    } = {},
  ) {
    this.#querier = querier;
    // Default includes the password columns (the edge, which serves the password
    // login). The dev-gateway passes false — it has no column grant for them.
    this.#sql = opts.includePasswords === false ? PROJECTION_SQL_NO_PASSWORD : PROJECTION_SQL;
    this.#onLoadFailure = opts.onLoadFailure ?? (() => {});
    this.#onLoadRecovered = opts.onLoadRecovered ?? (() => {});
    this.#clock = opts.clock ?? SYSTEM_CLOCK;
  }

  getApp(slug: string): RegistryEntry | undefined {
    return this.#map.get(slug);
  }

  isLoaded(): boolean {
    return this.#loaded;
  }

  freshness(): RegistryFreshness {
    return {
      loaded: this.#loaded,
      lastSuccessfulLoadAt: this.#lastSuccessIso,
      staleForMs: this.#staleForMs(),
      consecutiveLoadFailures: this.#consecutiveLoadFailures,
      lastLoadFailureAt: this.#lastFailureIso,
    };
  }

  #staleForMs(): number | null {
    if (this.#lastSuccessMonoMs === null) return null;
    // Monotonic, so a backwards wall clock can't report the copy as fresh.
    return Math.max(0, Math.round(this.#clock.monotonicMs() - this.#lastSuccessMonoMs));
  }

  /**
   * Reload the projection. Loads are serialized: a call during an in-flight
   * load marks it dirty and piggybacks on exactly one follow-up load, so a
   * burst of NOTIFYs collapses instead of stampeding the DB.
   *
   * **Never rejects.** A DB failure is absorbed into the freshness state (serve
   * stale — architecture §7) and a throwing observer is contained by `notify`.
   * That is what makes the `void load()` calls on the listener's NOTIFY and
   * reconcile paths safe, and `LiveRegistry.start()` unable to fail on a down
   * DB — an invariant to preserve, not an accident.
   */
  load(): Promise<void> {
    if (this.#inFlight) {
      this.#dirty = true;
      return this.#inFlight;
    }
    this.#inFlight = this.#loadOnce().finally(() => {
      this.#inFlight = null;
      if (this.#dirty) {
        this.#dirty = false;
        void this.load();
      }
    });
    return this.#inFlight;
  }

  async #loadOnce(): Promise<void> {
    // Decided inside the try, REPORTED after it — see the note below the catch.
    // At most one of these is ever set.
    let recovery: RegistryLoadRecovery | null = null;
    let failure: RegistryLoadFailure | null = null;
    try {
      const { rows } = await this.#querier.query(this.#sql);
      // Build fresh, swap atomically (single assignment — no torn reads).
      const next = new Map<string, RegistryEntry>();
      for (const row of rows) {
        next.set(row.slug, {
          appId: row.id,
          slug: row.slug,
          archived: row.archived,
          blobPrefix: row.blob_prefix,
          visibilityMode: row.visibility_mode,
          visibilityGroupIds: parseVisibilityGroupIds(row.visibility_group_ids),
          passwordHash: row.password_hash,
          passwordSalt: row.password_salt,
          llm: parseLlmCapability(row.capabilities),
          data: parseDataCapability(row.capabilities),
          externalOrigins: parseExternalOrigins(row.capabilities),
          fetch: parseFetchGrant(row.capabilities),
          offline: parseOfflineGrant(row.capabilities),
        });
      }
      this.#map = next;
      this.#loaded = true;
      // Freshness bookkeeping: capture the pre-swap state before restamping, so
      // a recovery can report how long the stale copy was served.
      const failures = this.#consecutiveLoadFailures;
      const staleForMs = this.#staleForMs();
      this.#lastSuccessMonoMs = this.#clock.monotonicMs();
      this.#lastSuccessIso = this.#clock.wallClockIso();
      this.#consecutiveLoadFailures = 0;
      if (failures > 0) recovery = { failures, staleForMs };
    } catch (err) {
      // Keep serving the previous map (stale beats down — architecture §7).
      // `#loaded` deliberately stays true: flipping it back would 503 every app
      // host on a transient DB blip, the opposite of the serve-stale stance.
      // The counter + timestamps are what make the failure visible instead.
      this.#consecutiveLoadFailures += 1;
      this.#lastFailureIso = this.#clock.wallClockIso();
      failure = {
        err,
        consecutiveLoadFailures: this.#consecutiveLoadFailures,
        staleForMs: this.#staleForMs(),
        lastSuccessfulLoadAt: this.#lastSuccessIso,
      };
    }
    // Observers run OUTSIDE the try, through a non-throwing boundary, so they
    // can never change the load's outcome. They used to run inside it, where a
    // throwing sink (a dead log destination) would drop a **successful** load
    // into the catch — incrementing the failure counter and reporting a failure
    // for a load that worked, i.e. corrupting the one state `/health` and the
    // alert ladder read. It reported `consecutiveLoadFailures: 1` with
    // `staleForMs: ~0`, which the listener routes to the `error`-level
    // first-failure line: a page for a perfectly fresh projection. A throwing
    // observer could also reject `load()`, which rejects `LiveRegistry.start()`
    // and becomes an unhandled rejection on the `void`-ed timer paths.
    if (recovery !== null)
      notify((info: RegistryLoadRecovery) => this.#onLoadRecovered(info), recovery);
    if (failure !== null) notify((info: RegistryLoadFailure) => this.#onLoadFailure(info), failure);
  }
}
