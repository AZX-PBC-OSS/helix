import type { FastifyInstance } from "fastify";
import { type DeployReport, DeployReportSchema, RollbackRequestSchema } from "@azx-pbc/shared";
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

      // Optional salvage provenance (ADR-0038), sent as a `report` field ahead of
      // the file. Client-asserted and unverifiable: parse-or-ignore, never a
      // deploy failure. `req.file()` exposes fields that preceded the file.
      const deployReport = readDeployReport(req, data.fields);

      const spooled = await spoolUpload(data.file);
      try {
        const { version, warnings } = await deployBundle({
          prisma: app.prisma,
          blobStore: app.blobStore,
          appId: appRow.id,
          actor: actor.sub,
          zipPath: spooled.zipPath,
          deployReport,
        });
        reply.status(201).send({ version: toVersion(version), warnings });
      } catch (err) {
        // Advisory only (ADR-0038 §9): add a whole-archive layout diagnosis to a
        // first-offender rejection. Never changes what is accepted or rejected —
        // and never hides the original reason (ADR-0038 #3): a symlink / zip-slip /
        // compression-bomb / size rejection must stay visible and auditable, so
        // the diagnosis is *appended*, with the true reason kept in details.
        if (err instanceof AppError && err.code === "bundle_invalid") {
          const diag = await diagnoseBundle(spooled.zipPath);
          if (diag) {
            throw new AppError("bundle_invalid", `${err.message} — ${diag.message}`, {
              reason: err.message,
              ...(diag.details as Record<string, unknown>),
            });
          }
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

/** Max bytes of the `report` field we'll parse — a report is well under 8 KB. */
const MAX_REPORT_BYTES = 8192;

/**
 * Read the optional client-asserted deploy report (ADR-0038). Bounded and
 * schema-checked; an oversized, unparseable, or invalid value is logged and
 * ignored — it must never fail a deploy. Returns undefined when absent.
 */
function readDeployReport(
  req: { log: { warn: (msg: string) => void } },
  fields: Record<string, unknown> | undefined,
): DeployReport | undefined {
  const field = fields?.report as { type?: string; value?: unknown } | undefined;
  if (!field || field.type !== "field" || typeof field.value !== "string") return undefined;
  if (Buffer.byteLength(field.value) > MAX_REPORT_BYTES) {
    req.log.warn("ignoring oversized deploy report");
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(field.value);
  } catch {
    req.log.warn("ignoring unparseable deploy report");
    return undefined;
  }
  const parsed = DeployReportSchema.safeParse(json);
  if (!parsed.success) {
    req.log.warn("ignoring invalid deploy report");
    return undefined;
  }
  return parsed.data;
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
