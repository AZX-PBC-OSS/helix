import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";

/**
 * Serve the built portal SPA (apps/portal-web/dist) — project plan §1: the
 * SPA is "served statically by the portal container". Deep links (/apps/x)
 * fall back to index.html via the not-found handler in plugins/errors.ts,
 * which consults the `spaDist` decoration; /api and /health keep their JSON
 * semantics.
 */

declare module "fastify" {
  interface FastifyInstance {
    /** Directory of the built SPA, or null (stopgap dashboard mode). */
    spaDist: string | null;
  }
}

/** Find a built SPA: $PORTAL_WEB_DIST, else the workspace sibling package. */
export function resolveSpaDist(): string | null {
  const dist =
    process.env.PORTAL_WEB_DIST ??
    fileURLToPath(new URL("../../../portal-web/dist", import.meta.url));
  return existsSync(path.join(dist, "index.html")) ? dist : null;
}

// fp: the reply.sendFile decoration must land on the root context — the
// errors plugin's not-found handler uses it for the deep-link fallback.
export const spaRoutes = fp(
  async (app) => {
    if (!app.spaDist) return;
    await app.register(fastifyStatic, {
      root: app.spaDist,
      wildcard: false,
      index: ["index.html"],
    });
  },
  { name: "spa" },
);
