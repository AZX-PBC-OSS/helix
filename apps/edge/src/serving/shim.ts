import { FETCH_PROXY_PREFIX } from "@azx-pbc/shared";

/**
 * The transparent fetch shim (fetch-proxy design §3.2) — the zero-edit adoption
 * path. For apps that opt in (`capabilities.fetch.shim`), the edge builds this
 * tiny script per-app (with the proxied origins baked in) and inlines it at the
 * top of the document's `<head>`. The script monkeypatches `window.fetch` **and**
 * `XMLHttpRequest.prototype.open` so a call to a granted proxied origin is
 * transparently rewritten to the same-origin `/_api/fetch/…` path — covering both
 * `fetch` and the XHR adapter axios uses by default, with no app code change.
 *
 * It is **ergonomics, not a boundary**: it only ever adds reach the manifest
 * already granted (rewriting to an origin not in the allowlist would 403), so
 * deleting or bypassing it gains nothing — a direct call to a non-granted origin
 * still dies on `connect-src 'self'`. It fails safe.
 */

/**
 * Serialize a value for interpolation into an **inlined** script body.
 *
 * Identical to `JSON.stringify` except that every `<` becomes the `<`
 * escape — legal inside a JS string literal, and unable to produce a literal
 * `<` in the output. That is what keeps a manifest-derived value (the shim's
 * proxied origins) from closing the `<script>` tag it is embedded in and
 * injecting app-controlled markup into a platform script block.
 *
 * Note what is deliberately NOT done: the usual `<\/script` trick. Escaping a
 * slash is only legal *inside* a string literal, so a blanket regex over an
 * assembled script body would be a latent syntax error the moment a `</` shows
 * up in code rather than in data. Escaping at the interpolation point cannot
 * have that failure mode.
 */
export function jsonInline(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Build the per-app shim, with this app's proxied origins baked in so it rewrites
 * only granted origins. ES that any modern browser runs; guards against
 * double-injection and never throws into the app's own call.
 */
export function buildShimScript(origins: string[]): string {
  return `(function () {
  if (window.__helixShim) return;
  window.__helixShim = true;
  var PREFIX = ${jsonInline(FETCH_PROXY_PREFIX)};
  var ORIGINS = new Set(${jsonInline(origins)});
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
//# sourceURL=helix/fetch-shim.js
`;
}

/**
 * Insert platform scripts **inline** immediately after the first `<head …>`, in
 * the order given, so they run before any app script. Falls back to prepending
 * when there is no `<head>` (browsers hoist the tag into a synthesized head).
 *
 * Shared by the fetch shim and the offline capability's service-worker
 * registration (ADR-0035); an app may hold both grants, so this composes rather
 * than assuming a single script.
 *
 * **Inline, not `<script src>`** — the snippets used to be served from
 * `/_helix/*`, which the platform service worker deliberately never caches (the
 * same rule that keeps `/_api/*` usable as a reachability probe). An app holding
 * both `fetch.shim` and `offline` therefore lost the shim on every offline cold
 * boot, and paid a network timeout before first paint for the failed load. Inline
 * bytes live inside the cached document, so they are present exactly when it is.
 * The app CSP already permits `'unsafe-inline'` (ADR-0009) — see `csp.ts` for why
 * that must not be "hardened" into a hash or nonce.
 */
export function injectHeadScripts(html: string, scripts: readonly string[]): string {
  if (scripts.length === 0) return html;
  const tags = scripts
    .map((js) => {
      // Bug trap, not input validation: every interpolation into these snippets
      // goes through `jsonInline`, so neither sequence can reach here. If one
      // ever does it would break the app's document, so fail loudly instead.
      if (/<\/script|<!--/i.test(js)) {
        throw new Error("inline platform script contains a script-data-terminating sequence");
      }
      return `<script>${js}</script>`;
    })
    .join("");
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  // No `<head>`: browsers synthesize one and hoist the tag into it — but the
  // tag must still go AFTER any doctype. A `<script>` before it takes the
  // parser out of "initial" insertion mode, the doctype token is then ignored,
  // and the document renders in **quirks mode** — a layout change we would be
  // inflicting on an app for no reason. Single-file vibe-coded documents (the
  // apps §4.4 is written for) routinely have a doctype and no `<head>`.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return html.slice(0, at) + tags + html.slice(at);
  }
  return tags + html;
}
