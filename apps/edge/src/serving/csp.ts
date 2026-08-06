/**
 * The Content-Security-Policy injected on every app response (architecture
 * §4.4). The baseline is static; an app's approved `externalOrigins` (manifest
 * capability, gated through the approvals write-gate — docs/design/approvals.md
 * §6.2) widen `connect-src`/`img-src` per app, and a same-origin `report-uri`
 * funnels violations to the edge sink.
 *
 * Two postures by design — the threat model is an *untrusted app*, so:
 *
 * STRICT — data-flow directives. These are the containment and don't bend:
 * `connect-src 'self'` (the gateway is same-origin at /_api/*; everything
 * else is a declared capability), `form-action 'self'` (cross-subdomain CSRF
 * — §4.2; does NOT fall back to default-src), `frame-ancestors 'none'`,
 * `base-uri 'self'`.
 *
 * RELAXED — code-provenance directives. Blocking inline/eval in code we
 * already assume hostile buys nothing and breaks every single-file
 * vibe-coded app, so inline scripts/styles, eval, wasm and the curated CDN
 * allowlist are permitted; `img-src https:` stays open (navigation exfil
 * exists regardless — §4.4's honest trade-off).
 *
 * `worker-src 'self' blob:` covers dedicated and shared workers only — a `blob:`
 * URL can never register a SERVICE worker, which requires a same-origin http(s)
 * script URL. (An earlier version of this note claimed the relaxation was safe
 * *because* service workers were banned; that reasoning was wrong, and the two
 * are independent.) App-supplied service workers are refused at the asset
 * handler regardless, because a root-scoped one would observe the handoff token
 * on `/_auth/complete`; the offline capability (ADR-0035) registers a
 * platform-owned worker from a reserved route instead, and that worker is served
 * carrying this same policy — for a worker, the CSP on the script governs the
 * worker's own `fetch()`.
 *
 * The policy is attached to EVERY app response, not just HTML — any
 * browser-active document type (SVG, XHTML, XML) can carry script, and CSP
 * on inert assets is harmless.
 */
const CDN_ALLOWLIST = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  "https://cdn.tailwindcss.com",
];
const CDNS = CDN_ALLOWLIST.join(" ");

/** Same-origin path the edge accepts CSP violation reports on (serving/cspReport.ts). */
export const CSP_REPORT_PATH = "/_csp-report";

/**
 * Reduce approved external origins to bare CSP sources (scheme+host+port). They
 * arrive as validated URLs; `new URL().origin` strips any path so a stored
 * `https://api.foo.com/v1` doesn't become a path-restricted source. Invalid
 * entries are dropped (fail-closed — never widen on garbage).
 */
function originSources(origins: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of origins) {
    try {
      const origin = new URL(o).origin;
      if (origin !== "null" && !out.includes(origin)) out.push(origin);
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Build an app's CSP. With no approved origins this is the static baseline (the
 * strict data-flow directives are the containment — see the module doc). Each
 * approved origin widens `connect-src` (the meaningful grant; `img-src` already
 * permits any https) and `img-src`.
 */
export function buildAppCsp(externalOrigins: readonly string[] = []): string {
  const extra = originSources(externalOrigins);
  const suffix = extra.length ? ` ${extra.join(" ")}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${CDNS}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${CDNS}`,
    `font-src 'self' data: https://fonts.gstatic.com ${CDNS}`,
    `img-src https: data: blob:${suffix}`,
    "media-src 'self' data: blob:",
    `connect-src 'self'${suffix}`,
    "worker-src 'self' blob:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    `report-uri ${CSP_REPORT_PATH}`,
  ].join("; ");
}

/** The baseline CSP (no per-app origins). */
export const APP_CSP = buildAppCsp();
