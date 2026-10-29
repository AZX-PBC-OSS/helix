import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  BlockedSlugTermsResponseSchema,
  CreateBlockedSlugTermRequestSchema,
  PlatformConfigResponseSchema,
  PlatformSettingsResponseSchema,
  UpdatePlatformSettingsRequestSchema,
  blockedTermIn,
} from "@azx-pbc/shared";
import { authenticate, requireAdmin } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";
import { platformConfigEntries } from "../platformConfig.js";

/**
 * Platform Settings (admin only): the operator identity the edge shows on its
 * anonymous pages, the app-name terms refused at creation, and a read-only view
 * of this portal's configuration.
 */
export async function platformSettingsRoutes(app: FastifyInstance): Promise<void> {
  const audit = (action: string, actor: string, metadata: object = {}) =>
    app.prisma.auditEvent.create({ data: { appId: null, actor, action, metadata } });

  const operatorFields = {
    operatorName: true,
    operatorDescription: true,
    operatorContactUrl: true,
  } as const;

  app.get("/api/v1/admin/settings", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const row = await app.prisma.platformSettings.findUnique({ where: { id: 1 } });
    return PlatformSettingsResponseSchema.parse({
      operatorName: row?.operatorName ?? null,
      operatorDescription: row?.operatorDescription ?? null,
      operatorContactUrl: row?.operatorContactUrl ?? null,
      // The migration seeds the row with no author; report it as never edited.
      updatedAt: row?.updatedBy ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    });
  });

  app.put("/api/v1/admin/settings", { preHandler: authenticate }, async (req) => {
    const actor = requireAdmin(req);
    const body = UpdatePlatformSettingsRequestSchema.parse(req.body);
    const before = await app.prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: operatorFields,
    });
    const row = await app.prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...body, updatedBy: actor.sub },
      update: { ...body, updatedBy: actor.sub },
    });
    await audit("platform.settings.updated", actor.sub, { before, after: body });
    return PlatformSettingsResponseSchema.parse({
      operatorName: row.operatorName,
      operatorDescription: row.operatorDescription,
      operatorContactUrl: row.operatorContactUrl,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    });
  });

  app.get("/api/v1/admin/slug-terms", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const rows = await app.prisma.blockedSlugTerm.findMany({ orderBy: { term: "asc" } });
    const terms = rows.map((r) => r.term);
    // Terms apply only at creation, so list the live apps that already carry
    // one: the operator decides whether to archive them.
    const apps =
      terms.length === 0
        ? []
        : await app.prisma.app.findMany({
            where: { archivedAt: null },
            select: { slug: true, displayName: true },
            orderBy: { slug: "asc" },
          });
    const matchingApps = apps.flatMap((a) => {
      const term = blockedTermIn(a.slug, terms);
      return term ? [{ slug: a.slug, displayName: a.displayName, term }] : [];
    });
    return BlockedSlugTermsResponseSchema.parse({
      terms: rows.map((r) => ({
        id: r.id,
        term: r.term,
        note: r.note,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
      })),
      matchingApps,
    });
  });

  app.post("/api/v1/admin/slug-terms", { preHandler: authenticate }, async (req, reply) => {
    const actor = requireAdmin(req);
    const body = CreateBlockedSlugTermRequestSchema.parse(req.body);
    let row;
    try {
      row = await app.prisma.blockedSlugTerm.create({
        data: { term: body.term, note: body.note, createdBy: actor.sub },
      });
    } catch (err) {
      if (isUniqueViolation(err, "term")) {
        throw new AppError("conflict", `"${body.term}" is already blocked`);
      }
      throw err;
    }
    await audit("slug_term.added", actor.sub, { term: row.term, note: row.note });
    return reply.code(201).send({
      id: row.id,
      term: row.term,
      note: row.note,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    });
  });

  app.delete("/api/v1/admin/slug-terms/:id", { preHandler: authenticate }, async (req, reply) => {
    const actor = requireAdmin(req);
    const { id } = req.params as { id: string };
    const parsed = z.uuid().safeParse(id);
    const row = parsed.success
      ? await app.prisma.blockedSlugTerm.findUnique({ where: { id: parsed.data } })
      : null;
    if (!row) throw new AppError("not_found", "blocked term not found");
    await app.prisma.blockedSlugTerm.deleteMany({ where: { id: row.id } });
    await audit("slug_term.removed", actor.sub, { term: row.term });
    return reply.code(204).send();
  });

  app.get("/api/v1/admin/config", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    return PlatformConfigResponseSchema.parse({ entries: platformConfigEntries() });
  });
}
