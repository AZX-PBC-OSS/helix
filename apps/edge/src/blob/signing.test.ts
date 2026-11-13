import { describe, expect, it } from "vitest";
import { buildStringToSign, signRequest, X_MS_VERSION } from "./signing.js";

// Fixed inputs so the canonical string is byte-for-byte deterministic. The
// end-to-end proof that Azure's validator accepts our signatures is
// client.integration.test.ts; these tests pin the exact string layout.
const KEY = Buffer.from("dGVzdGtleQ==", "base64");
const DATE = "Fri, 12 Jun 2026 00:00:00 GMT";

describe("buildStringToSign", () => {
  it("builds the canonical string for a plain GET (Azurite-style doubled account)", () => {
    const s = buildStringToSign({
      method: "GET",
      url: new URL("http://azurite:10000/devstoreaccount1/app-bundles/apps/a1/1/index.html"),
      accountName: "devstoreaccount1",
      accountKey: KEY,
      date: DATE,
    });
    expect(s).toBe(
      "GET\n" +
        "\n\n" + // Content-Encoding, Content-Language
        "\n" + // Content-Length: EMPTY for bodyless requests, never "0"
        "\n\n" + // Content-MD5, Content-Type
        "\n" + // Date (always empty; x-ms-date is used instead)
        "\n\n\n\n\n" + // If-Modified-Since, If-Match, If-None-Match, If-Unmodified-Since, Range
        `x-ms-date:${DATE}\n` +
        `x-ms-version:${X_MS_VERSION}\n` +
        // Account name appears twice: once from canonicalization, once from
        // Azurite's path-style URL. Correct, not a bug.
        "/devstoreaccount1/devstoreaccount1/app-bundles/apps/a1/1/index.html",
    );
  });

  it("carries If-None-Match in its dedicated slot", () => {
    const s = buildStringToSign({
      method: "GET",
      url: new URL("http://azurite:10000/devstoreaccount1/c/k"),
      accountName: "devstoreaccount1",
      accountKey: KEY,
      date: DATE,
      headers: { ifNoneMatch: '"0x1234"' },
    });
    const lines = s.split("\n");
    expect(lines[9]).toBe('"0x1234"'); // 10th line: If-None-Match
  });

  it("carries Range in its dedicated slot, and leaves it empty without one", () => {
    const make = (range?: string) =>
      buildStringToSign({
        method: "GET",
        url: new URL("http://azurite:10000/devstoreaccount1/c/k"),
        accountName: "devstoreaccount1",
        accountKey: KEY,
        date: DATE,
        headers: { range },
      }).split("\n");
    expect(make("bytes=0-1")[11]).toBe("bytes=0-1"); // 12th line: Range
    expect(make()[11]).toBe("");
  });

  it("signs HEAD like GET apart from the verb", () => {
    const make = (method: "GET" | "HEAD") =>
      buildStringToSign({
        method,
        url: new URL("http://azurite:10000/devstoreaccount1/c/k"),
        accountName: "devstoreaccount1",
        accountKey: KEY,
        date: DATE,
      });
    expect(make("HEAD").replace(/^HEAD/, "GET")).toBe(make("GET"));
  });

  it("includes content headers, extra x-ms headers and sorted query params for PUT", () => {
    const s = buildStringToSign({
      method: "PUT",
      url: new URL("http://azurite:10000/devstoreaccount1/app-bundles?restype=container"),
      accountName: "devstoreaccount1",
      accountKey: KEY,
      date: DATE,
      headers: {
        contentLength: "11",
        contentType: "text/plain",
        extraXms: { "X-MS-Blob-Type": "BlockBlob" },
      },
    });
    expect(s).toBe(
      "PUT\n\n\n11\n\ntext/plain\n\n\n\n\n\n\n" +
        "x-ms-blob-type:BlockBlob\n" + // lowercased and sorted with the rest
        `x-ms-date:${DATE}\n` +
        `x-ms-version:${X_MS_VERSION}\n` +
        "/devstoreaccount1/devstoreaccount1/app-bundles" +
        "\nrestype:container",
    );
  });
});

describe("signRequest", () => {
  it("puts a signed range on the wire", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("http://azurite:10000/devstoreaccount1/c/k"),
      accountName: "devstoreaccount1",
      accountKey: KEY,
      date: DATE,
      headers: { range: "bytes=5-" },
    });
    expect(headers.range).toBe("bytes=5-");
  });

  it("returns the authorization header plus every signed header", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("http://azurite:10000/devstoreaccount1/c/k"),
      accountName: "devstoreaccount1",
      accountKey: KEY,
      date: DATE,
      headers: { ifNoneMatch: '"0x1"' },
    });
    expect(headers.authorization).toMatch(/^SharedKey devstoreaccount1:[A-Za-z0-9+/]+=*$/);
    expect(headers["x-ms-date"]).toBe(DATE);
    expect(headers["x-ms-version"]).toBe(X_MS_VERSION);
    expect(headers["if-none-match"]).toBe('"0x1"');
  });

  it("produces a stable signature for fixed inputs", () => {
    const sign = () =>
      signRequest({
        method: "GET",
        url: new URL("http://azurite:10000/devstoreaccount1/c/k"),
        accountName: "devstoreaccount1",
        accountKey: KEY,
        date: DATE,
      }).authorization;
    expect(sign()).toBe(sign());
  });
});
