import type { FastifyReply } from "fastify";
import { ConnectOutcomeMessageSchema, type ConnectOutcomeMessage } from "@azx-pbc/shared";
import type { ConsentCompletion } from "./completion.js";
import { sendConsentRefusalPage } from "./pages.js";

/**
 * The callback's completion pages (I-02 T-0020, design.md §Consent popup
 * pages — the page table is the content contract): the popup's terminal
 * surfaces, portal-served through the edge's `/connections/*` reverse proxy.
 * Siblings of `pages.ts`'s nonce-entry pages, with one difference the design
 * fixes: these pages carry a script, because a completion page POSTS the
 * outcome message to the opener (the exact target origin recorded on the
 * pending attempt — ADR-0002 §Shared ground) and the connected page then
 * closes itself.
 *
 * Content discipline: every line is a platform constant — the only
 * interpolation is the provider's display name (admin-chosen, HTML-escaped),
 * read from the provider row. No vendor error text, no protocol material, no
 * credential ever reaches a page (criteria 22, 27, 34). The connected page's
 * success line starts hidden and is revealed only when `window.close()`
 * failed to close the popup (criterion 30).
 *
 * Accessibility (design.md §Accessibility Notes): the heading takes focus on
 * load, the Close control is a real button, the layout is the single centered
 * column that reflows at 320 px and survives 200% zoom.
 */

const COMPLETION_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PAGE_STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
       font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
       color: #f6f2f5; background: #08090b; }
main { max-width: 30rem; text-align: center; }
h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0; color: #b6aeb4; font-size: 13.5px; }
p.foot { margin: 18px 0 0; font-size: 11px; color: #756f77;
         font-family: ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .12em; }
button.close { margin: 14px 0 0; font: inherit; font-size: 13.5px; padding: 6px 18px;
               border-radius: 6px; border: 1px solid #4a444b; background: #16171a;
               color: #f6f2f5; cursor: pointer; }
`;

/** HTML-escape the one interpolated value (the display name). Mirrors the
 * edge's `escapeHtml` (apps/edge/src/serving/authChrome.ts) — that one is
 * edge-side code, so the portal keeps its own. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value as a JSON literal safe to embed in an inline `<script>` —
 * the edge's `scriptJson` (apps/edge/src/serving/consentPages.ts), restated
 * portal-side: `JSON.stringify` alone still permits `</script>`,
 * `&`/`<`/`>` entity-stacking, and the U+2028/U+2029 line separators.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const CLOSE_BUTTON_ID = "helix-connect-close";
const FALLBACK_ID = "helix-connect-fallback";

/**
 * The one script every completion page carries: post the outcome message to
 * the recorded opener origin (best-effort — the notification must never break
 * the page), focus the heading, wire the real Close button; the connected
 * page additionally attempts `window.close()` and reveals its success line
 * when the window survived.
 */
const COMPLETION_SCRIPT = `
(function () {
  "use strict";
  var message = MESSAGE_JSON;
  try {
    if (message && window.opener) window.opener.postMessage(message, TARGET_ORIGIN_JSON);
  } catch (e) {
    /* the notification is best-effort; the page's Close action still works */
  }
  var heading = document.querySelector("h1");
  if (heading) heading.focus();
  var btn = document.getElementById("CLOSE_ID");
  if (btn) btn.addEventListener("click", function () { window.close(); });
  if (AUTO_CLOSE) {
    window.close();
    setTimeout(function () {
      var fallback = document.getElementById("FALLBACK_ID");
      if (fallback) fallback.hidden = false;
    }, 200);
  }
})();
`;

interface CompletionPage {
  title: string;
  heading: string;
  /** The design's page-table line, with the display name interpolated. */
  sub: string;
}

/** The design's page table (§Consent popup pages), keyed by outcome. The
 * nameless variants fire only when the provider row was unreadable — the
 * kill-paths (deletion, sensitive edits) make that a narrow race. */
function pageFor(outcome: string, displayName: string | null): CompletionPage {
  const name = displayName ?? "";
  switch (outcome) {
    case "connected":
      return {
        title: "Connected",
        heading: "Connected",
        sub: name
          ? `Connected to ${name} — you can return to the app.`
          : "Connected — you can return to the app.",
      };
    case "conflict":
      return {
        title: "Connection conflict",
        heading: "Connection conflict",
        sub: "Another connection attempt finished first — return to the app.",
      };
    case "denied":
      return {
        title: "Declined",
        heading: "Declined",
        sub: name ? `You declined the connection at ${name}.` : "You declined the connection.",
      };
    case "expired":
      return {
        title: "Expired",
        heading: "Expired",
        sub: "This attempt expired (5 minutes) — close this and select Connect again.",
      };
    case "cancelled":
      return {
        title: "Cancelled",
        heading: "Cancelled",
        sub: "This attempt was cancelled.",
      };
    case "disconnected":
      return {
        title: "Disconnected",
        heading: "Disconnected",
        sub: "This connection was disconnected.",
      };
    case "failed_permissions":
      return {
        title: "Permissions not granted",
        heading: "Permissions not granted",
        sub: name
          ? `${name} didn't grant all requested permissions — try again and approve them all.`
          : "The connection didn't grant all requested permissions — try again and approve them all.",
      };
    case "failed_provider":
      return {
        title: "Connection failed",
        heading: "Connection failed",
        sub: name
          ? `${name} returned an incomplete token — an administrator must check the provider configuration.`
          : "The provider returned an incomplete token — an administrator must check the provider configuration.",
      };
    default:
      // failed_service.
      return {
        title: "Connection failed",
        heading: "Connection failed",
        sub: "Couldn't complete the connection — try again from the app.",
      };
  }
}

/**
 * Render the completion page for one outcome: the design's content, the
 * message embedded for the inline script (parsed through the shared schema —
 * a producer that cannot build a valid message fails loudly here), the
 * focusable heading, and the real Close button.
 */
export function renderCompletionPage(
  outcome: string,
  displayName: string | null,
  message: ConnectOutcomeMessage | null,
  targetOrigin: string | null,
): string {
  const page = pageFor(outcome, displayName);
  const autoClose = outcome === "connected";
  // Parse (not cast): the schema is the boundary; the inline script embeds
  // whatever this returns. Message and target origin are all-or-nothing —
  // the machine sets them together.
  const messageJson =
    message && targetOrigin ? scriptJson(ConnectOutcomeMessageSchema.parse(message)) : "null";
  const originJson = message && targetOrigin ? scriptJson(targetOrigin) : "null";
  const script = COMPLETION_SCRIPT.replace("MESSAGE_JSON", messageJson)
    .replace("TARGET_ORIGIN_JSON", originJson)
    .replace("CLOSE_ID", CLOSE_BUTTON_ID)
    .replace("FALLBACK_ID", FALLBACK_ID)
    .replace("AUTO_CLOSE", autoClose ? "true" : "false");
  // The connected page's success line IS the fallback (criterion 30): hidden
  // until the window survives the close attempt. Every other page shows its
  // line immediately.
  const sub = autoClose
    ? `<p id="${FALLBACK_ID}" hidden>${escapeHtml(page.sub)}</p>`
    : `<p>${escapeHtml(page.sub)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1 tabindex="-1">${escapeHtml(page.heading)}</h1>
${sub}
<button type="button" class="close" id="${CLOSE_BUTTON_ID}">Close</button>
<p class="foot">AZX · Helix connect</p>
</main>
<script>${script}</script>
</body>
</html>
`;
}

/**
 * Send one completion result: no-store and no-referrer (design.md §Consent
 * journey — the callback URL carries `code` and `state`), and the CSP with
 * the script slot the message posting needs. Service- and provider-side
 * failures answer 503 (the edge's couldn't-start posture); every flow outcome
 * is 200 — the page IS the answer. The `refusal` result renders the fixed
 * scriptless page `pages.ts` ships, at 200 like every other flow answer.
 */
export function sendCompletionPage(reply: FastifyReply, completion: ConsentCompletion): void {
  if (completion.page === "refusal") {
    sendConsentRefusalPage(reply);
    return;
  }
  const status =
    completion.outcome === "failed_service" || completion.outcome === "failed_provider" ? 503 : 200;
  reply
    .status(status)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("content-security-policy", COMPLETION_CSP)
    .type("text/html; charset=utf-8")
    .send(
      renderCompletionPage(
        completion.outcome,
        completion.displayName,
        completion.message,
        completion.targetOrigin,
      ),
    );
}
