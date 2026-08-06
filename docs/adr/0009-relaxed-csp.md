# 0009. Relaxed CSP posture for hostile app code

**Status:** Accepted (revisit — supply-chain hardening)
**Related:** `apps/edge/src/serving/csp.ts`; review DEC-03

## Context

CSP normally exists to stop XSS — to prevent injected script from running. In Helix the app's own code is *already* untrusted and runs by design; blocking inline/eval would not contain a hostile app, because the app author can put whatever they want in their own bundle. Containment is done at the origin boundary (separate subdomain) and the gateway, not by CSP.

## Decision

Inject a per-app CSP that permits `'unsafe-inline'`, `'unsafe-eval'`, `'wasm-unsafe-eval'`, and a fixed allowlist of CDNs, plus the app's approved external origins. The CSP's job here is to scope *network* destinations (and support the fetch-shim), not to block script execution.

## Consequences

- Apps can use inline scripts, eval, and wasm — necessary for vibe-coded bundles.
- **`'unsafe-inline'` is load-bearing for the platform too, since ADR-0035.** The fetch shim and the offline capability's worker registration are inlined into the document at serve time rather than served from `/_helix/*` (which the platform service worker deliberately never caches, so a `<script src>` there cannot load on an offline cold boot). Consequence to keep in view: **never add a hash or nonce source to `script-src`** as "hardening" — under CSP3 the presence of either makes browsers *ignore* `'unsafe-inline'`, breaking every app's own inline script. Noted at the directive in `apps/edge/src/serving/csp.ts`.
- The XSS-prevention value of CSP is intentionally given up (it would be moot anyway).
- **The CDN allowlist is a supply-chain trust dependency**: a compromise of any listed CDN yields script execution in every app. No Subresource Integrity is enforced.

## Open question

Consider SRI or versioned-script pinning for the CDN allowlist; add `object-src 'none'` (currently falls back to `default-src`). Decide whether the CDN list should be per-app/opt-in rather than global.

## Review notes (2026-06-25)

The relaxed stance is sound given the threat model; the un-hardened CDN allowlist (no SRI) is the consequential gap. Tracked as DEC-03.

## Challenge outcome (2026-06-26)

WEAKEN — the "app author is already hostile" reasoning misses a **different attacker**: anonymous third-party content written via shared-writes (ADR-0010, `putShared` runs for anonymous callers) is rendered by the app, so relaxed CSP voids real **stored-XSS protection for end users** on public / shared-write apps (tolerable only on SSO-gated apps). `connect-src` is locked but `img-src https:` / navigation remain exfil channels. Add `object-src 'none'` (marginal — already inherits `default-src 'self'`), and — more importantly — record the third-party-XSS exposure on public shared-write apps in the threat model.
