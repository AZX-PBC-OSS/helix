import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { blockedTermIn } from "@azx-pbc/shared";
import { parseRequest, portal, responseBody } from "@azx-pbc/shared/contracts";
import { requireAdmin } from "../plugins/auth.js";
import { contractRoute } from "../plugins/contractRoute.js";
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

  contractRoute(app, portal.getPlatformSettings, async (req) => {
    requireAdmin(req);
    const row = await app.prisma.platformSettings.findUnique({ where: { id: 1 } });
    return responseBody(portal.getPlatformSettings, 200, {
      operatorName: row?.operatorName ?? null,
      operatorDescription: row?.operatorDescription ?? null,
      operatorContactUrl: row?.operatorContactUrl ?? null,
      // The migration seeds the row with no author; report it as never edited.
      updatedAt: row?.updatedBy ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    });
  });

  contractRoute(app, portal.updatePlatformSettings, async (req) => {
    const actor = requireAdmin(req);
    const { body } = parseRequest(portal.updatePlatformSettings, req);
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
    return responseBody(portal.updatePlatformSettings, 200, {
      operatorName: row.operatorName,
      operatorDescription: row.operatorDescription,
      operatorContactUrl: row.operatorContactUrl,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    });
  });

  contractRoute(app, portal.listBlockedSlugTerms, async (req) => {
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
    return responseBody(portal.listBlockedSlugTerms, 200, {
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

  contractRoute(app, portal.createBlockedSlugTerm, async (req, reply) => {
    const actor = requireAdmin(req);
    const { body } = parseRequest(portal.createBlockedSlugTerm, req);
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
    return reply.code(201).send(
      responseBody(portal.createBlockedSlugTerm, 201, {
        id: row.id,
        term: row.term,
        note: row.note,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  });

  contractRoute(app, portal.deleteBlockedSlugTerm, async (req, reply) => {
    const actor = requireAdmin(req);
    const {
      params: { id },
    } = parseRequest(portal.deleteBlockedSlugTerm, req);
    const parsed = z.uuid().safeParse(id);
    const row = parsed.success
      ? await app.prisma.blockedSlugTerm.findUnique({ where: { id: parsed.data } })
      : null;
    if (!row) throw new AppError("not_found", "blocked term not found");
    await app.prisma.blockedSlugTerm.deleteMany({ where: { id: row.id } });
    await audit("slug_term.removed", actor.sub, { term: row.term });
    return reply.code(204).send();
  });

  contractRoute(app, portal.getPlatformConfig, async (req) => {
    requireAdmin(req);
    return responseBody(portal.getPlatformConfig, 200, { entries: platformConfigEntries() });
  });
}
