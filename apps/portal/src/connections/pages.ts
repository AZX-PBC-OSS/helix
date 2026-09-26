import type { FastifyReply } from "fastify";

/**
 * The portal-served consent pages — the popup's browser-facing control-plane
 * surfaces, reached through the edge's `/connections/*` reverse proxy (I-02
 * ADR-0002 part 3). T-0016 ships the dev journey's nonce entry: on the happy
 * path there is no page at all — the entry 302s straight to the vendor
 * (design decision 3, no pre-consent click-through) — so the one page this
 * module renders is the refusal, for every redemption refusal and every
 * service failure.
 *
 * The refusal content is a CONSTANT: no interpolation, no scripts. A replayed
 * nonce URL, a fabricated one, an expired or cancelled attempt, and a
 * stale-provider attempt all answer the same fixed page (the M3
 * indistinguishable-denial posture — a failed redemption must not become an
 * oracle for which nonces exist), so nothing untrusted can reach the markup
 * and the CSP needs no script slot. The edge's `renderAuthPage` is the visual
 * reference; the portal renders its own minimal page because the shared
 * chrome is edge-side code.
 */

const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PAGE_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
       font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
       color: #f6f2f5; background: #08090b; }
main { max-width: 480px; text-align: center; }
h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0; color: #b6aeb4; font-size: 13.5px; }
p.foot { margin: 18px 0 0; font-size: 11px; color: #756f77;
         font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .12em; }
`;

const REFUSAL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connection link not valid</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>This connection link isn't valid anymore</h1>
<p>If you were connecting an app, close this window and select Connect again in the app.</p>
<p class="foot">AZX · Helix connect</p>
</main>
</body>
</html>
`;

const SERVICE_FAILURE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Couldn't continue</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>Couldn't continue the connection</h1>
<p>Close this window and select Connect again in the app.</p>
<p class="foot">AZX · Helix connect</p>
</main>
</body>
</html>
`;

function sendPage(reply: FastifyReply, status: 200 | 503, page: string): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("content-security-policy", PAGE_CSP)
    .type("text/html; charset=utf-8")
    .send(page);
}

/** The fixed refusal page — every redemption refusal answers it, at 200: the
 * page IS the answer, and a 4xx would distinguish states the contract keeps
 * indistinguishable. */
export function sendConsentRefusalPage(reply: FastifyReply): void {
  sendPage(reply, 200, REFUSAL_PAGE);
}

/** The service-failure page — 503, the edge couldn't-start posture. */
export function sendConsentServiceFailurePage(reply: FastifyReply): void {
  sendPage(reply, 503, SERVICE_FAILURE_PAGE);
}
