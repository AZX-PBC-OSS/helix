import type { FastifyInstance } from "fastify";
import { RollbackRequestSchema } from "@azx-pbc/shared";
import { toApp, toVersion } from "../db/mappers.js";
import { authenticate, ownsApp, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { deployBundle, spoolUpload } from "../deploy/upload.js";
import { diagnoseBundle } from "../deploy/diagnose.js";
import { setLiveVersion } from "../deploy/pointer.js";

/** Deploy routes: upload a version and list versions (architecture §5, §7). */
export async function versionRoutes(app: FastifyInstance): Promise<void> {
  // Upload a bundle as a new preview version. Mutating — requires the dev token.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/versions",
    { preHandler: [authenticate, ownsApp] },
    async (req, reply) => {
      const actor = requireActor(req);
      const appRow = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!appRow) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      rejectArchived(appRow);

      const data = await req.file();
      if (!data) {
        throw new AppError("bundle_invalid", "request has no bundle file");
      }
      if (data.fieldname !== "bundle") {
        throw new AppError(
          "bundle_invalid",
          `unexpected field "${data.fieldname}", expected "bundle"`,
        );
      }

      const spooled = await spoolUpload(data.file);
      try {
        const { version, warnings } = await deployBundle({
          prisma: app.prisma,
          blobStore: app.blobStore,
          appId: appRow.id,
          actor: actor.sub,
          zipPath: spooled.zipPath,
        });
        reply.status(201).send({ version: toVersion(version), warnings });
      } catch (err) {
        // Advisory only (ADR-0038 §9): rewrite a first-offender rejection into a
        // whole-archive diagnosis. Never changes what is accepted or rejected.
        if (err instanceof AppError && err.code === "bundle_invalid") {
          const diag = await diagnoseBundle(spooled.zipPath);
          if (diag) throw new AppError("bundle_invalid", diag.message, diag.details);
        }
        throw err;
      } finally {
        await spooled.cleanup();
      }
    },
  );

  // List an app's versions, newest first. Read — sign-in required.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/versions",
    { preHandler: authenticate },
    async (req) => {
      const appRow = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!appRow) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      const rows = await app.prisma.version.findMany({
        where: { appId: appRow.id },
        orderBy: { number: "desc" },
      });
      return rows.map(toVersion);
    },
  );

  // Promote a preview version to live (flip the pointer). Mutating.
  app.post<{ Params: { slug: string; number: string } }>(
    "/api/v1/apps/:slug/versions/:number/promote",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
      const actor = requireActor(req);
      const appRow = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!appRow) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      rejectArchived(appRow);
      const number = parseVersionNumber(req.params.number);
      const target = await app.prisma.version.findUnique({
        where: { appId_number: { appId: appRow.id, number } },
      });
      if (!target) {
        throw new AppError("not_found", `version ${number} not found`);
      }
      if (target.id === appRow.currentVersionId) {
        return toApp(appRow); // already live — idempotent
      }
      if (target.status === "archived") {
        throw new AppError(
          "conflict",
          `version ${number} is archived; use rollback to re-promote it`,
        );
      }

      const updated = await setLiveVersion({
        prisma: app.prisma,
        appId: appRow.id,
        versionId: target.id,
        action: "version.promote",
        actor: actor.sub,
      });
      return toApp(updated);
    },
  );

  // Roll back to a previous version. Mutating. Body { toNumber? } — defaults to
  // the most recently archived (previously live) version.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/rollback",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
      const actor = requireActor(req);
      const { toNumber } = RollbackRequestSchema.parse(req.body ?? {});
      const appRow = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!appRow) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      rejectArchived(appRow);

      const target =
        toNumber !== undefined
          ? await app.prisma.version.findUnique({
              where: { appId_number: { appId: appRow.id, number: toNumber } },
            })
          : await app.prisma.version.findFirst({
              where: { appId: appRow.id, status: "archived" },
              orderBy: { number: "desc" },
            });

      if (!target) {
        throw new AppError(
          toNumber !== undefined ? "not_found" : "conflict",
          toNumber !== undefined
            ? `version ${toNumber} not found`
            : "no previous version to roll back to",
        );
      }
      if (target.id === appRow.currentVersionId) {
        return toApp(appRow); // already live — idempotent
      }

      const updated = await setLiveVersion({
        prisma: app.prisma,
        appId: appRow.id,
        versionId: target.id,
        action: "version.rollback",
        actor: actor.sub,
      });
      return toApp(updated);
    },
  );
}

/** Archived apps are frozen: no uploads or pointer moves until unarchived. */
function rejectArchived(appRow: { slug: string; archivedAt: Date | null }): void {
  if (appRow.archivedAt) {
    throw new AppError("conflict", `app "${appRow.slug}" is archived; unarchive it first`);
  }
}

function parseVersionNumber(raw: string): number {
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) {
    throw new AppError("validation_failed", `invalid version number: ${raw}`);
  }
  return number;
}
