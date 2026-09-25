/**
 * The egress provider-config cache (I-02 ADR-0011): an in-memory snapshot of
 * the `connection_providers` table, loaded from Postgres with hand-written SQL
 * under the `helix_egress` role — which holds SELECT on that table and nothing
 * else about providers (ADR-0006 part 2). The listener reads, never writes.
 *
 * Entries are the stored row parsed through `ConnectionProviderSchema` — the
 * one stored-row contract (including the sealed `clientIdMaterial` /
 * `clientSecretMaterial` exchange and renewal open). The credential-free
 * metadata view consumers like the catalogue checks need is the same parse
 * with the two material fields omitted (`ProviderMetadataSchema`), so one
 * parse serves both shapes. A row that fails the parse is dropped and
 * reported, never cached as valid — fail closed, like every read of
 * DB-shaped JSON in this platform.
 *
 * Cache mutation is **wholesale replacement per revision**: each load builds
 * fresh indexes and swaps them in with a single assignment, and every entry is
 * an immutable parsed snapshot. A consumer holding a row across a reconcile
 * keeps a complete, unmutated view of the revision it read; the new revision
 * is a new object. Old revisions drop with the rebuild — the cache holds one
 * entry per current provider row (the table is administrator-bounded), never
 * a per-revision history.
 */
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  ATTR_OUTCOME,
  ATTR_PROVIDERS,
  PROVIDERS_RECONCILE_OUTCOMES,
  SPAN_PROVIDERS_RECONCILE,
} from "@azx-pbc/shared/telemetry";
import { ConnectionProviderSchema, type ConnectionProvider, type Env } from "@azx-pbc/shared";

import { instruments, tracer } from "./telemetry.js";

/**
 * The cache's read surface — the seam exchange (T-0019), renewal (T-0021),
 * resolution/availability (T-0022) and the delegated call path (T-0025)
 * consume. Every lookup is a synchronous in-memory map read: nothing here can
 * block the proxy hot path on the listener's health.
 */
export interface ProviderCacheReader {
  /**
   * The provider row at its **current** revision, or undefined when the id is
   * unknown or the provider was deleted (deletion is a hard DELETE — the next
   * reconcile drops the entry, and lookups fail closed immediately after).
   */
  get(providerId: string): ConnectionProvider | undefined;
  /**
   * The `(ref, env)` lookup — the key manifests bind on (`@@unique([ref, env])`).
   */
  getByRef(ref: string, env: Env): ConnectionProvider | undefined;
  /** False until the first successful load. */
  isLoaded(): boolean;
}

export interface ProviderLoadFailure {
  err: unknown;
  /** 1 on the first failure since the last success. */
  consecutiveLoadFailures: number;
  /** True while no load has ever succeeded (the cold-start state). */
  neverLoaded: boolean;
}

export interface ProviderLoadRecovery {
  /** Failures that preceded the success. */
  failures: number;
}

/**
 * One dropped row. `reason` names the schema paths that failed — field paths
 * only, never values: a rejected row's fields are configuration, but a value
 * has no place in a retained log this close to credential-bearing material.
 */
export interface ProviderRowDropped {
  reason: string;
}

export interface ProviderCacheOpts {
  onLoadFailure?: (info: ProviderLoadFailure) => void;
  onLoadRecovered?: (info: ProviderLoadRecovery) => void;
  onRowDropped?: (info: ProviderRowDropped) => void;
}

/** Narrow query seam: `pg.Pool#query` shaped, fake-able in unit tests. */
export interface ProviderQuerier {
  query(sql: string): Promise<{ rows: ProviderRow[] }>;
}

/** The raw row shape `SELECT` hands back, before the schema parse. */
export interface ProviderRow {
  id: string;
  ref: string;
  kind: string;
  displayName: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  /** The `requestedScopes` JSONB column (pg parses it). */
  requestedScopes: unknown;
  apiOrigins: unknown;
  tokenPlacement: unknown;
  env: string;
  clientIdMaterial: string;
  clientSecretMaterial: string;
  revision: number;
  /** pg hands `timestamp` columns back as `Date`; the schema wants ISO text. */
  createdAt: unknown;
  updatedAt: unknown;
}

// The exact stored-row shape — `ConnectionProviderSchema` is strict, so the
// SELECT must carry exactly these columns and no others.
const PROVIDERS_SQL = `
  SELECT id, ref, kind, "displayName", "authorizeEndpoint", "tokenEndpoint",
         "requestedScopes", "apiOrigins", "tokenPlacement", env,
         "clientIdMaterial", "clientSecretMaterial", revision, "createdAt", "updatedAt"
  FROM connection_providers
`;

function isoValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Parse one raw row, fail-closed: `{ row }` on success, `{ reason }` to drop. */
function parseProviderRow(row: ProviderRow): { row: ConnectionProvider } | { reason: string } {
  const parsed = ConnectionProviderSchema.safeParse({
    ...row,
    createdAt: isoValue(row.createdAt),
    updatedAt: isoValue(row.updatedAt),
  });
  if (parsed.success) return { row: parsed.data };
  // Field paths only, never values — a rejected row sits beside credential
  // material, and a log is a retained backend.
  const reason = parsed.error.issues
    .slice(0, 5)
    .map((i) => i.path.join(".") || "(root)")
    .join(",");
  return { reason };
}

/** The `(ref, env)` index key — `ref` is `[a-z0-9-]` and `env` is `prod|dev`. */
function refKey(ref: string, env: Env): string {
  return `${ref}:${env}`;
}

/**
 * Invoke a reporting observer without letting it affect the load — the same
 * non-throwing boundary `RegistryProjection` draws: a reporting sink must never
 * turn a successful load into a failure or reject a `void`-ed caller.
 */
function notify<T>(observer: (info: T) => void, info: T): void {
  try {
    observer(info);
  } catch {
    // Deliberately swallowed — the reporting destination is down; the load is not.
  }
}

export class ProviderCache implements ProviderCacheReader {
  #querier: ProviderQuerier;
  #byId = new Map<string, ConnectionProvider>();
  #byRef = new Map<string, ConnectionProvider>();
  #loaded = false;
  #inFlight: Promise<void> | null = null;
  #dirty = false;
  #consecutiveLoadFailures = 0;
  readonly #onLoadFailure: (info: ProviderLoadFailure) => void;
  readonly #onLoadRecovered: (info: ProviderLoadRecovery) => void;
  readonly #onRowDropped: (info: ProviderRowDropped) => void;

  constructor(querier: ProviderQuerier, opts: ProviderCacheOpts = {}) {
    this.#querier = querier;
    this.#onLoadFailure = opts.onLoadFailure ?? (() => {});
    this.#onLoadRecovered = opts.onLoadRecovered ?? (() => {});
    this.#onRowDropped = opts.onRowDropped ?? (() => {});
  }

  get(providerId: string): ConnectionProvider | undefined {
    return this.#byId.get(providerId);
  }

  getByRef(ref: string, env: Env): ConnectionProvider | undefined {
    return this.#byRef.get(refKey(ref, env));
  }

  isLoaded(): boolean {
    return this.#loaded;
  }

  /**
   * Reload the cache. Loads are serialized: a call during an in-flight load
   * marks it dirty and piggybacks on exactly one follow-up load, so a burst of
   * NOTIFYs (one per statement in a transaction) collapses into one query.
   *
   * **Never rejects** — a DB failure is absorbed into the load-failure
   * reporting while the previous snapshot keeps serving (stale beats down).
   * That is what makes the `void load()` calls on the listener's NOTIFY,
   * reconnect and reconcile paths safe, and `start()` unable to fail on a
   * down DB. An invariant to preserve, not an accident.
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
    // Decided inside the try, REPORTED after it — observers run outside so they
    // can never change the load's own outcome.
    let recovery: ProviderLoadRecovery | null = null;
    let failure: ProviderLoadFailure | null = null;
    // INTERNAL, and NOT a root span: a NOTIFY-triggered reload has no parent,
    // and nothing here grafts a trace from an untrusted caller (egress extracts
    // context only on the proxy hop's own terms).
    const span = tracer.startSpan(SPAN_PROVIDERS_RECONCILE, { kind: SpanKind.INTERNAL });
    try {
      const { rows } = await this.#querier.query(PROVIDERS_SQL);
      // Build fresh, swap atomically (single assignment per index — no torn
      // reads, no in-place mutation of entries another flow is reading).
      const byId = new Map<string, ConnectionProvider>();
      const byRef = new Map<string, ConnectionProvider>();
      let dropped = 0;
      for (const row of rows) {
        const parsed = parseProviderRow(row);
        if ("reason" in parsed) {
          dropped += 1;
          notify(this.#onRowDropped, { reason: parsed.reason });
          continue;
        }
        byId.set(parsed.row.id, parsed.row);
        byRef.set(refKey(parsed.row.ref, parsed.row.env), parsed.row);
      }
      this.#byId = byId;
      this.#byRef = byRef;
      this.#loaded = true;
      span.setAttribute(ATTR_PROVIDERS, byId.size);
      if (dropped > 0) span.setAttribute(`${ATTR_PROVIDERS}.dropped`, dropped);
      span.setAttribute(ATTR_OUTCOME, "ok");
      instruments().providersReconciles.add(1, {
        [ATTR_OUTCOME]: PROVIDERS_RECONCILE_OUTCOMES[0],
      });
      const failures = this.#consecutiveLoadFailures;
      this.#consecutiveLoadFailures = 0;
      if (failures > 0) recovery = { failures };
    } catch (err) {
      // Keep serving the previous snapshot (stale beats down). `#loaded`
      // deliberately stays true: a transient DB blip must not flip every
      // provider lookup to fail-closed while the copy it holds is fine.
      this.#consecutiveLoadFailures += 1;
      failure = {
        err,
        consecutiveLoadFailures: this.#consecutiveLoadFailures,
        neverLoaded: !this.#loaded,
      };
      span.setAttribute(ATTR_OUTCOME, PROVIDERS_RECONCILE_OUTCOMES[1]);
      span.setStatus({ code: SpanStatusCode.ERROR });
      // No recordException — egress spans carry no exception text (its error
      // paths can embed credential material; the same rule the proxy follows).
      instruments().providersReconciles.add(1, {
        [ATTR_OUTCOME]: PROVIDERS_RECONCILE_OUTCOMES[1],
      });
    } finally {
      span.end();
    }
    if (recovery !== null) notify(this.#onLoadRecovered, recovery);
    if (failure !== null) notify(this.#onLoadFailure, failure);
  }
}
