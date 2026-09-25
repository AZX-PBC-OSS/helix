import { type CustomFetch } from "openid-client";
import { fetch as undiciFetch, type Agent } from "undici";

/**
 * The exchange operation's transport adapter (I-02 ADR-0009): the one place
 * openid-client's HTTP traffic meets egress's transport policy. The library's
 * default is global `fetch`, which does NOT inherit the DNS-pinned connector —
 * this adapter binds every library call to the fetch-proxy's dispatcher, so
 * the SSRF controls (resolve + validate + IP-pin per socket) and the trace
 * boundary (no context injected outward, nothing extracted inward) survive
 * the library boundary.
 *
 * The dispatcher is the SAME instance the proxy uses (wired in `app.ts`), so
 * connection pooling and the pinned connector are process-wide facts, not
 * per-route choices.
 *
 * openid-client's own docs show this integration with a `@ts-expect-error`
 * (undici's `Response` type vs the global one); the cast here is the same
 * narrowing, named once.
 */
export function makePinnedFetch(dispatcher: Agent): CustomFetch {
  return (url, options) =>
    undiciFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: options.redirect,
      signal: options.signal,
      dispatcher,
    }) as unknown as Promise<Response>;
}
