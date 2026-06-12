import { createHmac } from "node:crypto";

/**
 * Azure Storage SharedKey request signing, hand-rolled on node:crypto.
 *
 * Deliberate: the edge is dependency-minimal (project plan §1, §6), so it does
 * not take the Azure SDK into the trusted path for what amounts to one HMAC
 * over a documented canonical string. Scope is read-path GET/HEAD plus the PUT
 * the integration-test seeder needs — nothing else.
 *
 * Spec: "Authorize with Shared Key" (Blob service, version 2015-02-21+ format).
 * Works identically against Azurite and real Azure.
 */

/** Pinned service version — known-good in Azurite and current Azure. */
export const X_MS_VERSION = "2021-12-02";

export interface SignRequestInput {
  method: "GET" | "HEAD" | "PUT";
  /** Full request URL including any query string. */
  url: URL;
  accountName: string;
  accountKey: Buffer;
  /** RFC 7231 date for x-ms-date; injectable for deterministic tests. */
  date?: string;
  headers?: {
    /** Forwarded client validator for conditional GETs. */
    ifNoneMatch?: string;
    /** Required (as a string) for PUT bodies. */
    contentLength?: string;
    contentType?: string;
    /** Extra x-ms-* headers (e.g. x-ms-blob-type for test PUTs). */
    extraXms?: Record<string, string>;
  };
}

/**
 * The canonical string-to-sign. Exported for unit tests — the exact byte
 * layout is the whole game; a one-character drift means 403s.
 */
export function buildStringToSign(input: SignRequestInput): string {
  const headers = input.headers ?? {};

  // x-ms-* headers: lowercase names, sorted, `name:value` lines.
  const xms: Record<string, string> = {
    "x-ms-date": input.date ?? new Date().toUTCString(),
    "x-ms-version": X_MS_VERSION,
    ...Object.fromEntries(
      Object.entries(headers.extraXms ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  const canonicalizedHeaders = Object.keys(xms)
    .sort()
    .map((name) => `${name}:${xms[name]}\n`)
    .join("");

  // Canonicalized resource: /{account}{path}, then sorted query params as
  // `\nname:value`. Against Azurite the URL path already starts with the
  // account name, so the account legitimately appears twice
  // (/devstoreaccount1/devstoreaccount1/...) — do not "fix" this.
  const params = [...input.url.searchParams.entries()]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalizedResource =
    `/${input.accountName}${input.url.pathname}` +
    params.map(([name, value]) => `\n${name}:${value}`).join("");

  return [
    input.method,
    "", // Content-Encoding
    "", // Content-Language
    headers.contentLength ?? "", // Content-Length: EMPTY (not "0") when there is no body
    "", // Content-MD5
    headers.contentType ?? "", // Content-Type
    "", // Date — always empty; x-ms-date is signed via canonicalized headers
    "", // If-Modified-Since
    "", // If-Match
    headers.ifNoneMatch ?? "", // If-None-Match
    "", // If-Unmodified-Since
    "", // Range
    canonicalizedHeaders + canonicalizedResource,
  ].join("\n");
}

/**
 * Sign a request: returns every header the request must carry, including
 * `authorization`. The caller must send these verbatim (plus the body headers
 * it declared via `headers` — content-type/length/if-none-match are signed,
 * so they have to be on the wire too).
 */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const date = input.date ?? new Date().toUTCString();
  const withDate: SignRequestInput = { ...input, date };

  const signature = createHmac("sha256", input.accountKey)
    .update(buildStringToSign(withDate), "utf8")
    .digest("base64");

  const headers: Record<string, string> = {
    authorization: `SharedKey ${input.accountName}:${signature}`,
    "x-ms-date": date,
    "x-ms-version": X_MS_VERSION,
  };
  const h = input.headers ?? {};
  if (h.ifNoneMatch) headers["if-none-match"] = h.ifNoneMatch;
  if (h.contentLength) headers["content-length"] = h.contentLength;
  if (h.contentType) headers["content-type"] = h.contentType;
  for (const [name, value] of Object.entries(h.extraXms ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}
