import { FETCH_PROXY_PREFIX } from "@helix/shared";

/**
 * The transparent fetch shim (fetch-proxy design §3.2) — the zero-edit adoption
 * path. For apps that opt in (`capabilities.fetch.shim`), the edge serves this
 * tiny script per-app (with the proxied origins baked in) and injects a
 * `<script src>` for it at the top of the document's `<head>`. The script
 * monkeypatches `window.fetch` **and** `XMLHttpRequest.prototype.open` so a call
 * to a granted proxied origin is transparently rewritten to the same-origin
 * `/_api/fetch/…` path — covering both `fetch` and the XHR adapter axios uses by
 * default, with no app code change.
 *
 * It is **ergonomics, not a boundary**: it only ever adds reach the manifest
 * already granted (rewriting to an origin not in the allowlist would 403), so
 * deleting or bypassing it gains nothing — a direct call to a non-granted origin
 * still dies on `connect-src 'self'`. It fails safe.
 */

/** Reserved edge path the shim is served from (see app.ts `isReservedAppPath`). */
export const SHIM_PATH = "/_helix/fetch-shim.js";

/**
 * Build the per-app shim, with this app's proxied origins baked in so it rewrites
 * only granted origins. ES that any modern browser runs; guards against
 * double-injection and never throws into the app's own call.
 */
export function buildShimScript(origins: string[]): string {
  return `(function () {
  if (window.__helixShim) return;
  window.__helixShim = true;
  var PREFIX = ${JSON.stringify(FETCH_PROXY_PREFIX)};
  var ORIGINS = new Set(${JSON.stringify(origins)});
  function rewrite(url) {
    try {
      var u = new URL(url, document.baseURI);
      if (u.protocol !== "http:" && u.protocol !== "https:") return url;
      return ORIGINS.has(u.origin) ? PREFIX + u.href : url;
    } catch (e) {
      return url;
    }
  }
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" || input instanceof URL) {
          return origFetch.call(this, rewrite(String(input)), init);
        }
        if (typeof Request !== "undefined" && input instanceof Request) {
          var nu = rewrite(input.url);
          return nu === input.url
            ? origFetch.call(this, input, init)
            : origFetch.call(this, new Request(nu, input), init);
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (args.length > 1) args[1] = rewrite(args[1]);
    return origOpen.apply(this, args);
  };
})();
`;
}

const SHIM_TAG = `<script src="${SHIM_PATH}"></script>`;

/**
 * Insert the shim `<script src>` immediately after the first `<head …>` so it
 * runs before any app script captures `fetch`/`XMLHttpRequest`. Falls back to
 * prepending when there is no `<head>` (browsers hoist it into a synthesized
 * head). A plain (non-async/defer) external script blocks parsing until it has
 * executed — exactly the ordering the patch needs.
 */
export function injectShimTag(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + SHIM_TAG + html.slice(at);
  }
  return SHIM_TAG + html;
}
