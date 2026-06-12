import type { Readable } from "node:stream";
import type { BlobStore, PutObjectOptions } from "../blob/store.js";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export interface StoredObject {
  body: Buffer;
  contentType?: string;
}

/** A BlobStore that keeps objects in a Map — for route/logic tests. */
export class InMemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, StoredObject>();

  async putObject(key: string, body: Readable | Buffer, opts?: PutObjectOptions): Promise<void> {
    if (opts?.ifNoneMatch === "*" && this.objects.has(key)) {
      throw new Error(`blob already exists: ${key}`);
    }
    const buf = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    this.objects.set(key, { body: buf, contentType: opts?.contentType });
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  /** Keys under a given prefix (test convenience). */
  keysUnder(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
