import type { FastifyInstance, FastifyRequest } from "fastify";
import { SetRepoBindingRequestSchema, type RepoBinding } from "@azx-pbc/shared";
import type { RepoBinding as RepoBindingRow } from "../db/client.js";
import { resolveRepoDeployConfig } from "../deployment.js";
import { authenticate, ownsApp, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { rejectArchived } from "./versions.js";

/**
 * An app's GitHub binding (ADR-0051 decision 2): which repo and branch may
 * upload previews from CI. Owner-set app config behind `authenticate` +
 * `ownsApp`, like any other app setting. There is no ownership-proof step: a
 * binding grants deploy rights into the binder's own app, so a wrong one can
 * only hurt the owner who made it.
 */

function toBinding(row: RepoBindingRow): RepoBinding {
  return {
    provider: "github",
    repoFullName: row.repoFullName,
    branch: row.branch,
    ...(row.workflowRef !== null ? { workflowRef: row.workflowRef } : {}),
    ...(row.environment !== null ? { environment: row.environment } : {}),
    ...(row.repositoryId !== null ? { repositoryId: row.repositoryId } : {}),
    ...(row.repositoryOwnerId !== null ? { repositoryOwnerId: row.repositoryOwnerId } : {}),
    ...(row.pinnedAt !== null ? { pinnedAt: row.pinnedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Disabled on this portal: the routes don't exist, so answer like they don't. */
async function requireRepoDeployEnabled(req: FastifyRequest): Promise<void> {
  if (!resolveRepoDeployConfig().enabled) {
    throw new AppError("not_found", `route ${req.method} ${req.routeOptions.url} not found`);
  }
}

export async function repoBindingRoutes(app: FastifyInstance): Promise<void> {
  const findApp = async (slug: string) => {
    const row = await app.prisma.app.findUnique({ where: { slug } });
    if (!row) throw new AppError("not_found", `app "${slug}" not found`);
    return row;
  };

  const path = "/api/v1/apps/:slug/repo-binding";

  // Owner-gated read, unlike most app reads: the binding names who can deploy.
  app.get<{ Params: { slug: string } }>(
    path,
    { preHandler: [requireRepoDeployEnabled, authenticate, ownsApp] },
    async (req) => {
      const appRow = await findApp(req.params.slug);
      const row = await app.prisma.repoBinding.findUnique({ where: { appId: appRow.id } });
      // `details.reason` tells "no binding" apart from "no such app" or a
      // disabled feature, all of which are also 404s.
      if (!row)
        throw new AppError("not_found", "this app has no repo binding", { reason: "no_binding" });
      return toBinding(row);
    },
  );

  // Create or replace. Changing the repository clears the pinned ids, so the
  // next deploy pins the new repo; changing anything else keeps them.
  app.put<{ Params: { slug: string } }>(
    path,
    { preHandler: [requireRepoDeployEnabled, authenticate, ownsApp] },
    async (req) => {
      const actor = requireActor(req);
      const appRow = await findApp(req.params.slug);
      rejectArchived(appRow);
      const body = SetRepoBindingRequestSchema.parse(req.body);

      const row = await app.prisma.$transaction(async (tx) => {
        const existing = await tx.repoBinding.findUnique({ where: { appId: appRow.id } });
        const repoChanged =
          !existing || existing.repoFullName.toLowerCase() !== body.repoFullName.toLowerCase();
        const fields = {
          repoFullName: body.repoFullName,
          branch: body.branch,
          workflowRef: body.workflowRef ?? null,
          environment: body.environment ?? null,
          ...(repoChanged ? { repositoryId: null, repositoryOwnerId: null, pinnedAt: null } : {}),
        };
        const saved = existing
          ? await tx.repoBinding.update({ where: { appId: appRow.id }, data: fields })
          : await tx.repoBinding.create({
              data: { ...fields, appId: appRow.id, createdBy: actor.oid },
            });
        await tx.auditEvent.create({
          data: {
            appId: appRow.id,
            actor: actor.sub,
            action: "app.repo-binding.set",
            metadata: {
              repoFullName: body.repoFullName,
              branch: body.branch,
              workflowRef: body.workflowRef ?? null,
              environment: body.environment ?? null,
              pinsCleared: Boolean(existing) && repoChanged,
            },
          },
        });
        return saved;
      });
      return toBinding(row);
    },
  );

  // Idempotent: removing a binding that isn't there is a 204 with no audit row.
  app.delete<{ Params: { slug: string } }>(
    path,
    { preHandler: [requireRepoDeployEnabled, authenticate, ownsApp] },
    async (req, reply) => {
      const actor = requireActor(req);
      const appRow = await findApp(req.params.slug);
      await app.prisma.$transaction(async (tx) => {
        const removed = await tx.repoBinding.deleteMany({ where: { appId: appRow.id } });
        if (removed.count > 0) {
          await tx.auditEvent.create({
            data: { appId: appRow.id, actor: actor.sub, action: "app.repo-binding.delete" },
          });
        }
      });
      reply.status(204).send();
    },
  );
}
