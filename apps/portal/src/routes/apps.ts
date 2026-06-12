import type { FastifyInstance } from "fastify";
import { CreateAppRequestSchema } from "@helix/shared";
import { authenticate, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";
import { toApp, visibilityToColumns } from "../db/mappers.js";

/** App registry routes: create, list, get (architecture §7). */
export async function appRoutes(app: FastifyInstance): Promise<void> {
  // Create an app. Mutating — requires the dev token.
  app.post("/api/v1/apps", { preHandler: authenticate }, async (req, reply) => {
    const body = CreateAppRequestSchema.parse(req.body);
    const actor = requireActor(req);
    const { visibilityMode, visibilityGroupId } = visibilityToColumns(body.visibility);

    let row;
    try {
      row = await app.prisma.app.create({
        data: { slug: body.slug, displayName: body.displayName, visibilityMode, visibilityGroupId },
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
}
