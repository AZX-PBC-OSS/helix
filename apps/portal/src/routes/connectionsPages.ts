import type { FastifyInstance, FastifyReply } from "fastify";
import { CONSENT_NONCE_ENTRY_PATH, ConsentNonceSchema } from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";
import { AppError } from "../plugins/errors.js";
import { connectionsCallbackUrl } from "../deployment.js";
import { redeemConsentNonce, type ConsentNonceRedemption } from "../connections/consent.js";
import { sendConsentRefusalPage, sendConsentServiceFailurePage } from "../connections/pages.js";

/**
 * The portal-served consent page routes under the `/connections/*` proxy
 * prefix (I-02 ADR-0002 part 3). These are the popup's browser-facing
 * control-plane surfaces: the edge forwards them here (T-0015), stripped of
 * cookies, credentials, and everything else the safelist drops — the nonce
 * entry keys identity off the single-use nonce server-side, exactly as the
 * callback keys off `state` (T-0020 adds that route).
 *
 * T-0016 ships the dev journey's nonce entry (`CONSENT_NONCE_ENTRY_PATH`):
 * GET navigation in, one indivisible redemption, a 302 to the vendor — or the
 * fixed refusal page. A malformed URL is a plain-text 400 (the edge start
 * route's posture: a probe, not a consent state).
 */
export async function connectionsPageRoutes(app: FastifyInstance): Promise<void> {
  /** Custody is required to open a provider's client id for the re-derived
   * authorize URL — the same guard the internal consult route holds. */
  const store = (): SecretStore => {
    if (!app.secretStore) {
      throw new AppError("capability_unavailable", "secret store is not configured");
    }
    return app.secretStore;
  };

  /** Plain-text 400 for a malformed URL — fixed string, nothing echoed. */
  const sendBadRequest = (reply: FastifyReply): void => {
    reply
      .status(400)
      .header("cache-control", "no-store")
      .type("text/plain; charset=utf-8")
      .send("Invalid connection link.\n");
  };

  app.get(CONSENT_NONCE_ENTRY_PATH, async (req, reply) => {
    // The nonce is the URL's only carriage (criterion 22). A repeated value
    // is a probe, refused like a malformed one — nothing is redeemed.
    const values = new URL(req.raw.url ?? "/", "http://page.invalid").searchParams.getAll("nonce");
    const parsed = values.length === 1 ? ConsentNonceSchema.safeParse(values[0]) : null;
    if (!parsed || !parsed.success) {
      sendBadRequest(reply);
      return;
    }

    let redemption: ConsentNonceRedemption;
    try {
      redemption = await redeemConsentNonce(
        app.prisma,
        store(),
        parsed.data,
        // The callback URL the re-derived authorize request binds: the
        // reserved-subdomain derivation (ADR-0001's ratified residual), not
        // an edge call and not configuration.
        connectionsCallbackUrl(),
      );
    } catch {
      // Fixed-string log fields only — no nonce, no protocol material.
      req.log.warn({ event: "consent.nonce_entry_failed" }, "nonce redemption failed");
      sendConsentServiceFailurePage(reply);
      return;
    }

    if (!redemption.redeemed) {
      // Unknown, replayed, expired, cancelled, stale provider: one fixed
      // refusal page, always 200 (indistinguishable on purpose).
      sendConsentRefusalPage(reply);
      return;
    }

    // Redirect hygiene, as the prod start route: the URL comes from the
    // provider row's configuration; https-only before it becomes a Location.
    const target = new URL(redemption.authorizeUrl);
    if (target.protocol !== "https:") {
      sendConsentServiceFailurePage(reply);
      return;
    }
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .redirect(target.toString(), 302);
  });
}
