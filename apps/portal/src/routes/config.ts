import type { FastifyInstance } from "fastify";
import { DeploymentConfigResponseSchema } from "@azx-pbc/shared";
import {
  resolveAppPublicBase,
  resolveDevApiBase,
  resolvePlatformMonthlyUsdCap,
} from "../deployment.js";

/**
 * The deployment-config bootstrap. Public, like `/api/v1/auth/config` — the
 * portal SPA fetches it before sign-in, and nothing here is sensitive: it is the
 * same topology any visitor reads off an app URL.
 *
 * Deliberately NOT folded into `/api/v1/auth/config`, which 404s when the portal
 * has no IdP (dev-token-only) — coupling the apps domain to whether OIDC is
 * configured would leave a local portal's SPA with no base at all. This route
 * always answers.
 */
export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/config", async () => {
    const devApiBase = resolveDevApiBase();
    const cap = resolvePlatformMonthlyUsdCap();
    // Optional fields are omitted, not nulled: absent means "not enabled on this
    // deployment", and the client hides that surface rather than guessing.
    return DeploymentConfigResponseSchema.parse({
      appPublicBase: resolveAppPublicBase().origin,
      ...(devApiBase ? { devApiBase: devApiBase.origin } : {}),
      ...(cap !== null ? { platformMonthlyUsdCap: cap } : {}),
    });
  });
}
