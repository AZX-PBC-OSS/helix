import type { Readable } from "node:stream";
import { Pool } from "undici";
import type { AzureBlobConfig, BlobConfig } from "../config.js";
import { signRequest, X_MS_VERSION } from "./signing.js";
import { ManagedIdentityTokenProvider, type TokenProvider } from "./token.js";

/**
 * Read-side blob access for asset serving (architecture §4.3). Deliberately
 * separate from the portal's write-side BlobStore: the portal uses the Azure
 * SDK; the edge streams over undici with hand-rolled signing (project plan §1).
 */
export type BlobGetResult =
  | {
      kind: "found";
      contentType?: string;
      contentLength?: string;
      etag?: string;
      lastModified?: string;
      /** The streaming body. Empty (but present) for HEAD. */
      body: Readable;
    }
  | { kind: "not-modified"; etag?: string }
  | { kind: "not-found" };

export interface BlobGetOptions {
  method: "GET" | "HEAD";
  /** Client validator to forward — the only client header that goes upstream. */
  ifNoneMatch?: string;
}

export interface BlobReader {
  get(key: string, opts: BlobGetOptions): Promise<BlobGetResult>;
  close(): Promise<void>;
}

/**
 * Build the reader for the configured provider (Azure-only in v0). The optional
 * `tokenProvider` is an injection seam for tests on the managed-identity path;
 * production leaves it undefined and the reader constructs its own.
 */
export function createBlobReader(config: BlobConfig, tokenProvider?: TokenProvider): BlobReader {
  switch (config.provider) {
    case "azure":
      return new UndiciBlobReader(config, tokenProvider);
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Streams blobs from Azure Blob Storage / Azurite via undici. */
export class UndiciBlobReader implements BlobReader {
  #config: AzureBlobConfig;
  #pool: Pool;
  /** Path prefix carried by the endpoint itself (Azurite: /devstoreaccount1). */
  #basePath: string;
  /** Present only on the managed-identity path; null for SharedKey (dev). */
  #token: TokenProvider | null;

  constructor(config: AzureBlobConfig, tokenProvider?: TokenProvider) {
    this.#config = config;
    const endpoint = new URL(config.endpoint);
    this.#pool = new Pool(endpoint.origin);
    this.#basePath = endpoint.pathname.replace(/\/+$/, "");
    if (config.auth.mode === "managed-identity") {
      this.#token =
        tokenProvider ??
        new ManagedIdentityTokenProvider({
          identityEndpoint: config.auth.identityEndpoint,
          identityHeader: config.auth.identityHeader,
          clientId: config.auth.clientId,
        });
    } else {
      this.#token = null;
    }
  }

  async get(key: string, opts: BlobGetOptions): Promise<BlobGetResult> {
    // Encode each segment, keeping `/` separators — blob keys are path-shaped.
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const path = `${this.#basePath}/${this.#config.container}/${encodedKey}`;
    const url = new URL(path, this.#config.endpoint);

    const auth = this.#config.auth;
    let headers: Record<string, string>;
    if (auth.mode === "shared-key") {
      headers = signRequest({
        method: opts.method,
        url,
        accountName: auth.accountName,
        accountKey: auth.accountKey,
        headers: opts.ifNoneMatch ? { ifNoneMatch: opts.ifNoneMatch } : undefined,
      });
    } else {
      // Managed-identity bearer. x-ms-date is deliberately omitted: it only
      // matters as a *signed* SharedKey header. x-ms-version is still required
      // (OAuth needs >= 2017-11-09; we reuse the pinned SharedKey version).
      const token = await this.#token!.getToken();
      headers = {
        authorization: `Bearer ${token}`,
        "x-ms-version": X_MS_VERSION,
        ...(opts.ifNoneMatch ? { "if-none-match": opts.ifNoneMatch } : {}),
      };
    }

    const res = await this.#pool.request({ method: opts.method, path, headers });

    if (res.statusCode === 200) {
      // Forward only the standard content headers; x-ms-* never leaves here.
      return {
        kind: "found",
        contentType: headerValue(res.headers["content-type"]),
        contentLength: headerValue(res.headers["content-length"]),
        etag: headerValue(res.headers.etag),
        lastModified: headerValue(res.headers["last-modified"]),
        body: res.body,
      };
    }

    // Non-200: always drain the body or the pooled connection leaks.
    await res.body.dump();
    if (res.statusCode === 304) {
      return { kind: "not-modified", etag: headerValue(res.headers.etag) };
    }
    if (res.statusCode === 404) {
      return { kind: "not-found" };
    }
    throw new Error(`blob request failed: ${opts.method} ${path} -> ${res.statusCode}`);
  }

  async close(): Promise<void> {
    await this.#pool.close();
    await this.#token?.close();
  }
}
