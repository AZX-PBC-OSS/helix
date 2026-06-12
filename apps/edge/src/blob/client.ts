import type { Readable } from "node:stream";
import { Pool } from "undici";
import type { AzureBlobConfig, BlobConfig } from "../config.js";
import { signRequest } from "./signing.js";

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

/** Build the reader for the configured provider (Azure-only in v0). */
export function createBlobReader(config: BlobConfig): BlobReader {
  switch (config.provider) {
    case "azure":
      return new UndiciBlobReader(config);
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

  constructor(config: AzureBlobConfig) {
    this.#config = config;
    const endpoint = new URL(config.endpoint);
    this.#pool = new Pool(endpoint.origin);
    this.#basePath = endpoint.pathname.replace(/\/+$/, "");
  }

  async get(key: string, opts: BlobGetOptions): Promise<BlobGetResult> {
    // Encode each segment, keeping `/` separators — blob keys are path-shaped.
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const path = `${this.#basePath}/${this.#config.container}/${encodedKey}`;
    const url = new URL(path, this.#config.endpoint);

    const headers = signRequest({
      method: opts.method,
      url,
      accountName: this.#config.accountName,
      accountKey: this.#config.accountKey,
      headers: opts.ifNoneMatch ? { ifNoneMatch: opts.ifNoneMatch } : undefined,
    });

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
  }
}
