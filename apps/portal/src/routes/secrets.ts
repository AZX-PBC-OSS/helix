import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  EnvSchema,
  InjectionRecipeSchema,
  SecretCreateRequestSchema,
  SecretGrantRequestSchema,
  SecretRotateRequestSchema,
  type SecretMetadata,
  type SecretScope,
} from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";
import { authenticate, ownsApp, requireActor, requireAdmin } from "../plugins/auth.js";
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
  env: string;
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
    env: row.env === "dev" ? "dev" : "prod",
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

  /**
   * Release a superseded `material` — **non-throwing, but never silent**.
   *
   * Every caller has already committed the row change, so failing the request now
   * would be strictly worse than reporting it. But against Key Vault a swallowed
   * failure strands a live vault entry still holding the old credential — exactly
   * the leak `destroy()` exists to prevent (ADR-0006). So a failure becomes an
   * operator-visible `secret.destroy_failed` audit event, not a dropped promise.
   *
   * The `ref` is recorded only for `kv:` material, which is a *reference* and is
   * what an operator needs to find the orphan. Dev `aesgcm:` material is the
   * ciphertext itself and is never copied into the audit table.
   */
  const release = async (
    material: string,
    ctx: {
      appId: string | null;
      actor: string;
      scope: string;
      env: string;
      name: string;
      reason: "rotate" | "delete" | "create-rollback";
    },
  ): Promise<void> => {
    try {
      await store().destroy(material);
    } catch (err) {
      const ref = material.startsWith("kv:") ? material : undefined;
      app.log.error({ err, ...ctx, ref }, "secret destroy failed — vault entry may be stranded");
      await audit(ctx.appId, ctx.actor, "secret.destroy_failed", {
        scope: ctx.scope,
        env: ctx.env,
        name: ctx.name,
        reason: ctx.reason,
        ...(ref ? { ref } : {}),
      }).catch((auditErr: unknown) => {
        app.log.error({ err: auditErr }, "could not record secret.destroy_failed");
      });
    }
  };

  // ── App-scoped secrets (owner) ────────────────────────────────────────────

  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/secrets",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
      requireActor(req);
      const appRow = await findApp(req.params.slug);
      // Both tiers (dev-mode §6): each row's metadata carries `env`, so the owner
      // sees prod + dev connection secrets side by side. Uniqueness is per-env
      // (appId, env, name), so a name can appear once per tier.
      const rows = await app.prisma.appSecret.findMany({
        where: { scope: "app", appId: appRow.id },
        orderBy: [{ env: "asc" }, { createdAt: "asc" }],
      });
      return rows.map((r) => toMetadata(r));
    },
  );

  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/secrets",
    { preHandler: [authenticate, ownsApp] },
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
            env: body.env,
            name: body.name,
            material,
            injection: body.injection,
            createdBy: actor.sub,
          },
        });
      } catch (err) {
        await release(material, {
          appId: appRow.id,
          actor: actor.sub,
          scope: "app",
          env: body.env,
          name: body.name,
          reason: "create-rollback",
        });
        if (isUniqueViolation(err)) {
          throw new AppError(
            "conflict",
            `${body.env} secret "${body.name}" already exists for this app`,
          );
        }
        throw err;
      }
      await audit(appRow.id, actor.sub, "secret.created", {
        scope: "app",
        env: body.env,
        name: body.name,
      });
      reply.status(201);
      return toMetadata(row);
    },
  );

  app.post<{ Params: { slug: string; name: string } }>(
    "/api/v1/apps/:slug/secrets/:name/rotate",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
      const actor = requireActor(req);
      const appRow = await findApp(req.params.slug);
      const { value } = SecretRotateRequestSchema.parse(req.body);
      // `?env=prod|dev` (default prod) — the tier discriminator, since a name is
      // unique only within a tier (dev-mode §6).
      const env = EnvSchema.default("prod").parse((req.query as { env?: string }).env);
      const row = await app.prisma.appSecret.findFirst({
        where: { scope: "app", appId: appRow.id, env, name: req.params.name },
      });
      if (!row) throw new AppError("not_found", `secret "${req.params.name}" not found`);
      const material = await store().seal(value);
      const updated = await app.prisma.appSecret.update({
        where: { id: row.id },
        data: { material, rotatedAt: new Date() },
      });
      await release(row.material, {
        appId: appRow.id,
        actor: actor.sub,
        scope: "app",
        env,
        name: row.name,
        reason: "rotate",
      });
      await audit(appRow.id, actor.sub, "secret.rotated", { scope: "app", env, name: row.name });
      return toMetadata(updated);
    },
  );

  app.delete<{ Params: { slug: string; name: string } }>(
    "/api/v1/apps/:slug/secrets/:name",
    { preHandler: [authenticate, ownsApp] },
    async (req, reply) => {
      const actor = requireActor(req);
      const appRow = await findApp(req.params.slug);
      const env = EnvSchema.default("prod").parse((req.query as { env?: string }).env);
      const row = await app.prisma.appSecret.findFirst({
        where: { scope: "app", appId: appRow.id, env, name: req.params.name },
      });
      if (!row) throw new AppError("not_found", `secret "${req.params.name}" not found`);
      await app.prisma.appSecret.delete({ where: { id: row.id } });
      await release(row.material, {
        appId: appRow.id,
        actor: actor.sub,
        scope: "app",
        env,
        name: row.name,
        reason: "delete",
      });
      await audit(appRow.id, actor.sub, "secret.deleted", { scope: "app", env, name: row.name });
      reply.status(204);
    },
  );

  // ── Global + platform secrets (admin) ─────────────────────────────────────

  app.get("/api/v1/secrets", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const rows = await app.prisma.appSecret.findMany({
      where: { scope: { in: [...ADMIN_SCOPES] }, env: "prod" },
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
    // on the appId-less scopes is not expressible in the Prisma schema). Pinned to
    // the prod tier — uniqueness is now per-env (dev-mode §6); step 2 parametrizes it.
    const existing = await app.prisma.appSecret.findFirst({
      where: { scope: body.scope, env: "prod", name: body.name },
    });
    if (existing) {
      throw new AppError("conflict", `${body.scope} secret "${body.name}" already exists`);
    }
    const material = await store().seal(body.value);
    const row = await app.prisma.appSecret.create({
      data: {
        scope: body.scope,
        appId: null,
        env: "prod",
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
      await release(row.material, {
        appId: null,
        actor: actor.sub,
        scope: row.scope,
        env: row.env,
        name: row.name,
        reason: "rotate",
      });
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
      await release(row.material, {
        appId: null,
        actor: actor.sub,
        scope: row.scope,
        env: row.env,
        name: row.name,
        reason: "delete",
      });
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
