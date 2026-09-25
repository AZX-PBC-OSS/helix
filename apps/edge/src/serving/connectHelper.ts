import {
  CONSENT_ATTEMPT_TTL_SECONDS,
  CONNECT_MESSAGE_VERSION,
  CONSENT_MESSAGE_OUTCOMES,
  CONSENT_MESSAGE_REASONS,
  HELIX_CONNECT_MESSAGE_SOURCE,
  PROVIDER_REF_MAX,
  PROVIDER_REF_PATTERN,
} from "@azx-pbc/shared";
import { ROUTE_CONSENT_CANCEL, ROUTE_CONSENT_START } from "@azx-pbc/shared/telemetry";
import { jsonInline } from "./shim.js";

/**
 * The `window.helix.connect()` consent-popup helper (I-02 design.md §The
 * connect helper; spec §Consent criterion 19) — inlined into an app's HTML at
 * serve time **only when the app's manifest grants `shim.connect`** (design
 * decision 5: the platform does not inject JavaScript into app documents
 * unbidden). The raw platform entry (`GET /_api/connections/:ref/start` +
 * the documented message contract) stays available without the grant.
 *
 * The helper is a function, not UI, and has no automatic behavior: it does not
 * watch responses, does not open a popup on `connection_required`, and does not
 * retry anything (criteria 17, 19, 31). Every flow result is an outcome;
 * it never throws and the promise never rejects.
 *
 * It must be called inside a user gesture — that is the caller's documented
 * obligation (criterion 19), enforced by the browser itself: without a
 * gesture the popup blocker refuses `window.open` and the helper resolves
 * `blocked` (criterion 26). Helix never navigates the current tab and never
 * retries the open.
 *
 * Per call (one popup per call; concurrent calls are fully independent):
 *
 * 1. Mint an attempt correlation tag (128-bit hex — `ConsentAttemptTagSchema`'s
 *    shape) and open exactly one popup at the start route with `?attempt=`.
 * 2. Listen for the completion message (design.md §Completion message) and
 *    verify it before trusting it (criterion 28): the sender is the popup this
 *    call opened (`event.source`), `event.origin` is one of the baked-in
 *    platform origins (this app's own host for start-route terminal pages, the
 *    auth host for completion pages), the producer is Helix's message contract,
 *    and the attempt tag matches when the message carries one. Anything else —
 *    a sibling window, the vendor's page, any other origin — is discarded.
 * 3. Watch the popup for a close without a verified message: acknowledge the
 *    cancellation to `POST /_api/connections/attempt/cancel` (session-gated,
 *    own-attempts-only — the platform marks the attempt cancelled so a late
 *    vendor completion cannot claim it; a connection saved before the close is
 *    a connection row, out of cancel's reach, criterion 29) and resolve
 *    `cancelled`. The acknowledgement is fire-once, best-effort, never
 *    retried — the attempt's five-minute expiry bounds it regardless.
 * 4. Give up after five minutes with the popup open (`timeout` — the attempt
 *    is expired server-side regardless, criterion 25).
 *
 * Listeners and timers are released on every exit (message, close, timeout,
 * blocked) — repeated open/close cycles accumulate nothing.
 */

/** How often the helper polls the popup's `closed` flag. The cancelled exit's
 * detection latency, not a correctness bound (the platform holds the state). */
const POLL_CLOSE_MS = 250;

export function buildConnectScript(opts: { platformOrigins: readonly string[] }): string {
  // Baked per app: the origins a message may arrive from are this app's own
  // host (start-route pages) plus the auth host (completion pages) — the
  // receiver-verification set, criterion 28.
  return `(function () {
  "use strict";
  if (window.__helixConnect) return;
  window.__helixConnect = true;
  var START_TEMPLATE = ${jsonInline(ROUTE_CONSENT_START)};
  var CANCEL_PATH = ${jsonInline(ROUTE_CONSENT_CANCEL)};
  var MESSAGE_SOURCE = ${jsonInline(HELIX_CONNECT_MESSAGE_SOURCE)};
  var MESSAGE_VERSION = ${jsonInline(CONNECT_MESSAGE_VERSION)};
  var OUTCOMES = ${jsonInline([...CONSENT_MESSAGE_OUTCOMES])};
  var REASONS = ${jsonInline([...CONSENT_MESSAGE_REASONS])};
  var PLATFORM_ORIGINS = ${jsonInline([...opts.platformOrigins])};
  var TIMEOUT_MS = ${jsonInline(CONSENT_ATTEMPT_TTL_SECONDS * 1000)};
  var POLL_MS = ${jsonInline(POLL_CLOSE_MS)};
  var REF_TEST = ${jsonInline(PROVIDER_REF_PATTERN.source)};
  var REF_MAX = ${jsonInline(PROVIDER_REF_MAX)};
  var POPUP_FEATURES = ${jsonInline("popup=yes,width=520,height=680,resizable=yes,scrollbars=yes")};

  function inList(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i] === value) return true;
    return false;
  }

  function newAttemptTag() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var tag = "";
    for (var i = 0; i < bytes.length; i++) tag += ("0" + bytes[i].toString(16)).slice(-2);
    return tag;
  }

  function resultOf(outcome, provider, attempt, reason) {
    var result = { outcome: outcome, provider: provider };
    if (attempt !== undefined) result.attempt = attempt;
    if (reason !== undefined) result.reason = reason;
    return result;
  }

  function acknowledgeCancel(provider, attempt) {
    try {
      window.fetch(window.location.origin + CANCEL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify({ provider: provider, attempt: attempt })
      }).catch(function () {});
    } catch (e) {
      // Best-effort by contract: the attempt's five-minute expiry bounds it.
    }
  }

  function connect(providerRef) {
    return new Promise(function (resolve) {
      try {
        // A malformed ref can never start consent (the start route would 404
        // it as a probe) — report it as the bounded unavailable outcome
        // without opening anything.
        if (
          typeof providerRef !== "string" ||
          providerRef.length > REF_MAX ||
          !(new RegExp(REF_TEST)).test(providerRef)
        ) {
          resolve(resultOf("error", String(providerRef), undefined, "provider_unavailable"));
          return;
        }

        var attempt = newAttemptTag();
        var startUrl =
          window.location.origin +
          START_TEMPLATE.replace(":ref", encodeURIComponent(providerRef)) +
          "?attempt=" +
          encodeURIComponent(attempt);
        var popup = window.open(startUrl, "_blank", POPUP_FEATURES);
        if (!popup) {
          // Blocked: control returns immediately; the app may offer another
          // explicit Connect action. No navigation, no retry (criterion 26).
          resolve(resultOf("blocked", providerRef));
          return;
        }

        var settled = false;
        var pollTimer = null;
        var deadlineTimer = null;

        function release() {
          if (window.removeEventListener) window.removeEventListener("message", onMessage);
          if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          if (deadlineTimer !== null) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
          }
        }

        function finish(result) {
          if (settled) return;
          settled = true;
          release();
          resolve(result);
        }

        function onMessage(event) {
          if (settled) return;
          try {
            // Receiver verification (criterion 28). The sender must be the
            // popup THIS call opened — a sibling window or the app's own
            // script cannot occupy event.source.
            if (!event || event.source !== popup) return;
            if (typeof event.origin !== "string" || !inList(PLATFORM_ORIGINS, event.origin)) {
              return;
            }
            var m = event.data;
            if (m === null || typeof m !== "object" || Array.isArray(m)) return;
            if (m.source !== MESSAGE_SOURCE || m.version !== MESSAGE_VERSION) return;
            if (m.provider !== providerRef) return;
            // The tag must match ours when the message carries one; the
            // sender+origin checks bind a tag-less completion page message to
            // this popup either way.
            if (m.attempt !== undefined && m.attempt !== null && m.attempt !== attempt) return;
            if (!inList(OUTCOMES, m.outcome)) return;
            // The message contract always carries reason — null unless the
            // outcome is error (ConnectOutcomeMessageSchema's refine).
            if (m.reason === undefined) return;
            if (m.outcome === "error") {
              if (m.reason !== null && !inList(REASONS, m.reason)) return;
            } else if (m.reason !== null) {
              return;
            }
            finish(
              resultOf(
                m.outcome,
                providerRef,
                m.attempt === undefined ? attempt : m.attempt,
                m.outcome === "error" && m.reason !== null ? m.reason : undefined,
              )
            );
          } catch (e) {
            // A malformed event is discarded, never thrown into the app.
          }
        }

        if (window.addEventListener) window.addEventListener("message", onMessage);

        pollTimer = setInterval(function () {
          if (settled) return;
          try {
            if (popup.closed) {
              // Closed without a completion message: acknowledge the
              // cancellation, then resolve it (design.md §Consent journey,
              // criterion 29).
              acknowledgeCancel(providerRef, attempt);
              finish(resultOf("cancelled", providerRef, attempt));
            }
          } catch (e) {
            // Reading the closed flag cannot fail for a window we opened; stay quiet.
          }
        }, POLL_MS);

        deadlineTimer = setTimeout(function () {
          finish(resultOf("timeout", providerRef, attempt));
        }, TIMEOUT_MS);
      } catch (e) {
        // Never throws, never rejects: every flow result is an outcome.
        resolve(resultOf("error", String(providerRef), undefined, "service_unavailable"));
      }
    });
  }

  // Defensive, not cosmetic: this runs inside the app's document, and an app
  // that clobbered its own window.helix with a non-object must not break its
  // page load — the helper is ergonomics, never a load dependency.
  try {
    window.helix = window.helix || {};
    window.helix.connect = connect;
  } catch (e) {}
})();
//# sourceURL=helix/connect-helper.js
`;
}
