import { Readable } from "node:stream";
import type { BlobGetOptions, BlobGetResult, BlobReader } from "../blob/client.js";
import type { RegistryEntry, RegistryReader } from "../registry/projection.js";

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
