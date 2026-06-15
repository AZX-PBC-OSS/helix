import type { FastifyInstance } from "fastify";
import {
  CapabilitiesSchema,
  CreateAppRequestSchema,
  SetManifestRequestSchema,
} from "@helix/shared";
import { authenticate, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";
import { toApp, toManifest, visibilityToColumns } from "../db/mappers.js";

/** App registry routes: create, list, get (architecture §7). */
export async function appRoutes(app: FastifyInstance): Promise<void> {
  // Create an app. Mutating — requires the dev token.
  app.post("/api/v1/apps", { preHandler: authenticate }, async (req, reply) => {
    const body = CreateAppRequestSchema.parse(req.body);
    const actor = requireActor(req);
    const { visibilityMode, visibilityGroupId } = visibilityToColumns(body.visibility);
    // Fill capability defaults so the stored shape always parses on read.
    const capabilities = CapabilitiesSchema.parse(body.capabilities ?? {});

    let row;
    try {
      row = await app.prisma.app.create({
        data: {
          slug: body.slug,
          displayName: body.displayName,
          visibilityMode,
          visibilityGroupId,
          capabilities,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err, "slug")) {
        throw new AppError("slug_taken", `slug "${body.slug}" is already taken`);
      }
      throw err;
    }

    await app.prisma.auditEvent.create({
      data: { appId: row.id, actor: actor.sub, action: "app.create", metadata: { slug: row.slug } },
    });

    reply.status(201).send(toApp(row));
  });

  // List all apps. Read — open.
  app.get("/api/v1/apps", async () => {
    const rows = await app.prisma.app.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(toApp);
  });

  // Get one app by slug. Read — open.
  app.get<{ Params: { slug: string } }>("/api/v1/apps/:slug", async (req) => {
    const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
    if (!row) {
      throw new AppError("not_found", `app "${req.params.slug}" not found`);
    }
    return toApp(row);
  });

  // Archive an app: the edge serves 410 + Clear-Site-Data for it (architecture
  // §7). Mutating — requires the dev token. Idempotent.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/archive",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      if (row.archivedAt) {
        return toApp(row); // already archived — idempotent
      }
      const updated = await app.prisma.app.update({
        where: { id: row.id },
        data: { archivedAt: new Date() },
      });
      await app.prisma.auditEvent.create({
        data: { appId: row.id, actor: actor.sub, action: "app.archive", metadata: {} },
      });
      return toApp(updated);
    },
  );

  // Un-archive an app. Mutating — requires the dev token. Idempotent.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/unarchive",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      if (!row.archivedAt) {
        return toApp(row); // not archived — idempotent
      }
      const updated = await app.prisma.app.update({
        where: { id: row.id },
        data: { archivedAt: null },
      });
      await app.prisma.auditEvent.create({
        data: { appId: row.id, actor: actor.sub, action: "app.unarchive", metadata: {} },
      });
      return toApp(updated);
    },
  );

  // Get an app's manifest (slug + visibility + capability grants, §6.3). Read — open.
  app.get<{ Params: { slug: string } }>("/api/v1/apps/:slug/manifest", async (req) => {
    const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
    if (!row) {
      throw new AppError("not_found", `app "${req.params.slug}" not found`);
    }
    return toManifest(row);
  });

  // Replace an app's capability grants (architecture §6.3). Mutating — bearer
  // token. The gateway picks the change up via the edge's registry projection.
  // (Per-app approval policy is a v1 control-plane feature; v0 trusts any
  // authenticated portal principal — same level as every other mutation here.)
  app.put<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/manifest",
    { preHandler: authenticate },
    async (req) => {
      const { capabilities } = SetManifestRequestSchema.parse(req.body);
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      const updated = await app.prisma.app.update({
        where: { id: row.id },
        data: { capabilities },
      });
      await app.prisma.auditEvent.create({
        data: {
          appId: row.id,
          actor: actor.sub,
          action: "app.manifest.set",
          metadata: { capabilities },
        },
      });
      return toManifest(updated);
    },
  );
}
