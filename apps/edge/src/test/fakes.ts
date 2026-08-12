import { Readable } from "node:stream";
import type { LlmChatRequest, LlmUsage } from "@azx-pbc/shared";
import type { BlobGetOptions, BlobGetResult, BlobReader } from "../blob/client.js";
import type {
  RegistryEntry,
  RegistryFreshness,
  RegistryFreshnessReader,
  RegistryReader,
} from "../registry/projection.js";
import type { LlmProvider, LlmStreamEvent } from "../gateway/provider.js";
import type { GatewayCallRecord, LlmSpend, UsageStore } from "../gateway/usage.js";
import type { AppDataStore, CollectionMeta, UserKeyMeta } from "../gateway/data.js";
import type { Session, SessionStore } from "../auth/sessions.js";
import type {
  AuthorizeParams,
  ExchangeChecks,
  ExchangeOutcome,
  OidcClient,
  OidcIdentity,
} from "../auth/oidc.js";

/** A full RegistryEntry from a partial — internal visibility by default. */
export function registryEntry(overrides: Partial<RegistryEntry> & { slug: string }): RegistryEntry {
  return {
    appId: "00000000-0000-4000-8000-000000000000",
    archived: false,
    blobPrefix: null,
    visibilityMode: "internal",
    visibilityGroupId: null,
    passwordHash: null,
    passwordSalt: null,
    llm: null,
    data: null,
    externalOrigins: [],
    fetch: { connections: new Map(), requestsPerDay: null, shim: false },
    offline: null,
    ...overrides,
  };
}

/** In-memory registry for unit tests. */
export class FakeRegistry implements RegistryReader, RegistryFreshnessReader {
  #entries = new Map<string, RegistryEntry>();
  #loaded: boolean;
  /**
   * Mutable so a test can age a loaded registry mid-flight (`/health` degrades
   * off this). Defaults to "loaded just now", which keeps every existing
   * buildApp test reporting `ok`.
   */
  freshnessOverride: Partial<RegistryFreshness>;

  constructor(
    entries: RegistryEntry[] = [],
    opts: { loaded?: boolean; freshness?: Partial<RegistryFreshness> } = {},
  ) {
    for (const entry of entries) this.#entries.set(entry.slug, entry);
    this.#loaded = opts.loaded ?? true;
    this.freshnessOverride = opts.freshness ?? {};
  }

  getApp(slug: string): RegistryEntry | undefined {
    return this.#entries.get(slug);
  }

  isLoaded(): boolean {
    return this.#loaded;
  }

  freshness(): RegistryFreshness {
    const loaded = this.#loaded;
    return {
      loaded,
      lastSuccessfulLoadAt: loaded ? "2026-07-30T12:00:00.000Z" : null,
      staleForMs: loaded ? 0 : null,
      consecutiveLoadFailures: 0,
      lastLoadFailureAt: null,
      ...this.freshnessOverride,
    };
  }
}

export interface FakeBlob {
  body: Buffer | string;
  contentType?: string;
  etag?: string;
}

/** In-memory blob store mirroring UndiciBlobReader's result mapping. */
export class FakeBlobReader implements BlobReader {
  #blobs = new Map<string, Required<FakeBlob>>();
  /** Every key requested, in order — lets tests assert fallback behavior. */
  readonly requests: string[] = [];

  set(key: string, blob: FakeBlob): void {
    this.#blobs.set(key, {
      body: Buffer.isBuffer(blob.body) ? blob.body : Buffer.from(blob.body),
      contentType: blob.contentType ?? "application/octet-stream",
      etag: blob.etag ?? `"etag-${this.#blobs.size + 1}"`,
    });
  }

  async get(key: string, opts: BlobGetOptions): Promise<BlobGetResult> {
    this.requests.push(key);
    const blob = this.#blobs.get(key);
    if (!blob) return { kind: "not-found" };
    if (opts.ifNoneMatch && opts.ifNoneMatch === blob.etag) {
      return { kind: "not-modified", etag: blob.etag };
    }
    return {
      kind: "found",
      contentType: blob.contentType,
      contentLength: String(blob.body.length),
      etag: blob.etag,
      body: Readable.from(opts.method === "HEAD" ? [] : [blob.body]),
    };
  }

  async close(): Promise<void> {}
}

/**
 * Scripted LLM provider for unit/adversarial tests — never touches the network.
 * Yields the configured text deltas then a `done` event; `onDelta` lets a test
 * interleave or observe mid-stream (used to prove finish-in-flight).
 */
export class FakeLlmProvider implements LlmProvider {
  /** Requests seen, for assertions (model, messages, etc.). */
  readonly calls: LlmChatRequest[] = [];
  deltas: string[] = ["Hello", " world"];
  usage: LlmUsage = {
    inputTokens: 5,
    outputTokens: 2,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  stopReason = "end_turn";
  /** When set, stream() throws before yielding anything. */
  error: Error | null = null;
  /** Awaited before each delta — a hook for interleaving/observation. */
  onDelta?: (index: number) => Promise<void> | void;

  async *stream(req: LlmChatRequest, opts: { signal: AbortSignal }): AsyncIterable<LlmStreamEvent> {
    this.calls.push(req);
    if (this.error) throw this.error;
    let index = 0;
    for (const text of this.deltas) {
      if (opts.signal.aborted) return;
      await this.onDelta?.(index++);
      yield { type: "delta", text };
    }
    yield { type: "done", stopReason: this.stopReason, usage: this.usage };
  }

  async close(): Promise<void> {}
}

/** In-memory gateway ledger for tests; spend overrides drive quota decisions. */
export class FakeUsageStore implements UsageStore {
  readonly records: GatewayCallRecord[] = [];

  /** Override to force the daily LLM spend gate (micro-USD); else summed live. */
  spendTodayMicro?: number;
  /** Override to force the rolling-hour burst gate (micro-USD); else summed live. */
  spendHourMicro?: number;

  async llmSpendMicroUsd(): Promise<LlmSpend> {
    const summed = this.records
      .filter((r) => r.capability === "llm")
      .reduce((n, r) => n + (r.costMicroUsd ?? 0), 0);
    return {
      todayMicro: this.spendTodayMicro ?? summed,
      hourMicro: this.spendHourMicro ?? summed,
    };
  }

  /** Override in a test to force the writesPerDay budget; defaults to the live count. */
  writesToday?: number;

  async dataWritesToday(): Promise<number> {
    if (this.writesToday !== undefined) return this.writesToday;
    return this.records.filter(
      (r) =>
        r.capability === "data" &&
        r.outcome === "ok" &&
        ["user.put", "collection.append", "shared.put"].includes(r.model),
    ).length;
  }

  /** Override in a test to force the requestsPerDay budget; defaults to the live count. */
  fetchToday?: number;

  async fetchRequestsToday(): Promise<number> {
    if (this.fetchToday !== undefined) return this.fetchToday;
    return this.records.filter((r) => r.capability === "fetch" && r.outcome !== "quota_blocked")
      .length;
  }

  async record(call: GatewayCallRecord): Promise<void> {
    this.records.push(call);
  }

  async close(): Promise<void> {}
}

/**
 * In-memory app-data store. Mirrors PgAppDataStore's caller-scoped contract:
 * keyed strictly by (appId, userOid, key), so a test can never accidentally
 * reach across the partition — the same property the RLS policy enforces in
 * Postgres. Like the real store, it has no collection-enumeration method.
 */
export class FakeAppDataStore implements AppDataStore {
  readonly rows = new Map<string, { value: unknown; updatedAt: string }>();

  #k(appId: string, userOid: string, key: string): string {
    return `${appId} ${userOid} ${key}`;
  }

  async getUserKey(appId: string, userOid: string, key: string): Promise<unknown> {
    return this.rows.get(this.#k(appId, userOid, key))?.value ?? null;
  }

  async putUserKey(appId: string, userOid: string, key: string, value: unknown): Promise<string> {
    const updatedAt = new Date().toISOString();
    this.rows.set(this.#k(appId, userOid, key), { value, updatedAt });
    return updatedAt;
  }

  async deleteUserKey(appId: string, userOid: string, key: string): Promise<boolean> {
    return this.rows.delete(this.#k(appId, userOid, key));
  }

  async listUserKeys(appId: string, userOid: string): Promise<UserKeyMeta[]> {
    const prefix = `${appId} ${userOid} `;
    const out: UserKeyMeta[] = [];
    for (const [k, v] of this.rows) {
      if (k.startsWith(prefix)) out.push({ key: k.slice(prefix.length), updatedAt: v.updatedAt });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Appended collection items — write-only, mirroring the real store (no read API). */
  readonly collectionItems: {
    appId: string;
    collection: string;
    item: unknown;
    userOid: string | null;
    meta: CollectionMeta;
  }[] = [];

  async appendCollection(
    appId: string,
    collection: string,
    item: unknown,
    userOid: string | null,
    meta: CollectionMeta,
  ): Promise<void> {
    this.collectionItems.push({ appId, collection, item, userOid, meta });
  }

  #sharedKey(appId: string, key: string): string {
    return `${appId}  shared ${key}`;
  }

  async getShared(appId: string, key: string): Promise<unknown> {
    return this.rows.get(this.#sharedKey(appId, key))?.value ?? null;
  }

  async putShared(appId: string, key: string, value: unknown): Promise<string> {
    const updatedAt = new Date().toISOString();
    this.rows.set(this.#sharedKey(appId, key), { value, updatedAt });
    return updatedAt;
  }

  async close(): Promise<void> {}
}

/**
 * Scripted IdP for unit tests. Mimics the real client's contract: the
 * callback URL's `state` must match the expected state, `code` must be
 * present, and `error=login_required` maps to interaction-required.
 */
export class FakeOidcClient implements OidcClient {
  ready = true;
  /** Identity a successful exchange yields. */
  identity: OidcIdentity = { oid: "oid-alice", displayName: "Alice Anders", groups: ["eng-team"] };
  /** When set, exchangeCode returns this unconditionally. */
  forcedOutcome: ExchangeOutcome | null = null;
  readonly authorizeRequests: AuthorizeParams[] = [];

  isReady(): boolean {
    return this.ready;
  }

  authorizationUrl(params: AuthorizeParams): string {
    this.authorizeRequests.push(params);
    const url = new URL("https://idp.example/authorize");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    if (params.prompt) url.searchParams.set("prompt", params.prompt);
    return url.toString();
  }

  async exchangeCode(callbackUrl: URL, checks: ExchangeChecks): Promise<ExchangeOutcome> {
    if (this.forcedOutcome) return this.forcedOutcome;
    const error = callbackUrl.searchParams.get("error");
    if (error) {
      return error === "login_required" ? { kind: "interaction-required" } : { kind: "invalid" };
    }
    const state = callbackUrl.searchParams.get("state");
    const code = callbackUrl.searchParams.get("code");
    if (!code || state === null || state !== checks.state) {
      return { kind: "invalid" };
    }
    return { kind: "ok", identity: this.identity };
  }
}

/** In-memory SessionStore mirroring PgSessionStore's semantics. */
export class FakeSessionStore implements SessionStore {
  /** Pending rows by id; redeemed rows also indexed by token hash. */
  readonly byId = new Map<string, Session & { tokenHash: string | null }>();

  async createPending(session: Session): Promise<void> {
    if (this.byId.has(session.id)) throw new Error(`duplicate session id ${session.id}`);
    this.byId.set(session.id, { ...session, tokenHash: null });
  }

  async createActive(session: Session, tokenHash: string): Promise<void> {
    if (this.byId.has(session.id)) throw new Error(`duplicate session id ${session.id}`);
    this.byId.set(session.id, { ...session, tokenHash });
  }

  async redeem(id: string, appId: string, tokenHash: string): Promise<boolean> {
    const row = this.byId.get(id);
    if (!row || row.tokenHash !== null || row.appId !== appId || row.expiresAt <= new Date()) {
      return false;
    }
    row.tokenHash = tokenHash;
    return true;
  }

  async lookup(tokenHash: string, appId: string): Promise<Session | null> {
    for (const row of this.byId.values()) {
      if (row.tokenHash === tokenHash && row.appId === appId && row.expiresAt > new Date()) {
        return {
          id: row.id,
          appId: row.appId,
          user: row.user,
          refreshDueAt: row.refreshDueAt,
          expiresAt: row.expiresAt,
        };
      }
    }
    return null;
  }

  async delete(tokenHash: string, appId: string): Promise<void> {
    for (const [id, row] of this.byId) {
      if (row.tokenHash === tokenHash && row.appId === appId) this.byId.delete(id);
    }
  }

  async sweep(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {}
}
