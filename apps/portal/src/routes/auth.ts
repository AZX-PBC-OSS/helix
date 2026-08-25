import type { FastifyInstance } from "fastify";
import { AuthConfigResponseSchema, PortalMeResponseSchema } from "@azx-pbc/shared";
import { actorIsAdmin, authenticate, requireActor } from "../plugins/auth.js";
import { directorySearchAllowed, directorySearchTier } from "../policy/directoryPolicy.js";
import { AppError } from "../plugins/errors.js";

/** Auth-adjacent API surface: IdP discovery for the CLI, and actor echo. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public: the CLI bootstraps from here, so its only config is the portal
  // URL. 404 when the portal is dev-token-only (no IdP to discover).
  app.get("/api/v1/auth/config", async () => {
    const config = app.authPublicConfig;
    if (!config) {
      throw new AppError("not_found", "OIDC is not configured on this portal");
    }
    return AuthConfigResponseSchema.parse(config);
  });

  // Who am I, per the verifier chain — powers `helix whoami` and the v1 SPA.
  app.get("/api/v1/me", { preHandler: authenticate }, async (req) => {
    const actor = requireActor(req);
    const canSearch = directorySearchAllowed(actor);
    const tier = directorySearchTier();
    const restriction = tier === "everyone" ? undefined : tier;
    return PortalMeResponseSchema.parse({
      sub: actor.sub,
      via: actor.via,
      ...(actor.name ? { name: actor.name } : {}),
      ...(actor.email ? { email: actor.email } : {}),
      isAdmin: actorIsAdmin(actor),
      canSearchDirectory: canSearch,
      // Only when refused, and never `everyone` — that tier refuses nobody, so
      // the branch cannot produce it. A caller who may search learns nothing
      // about the posture; one who may not learns which rule stopped them, which
      // is what lets the picker say something true under both narrow tiers
      // instead of naming platform admins under a tier that excludes them too.
      ...(canSearch ? {} : { searchRestriction: restriction }),
    });
  });
}
