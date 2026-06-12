import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UndiciBlobReader } from "./client.js";
import { TestBlobWriter, testBlobConfig } from "../test/seed.js";

// Runs against the dev container's Azurite — proves the SharedKey signer and
// the undici reader against a real validator (signing.test.ts only pins the
// canonical string layout).
//
// Probe once and skip loudly (same stance as the portal's store.test.ts): a
// container whose env predates the docker-compose Azurite fixes would
// otherwise fail the whole suite.
let skipReason = "";
try {
  const probe = new UndiciBlobReader(testBlobConfig());
  try {
    await probe.get(`probe/${randomUUID()}`, { method: "HEAD" });
  } finally {
    await probe.close();
  }
} catch (err) {
  skipReason = (err instanceof Error ? err.message.split("\n")[0] : String(err)) || "azurite error";
}
if (skipReason) {
  console.warn(`[client.integration.test] skipping Azurite integration tests: ${skipReason}`);
}

const KEY = `apps/${randomUUID()}/1/index.html`;
const BODY = "<!doctype html><body>edge integration</body>";

let writer: TestBlobWriter | undefined;
let reader: UndiciBlobReader | undefined;

beforeAll(async () => {
  if (skipReason) return;
  writer = new TestBlobWriter();
  reader = new UndiciBlobReader(testBlobConfig());
  await writer.put(KEY, BODY, "text/html; charset=utf-8");
});

afterAll(async () => {
  await writer?.close();
  await reader?.close();
});

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

describe.skipIf(skipReason)("UndiciBlobReader against Azurite", () => {
  it("GETs a blob with its stored content type and etag", async () => {
    const res = await reader!.get(KEY, { method: "GET" });
    expect(res.kind).toBe("found");
    if (res.kind !== "found") return;
    expect(res.contentType).toBe("text/html; charset=utf-8");
    expect(res.etag).toBeTruthy();
    expect(await readAll(res.body)).toBe(BODY);
  });

  it("HEADs a blob: headers only, empty body", async () => {
    const res = await reader!.get(KEY, { method: "HEAD" });
    expect(res.kind).toBe("found");
    if (res.kind !== "found") return;
    expect(res.contentLength).toBe(String(Buffer.byteLength(BODY)));
    expect(await readAll(res.body)).toBe("");
  });

  it("returns not-modified for a matching If-None-Match", async () => {
    const first = await reader!.get(KEY, { method: "GET" });
    if (first.kind !== "found") throw new Error("expected found");
    await readAll(first.body);

    const second = await reader!.get(KEY, { method: "GET", ifNoneMatch: first.etag });
    expect(second.kind).toBe("not-modified");
  });

  it("returns not-found for a missing key", async () => {
    const res = await reader!.get(`apps/${randomUUID()}/1/missing.js`, { method: "GET" });
    expect(res.kind).toBe("not-found");
  });
});
