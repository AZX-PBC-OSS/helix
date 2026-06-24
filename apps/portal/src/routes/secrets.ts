import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  InjectionRecipeSchema,
  SecretCreateRequestSchema,
  SecretGrantRequestSchema,
  SecretRotateRequestSchema,
  type SecretMetadata,
  type SecretScope,
} from "@helix/shared";
import type { SecretStore } from "@helix/secret-store";
import { authenticate, requireActor, requireAdmin } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";

/**
 * Connection-secret CRUD (secrets design §5). Three families:
 *  - app-scoped (`/api/v1/apps/:slug/secrets`) — the app owner manages its own.
 *  - global (`/api/v1/secrets`) — admin-only; shared across apps via grants.
 *  - platform (`/api/v1/secrets`, `scope:"platform"`) — admin-only platform vendor
 *    credentials (the LLM key). No grants and no manifest binding: resolvable by
 *    egress only on the `llm` capability path, never via an app's fetch binding.
 *
 * **Write-only / rotate-only**: the value crosses the API boundary only on
 * create/rotate, is sealed by the {@link SecretStore}, and is never returned —
 * there is deliberately no re-display route (unlike the password credential).
 * Binding a secret to an app is a *manifest* change and rides the approval
 * write-gate (PUT /manifest); these routes manage the credential itself.
 */

/** The two admin-managed (appId-less) scopes; `app` secrets use the owner routes. */
const ADMIN_SCOPES = ["global", "platform"] as const;

/** Admin create body: the shared create shape plus the target scope (default global). */
const AdminSecretCreateSchema = SecretCreateRequestSchema.extend({
  scope: z.enum(ADMIN_SCOPES).default("global"),
});

interface SecretRow {
  id: string;
  name: string;
  scope: string;
  injection: unknown;
  createdBy: string;
  createdAt: Date;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
}

function toMetadata(row: SecretRow, boundApps: string[] = []): SecretMetadata {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as SecretScope,
    injection: InjectionRecipeSchema.parse(row.injection),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    boundApps,
  };
}

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  // Custody must be configured (a KEK in dev / Key Vault in prod) to seal.
  const store = (): SecretStore => {
    if (!app.secretStore) {
      throw new AppError("capability_unavailable", "secret store is not configured");
    }
    return app.secretStore;
  };

  const findApp = async (slug: string) => {
    const row = await app.prisma.app.findUnique({ where: { slug } });
    if (!row) throw new AppError("not_found", `app "${slug}" not found`);
    return row;
  };

  const audit = (appId: string | null, actor: string, action: string, metadata: object = {}) =>
    app.prisma.auditEvent.create({ data: { appId, actor, action, metadata } });

  // ── App-scoped secrets (owner) ────────────────────────────────────────────

  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/secrets",
    { preHandler: authenticate },
    async (req) => {
      requireActor(req);
      const appRow = await findApp(req.params.slug);
      const rows = await app.prisma.appSecret.findMany({
        where: { scope: "app", appId: appRow.id },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((r) => toMetadata(r));
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/secrets",
    { preHandler: authenticate },
    async (req, reply) => {
      const actor = requireActor(req);
      const appRow = await findApp(req.params.slug);
      const body = SecretCreateRequestSchema.parse(req.body);
      const material = await store().seal(body.value);
      let row;
      try {
        row = await app.prisma.appSecret.create({
          data: {
            scope: "app",
            appId: appRow.id,
            name: body.name,
            material,
            injection: body.injection,
            createdBy: actor.sub,
          },
        });
      } catch (err) {
        await store()
          .destroy(material)
          .catch(() => {});
        if (isUniqueViolation(err)) {
          throw new AppError("conflict", `secret "${body.name}" already exists for this app`);
        }
        throw err;
      }
      await audit(appRow.id, actor.sub, "secret.created", { scope: "app", name: body.name });
      reply.status(201);
      return toMetadata(row);
    },
  );

  app.post<{ Params: { slug: string; name: string } }>(
    "/api/v1/apps/:slug/secrets/:name/rotate",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireActor(req);
      const appRow = await findApp(req.params.slug);
      const { value } = SecretRotateRequestSchema.parse(req.body);
      const row = await app.prisma.appSecret.findFirst({
        where: { scope: "app", appId: appRow.id, name: req.params.name },
      });
      if (!row) throw new AppError("not_found", `secret "${req.params.name}" not found`);
      const material = await store().seal(value);
      const updated = await app.prisma.appSecret.update({
        where: { id: row.id },
        data: { material, rotatedAt: new Date() },
      });
      await store()
        .destroy(row.material)
        .catch(() => {});
      await audit(appRow.id, actor.sub, "secret.rotated", { scope: "app", name: row.name });
      return toMetadata(updated);
    },
  );

  app.delete<{ Params: { slug: string; name: string } }>(
    "/api/v1/apps/:slug/secrets/:name",
    { preHandler: authenticate },
    async (req, reply) => {
      const actor = requireActor(req);
      const appRow = await findApp(req.params.slug);
      const row = await app.prisma.appSecret.findFirst({
        where: { scope: "app", appId: appRow.id, name: req.params.name },
      });
      if (!row) throw new AppError("not_found", `secret "${req.params.name}" not found`);
      await app.prisma.appSecret.delete({ where: { id: row.id } });
      await store()
        .destroy(row.material)
        .catch(() => {});
      await audit(appRow.id, actor.sub, "secret.deleted", { scope: "app", name: row.name });
      reply.status(204);
    },
  );

  // ── Global + platform secrets (admin) ─────────────────────────────────────

  app.get("/api/v1/secrets", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const rows = await app.prisma.appSecret.findMany({
      where: { scope: { in: [...ADMIN_SCOPES] } },
      include: { grants: { include: { app: true } } },
      orderBy: [{ scope: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((r) =>
      toMetadata(
        r,
        r.grants.map((g) => g.app.slug),
      ),
    );
  });

  app.post("/api/v1/secrets", { preHandler: authenticate }, async (req, reply) => {
    const actor = requireAdmin(req);
    const body = AdminSecretCreateSchema.parse(req.body);
    // Name uniqueness within the scope is enforced here (a partial unique index
    // on the appId-less scopes is not expressible in the Prisma schema).
    const existing = await app.prisma.appSecret.findFirst({
      where: { scope: body.scope, name: body.name },
    });
    if (existing) {
      throw new AppError("conflict", `${body.scope} secret "${body.name}" already exists`);
    }
    const material = await store().seal(body.value);
    const row = await app.prisma.appSecret.create({
      data: {
        scope: body.scope,
        appId: null,
        name: body.name,
        material,
        injection: body.injection,
        createdBy: actor.sub,
      },
    });
    await audit(null, actor.sub, "secret.created", { scope: body.scope, name: body.name });
    reply.status(201);
    return toMetadata(row);
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/secrets/:id/rotate",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireAdmin(req);
      const { value } = SecretRotateRequestSchema.parse(req.body);
      const row = await app.prisma.appSecret.findFirst({
        where: { id: req.params.id, scope: { in: [...ADMIN_SCOPES] } },
      });
      if (!row) throw new AppError("not_found", "secret not found");
      const material = await store().seal(value);
      const updated = await app.prisma.appSecret.update({
        where: { id: row.id },
        data: { material, rotatedAt: new Date() },
      });
      await store()
        .destroy(row.material)
        .catch(() => {});
      await audit(null, actor.sub, "secret.rotated", { scope: row.scope, name: row.name });
      return toMetadata(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/secrets/:id",
    { preHandler: authenticate },
    async (req, reply) => {
      const actor = requireAdmin(req);
      const row = await app.prisma.appSecret.findFirst({
        where: { id: req.params.id, scope: { in: [...ADMIN_SCOPES] } },
      });
      if (!row) throw new AppError("not_found", "secret not found");
      await app.prisma.appSecret.delete({ where: { id: row.id } }); // cascades grants
      await store()
        .destroy(row.material)
        .catch(() => {});
      await audit(null, actor.sub, "secret.deleted", { scope: row.scope, name: row.name });
      reply.status(204);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/secrets/:id/grants",
    { preHandler: authenticate },
    async (req, reply) => {
      const actor = requireAdmin(req);
      const { appSlug } = SecretGrantRequestSchema.parse(req.body);
      const secret = await app.prisma.appSecret.findFirst({
        where: { id: req.params.id, scope: "global" },
      });
      if (!secret) throw new AppError("not_found", "global secret not found");
      const targetApp = await findApp(appSlug);
      try {
        await app.prisma.appSecretGrant.create({
          data: { secretId: secret.id, appId: targetApp.id, grantedBy: actor.sub },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError("conflict", `"${appSlug}" already holds this secret`);
        }
        throw err;
      }
      await audit(targetApp.id, actor.sub, "secret.granted", { name: secret.name, app: appSlug });
      reply.status(201);
      return { secretId: secret.id, appSlug };
    },
  );

  // By slug, symmetric with the grant route (which takes `appSlug`) and with the
  // `boundApps` slugs the metadata exposes.
  app.delete<{ Params: { id: string; appSlug: string } }>(
    "/api/v1/secrets/:id/grants/:appSlug",
    { preHandler: authenticate },
    async (req, reply) => {
      const actor = requireAdmin(req);
      const targetApp = await findApp(req.params.appSlug);
      await app.prisma.appSecretGrant.deleteMany({
        where: { secretId: req.params.id, appId: targetApp.id },
      });
      await audit(targetApp.id, actor.sub, "secret.revoked", {
        secretId: req.params.id,
        app: req.params.appSlug,
      });
      reply.status(204);
    },
  );
}
