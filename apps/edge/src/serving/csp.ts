/**
 * The baseline Content-Security-Policy injected on every app HTML response
 * (architecture §4.4). M2 ships it statically configured; per-app
 * `external_origins` additions and `report-to` violation reporting are v1.
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
 */
const CDN_ALLOWLIST = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://esm.sh",
  "https://cdn.tailwindcss.com",
];
const CDNS = CDN_ALLOWLIST.join(" ");

export const APP_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${CDNS}`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${CDNS}`,
  `font-src 'self' data: https://fonts.gstatic.com ${CDNS}`,
  "img-src https: data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join("; ");
