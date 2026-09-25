import type { FastifyReply } from "fastify";
import { ConnectOutcomeMessageSchema, type ConnectOutcomeMessage } from "@azx-pbc/shared";
import { AUTH_PAGE_CSP, renderAuthPage } from "./authChrome.js";

/**
 * The consent popup's platform-rendered pages (I-02 design.md §Consent popup
 * pages). On the edge these are the four PRE-vendor terminal states the start
 * route answers — sign-in required, already connected, not available, couldn't
 * start — every one rendered in the shared auth chrome. Each page posts the
 * app-facing outcome message to its opener, then offers a real Close button;
 * only the callback's completion pages (portal-side, T-0020) auto-close.
 *
 * The message's target origin is a contract value, not a choice made here:
 * design.md §Completion message binds start-route pages to **the app's own
 * host** — the same origin the start route's navigation guard just verified —
 * because these terminal pages precede any pending attempt whose recorded
 * opener origin a later page would use. Receivers still verify `event.origin`
 * against their baked-in platform origins (criterion 28).
 *
 * Script posture: the chrome's CSP allows no scripts (`default-src 'none'`),
 * so these pages carry their own CSP that adds `script-src 'unsafe-inline'`.
 * The single inline script is platform-authored; every interpolated value
 * arrives through {@link scriptJson}, which serializes to a script-safe JSON
 * literal — the message is validated by {@link ConnectOutcomeMessageSchema}
 * and the target origin is config-derived, so nothing untrusted reaches the
 * markup unescaped even in depth.
 */

export const CONSENT_PAGE_CSP = `${AUTH_PAGE_CSP}; script-src 'unsafe-inline'`;

/**
 * Serialize a value as a JSON literal safe to embed in an inline `<script>`.
 * `JSON.stringify` alone still permits `</script>` (which closes the element
 * early), `&`/`<`/`>` (entity-stacking tricks) and the line separators
 * U+2028/U+2029 (syntax errors in JS) — escape all of them into `\uXXXX` form,
 * which parses identically.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The one button id the inline script looks up. */
const CLOSE_BUTTON_ID = "helix-connect-close";

const CLOSE_STYLE = `button.close { margin: 4px 0 0; }`;

const CLOSE_AND_POST_SCRIPT = `
(function () {
  "use strict";
  var message = MESSAGE_JSON;
  var targetOrigin = TARGET_ORIGIN_JSON;
  try {
    if (window.opener) window.opener.postMessage(message, targetOrigin);
  } catch (e) {
    /* the notification is best-effort; the page's Close action still works */
  }
  var close = function () { window.close(); };
  var btn = document.getElementById("CLOSE_ID");
  if (btn) btn.addEventListener("click", close);
  var heading = document.querySelector("h1");
  if (heading) heading.focus();
})();
`;

/**
 * Render one terminal consent page: the design's content in the shared chrome,
 * the outcome message embedded for the inline script, and the Close button.
 * The message is parsed through the shared schema before embedding — a
 * producer that cannot build a valid message fails loudly here rather than
 * posting a malformed notification.
 */
export function renderConsentTerminalPage(opts: {
  title: string;
  heading: string;
  sub: string;
  /** The outcome message this page posts to the opener before closing. */
  message: ConnectOutcomeMessage;
  /** The exact `postMessage` target origin (design.md §Completion message). */
  targetOrigin: string;
}): string {
  // Parse (not cast): the schema is the boundary; the inline script embeds
  // whatever this returns.
  const message = ConnectOutcomeMessageSchema.parse(opts.message);
  const script = CLOSE_AND_POST_SCRIPT.replace("MESSAGE_JSON", scriptJson(message))
    .replace("TARGET_ORIGIN_JSON", scriptJson(opts.targetOrigin))
    .replace("CLOSE_ID", CLOSE_BUTTON_ID);
  return renderAuthPage({
    title: opts.title,
    heading: opts.heading,
    sub: opts.sub,
    bodyHtml: `<button type="button" class="close" id="${CLOSE_BUTTON_ID}">Close</button>`,
    footHtml: `<p class="foot">AZX · Helix connect</p>`,
    bodyEndHtml: `<style>${CLOSE_STYLE}</style>\n<script>${script}</script>`,
  });
}

/** Send a terminal page with the popup posture: no-store, no referrer, CSP. */
export function sendConsentPage(reply: FastifyReply, status: 200 | 401 | 503, page: string): void {
  reply
    .status(status)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("content-security-policy", CONSENT_PAGE_CSP)
    .type("text/html; charset=utf-8")
    .send(page);
}
