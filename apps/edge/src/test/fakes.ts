import { Readable } from "node:stream";
import type { BlobGetOptions, BlobGetResult, BlobReader } from "../blob/client.js";
import type { RegistryEntry, RegistryReader } from "../registry/projection.js";
import type { Session, SessionStore } from "../auth/sessions.js";
import type {
  AuthorizeParams,
  ExchangeChecks,
  ExchangeOutcome,
  OidcClient,
  OidcIdentity,
} from "../auth/oidc.js";

/** A full RegistryEntry from a partial — private visibility by default. */
export function registryEntry(overrides: Partial<RegistryEntry> & { slug: string }): RegistryEntry {
  return {
    appId: "00000000-0000-4000-8000-000000000000",
    archived: false,
    blobPrefix: null,
    visibilityMode: "private",
    visibilityGroupId: null,
    ...overrides,
  };
}

/** In-memory registry for unit tests. */
export class FakeRegistry implements RegistryReader {
  #entries = new Map<string, RegistryEntry>();
  #loaded: boolean;

  constructor(entries: RegistryEntry[] = [], opts: { loaded?: boolean } = {}) {
    for (const entry of entries) this.#entries.set(entry.slug, entry);
    this.#loaded = opts.loaded ?? true;
  }

  getApp(slug: string): RegistryEntry | undefined {
    return this.#entries.get(slug);
  }

  isLoaded(): boolean {
    return this.#loaded;
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
