import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  EnvSchema,
  type InjectionRecipe,
  SecretCreateRequestSchema,
  SecretGrantRequestSchema,
  SecretRotateRequestSchema,
  StoredInjectionRecipeSchema,
  type SecretMetadata,
  type SecretScope,
  validateMaterialForRecipe,
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

/**
 * Refuse material that does not fit its recipe, **before** sealing — so a bad
 * value never reaches the vault and no `release()` rollback is involved.
 *
 * Called on create *and* rotate: the recipe is immutable but the material is not,
 * so rotation is where the two can drift, and the dangerous direction is silent
 * (an hmac credential blob under a static recipe presents verbatim, putting the
 * private half of the key pair in a third party's access log in cleartext).
 *
 * The rethrown message is fixed and never interpolates the value: this is a
 * credential, and the underlying `JSON.parse` failure carries a prefix of its
 * input.
 */
function assertMaterialFits(recipe: InjectionRecipe, value: string): void {
  try {
    validateMaterialForRecipe(recipe, value);
  } catch {
    throw new AppError(
      "validation_failed",
      `value does not match this secret's ${recipe.kind} injection recipe`,
    );
  }
}

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

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Read a stored recipe, degrading to `null` rather than throwing.
   *
   * `injection` is a schemaless JSON column re-parsed on every read, so a row
   * that predates a tightened constraint can fail to parse — and an unguarded
   * `.parse` here failed the *whole response*, not the row. The admin list
   * queries `global` and `platform` together, so one bad platform row hid every
   * global secret, reported as a 400 no 5xx alerting would ever see.
   *
   * `StoredInjectionRecipeSchema` already tolerates hygiene violations; reaching
   * `null` means a *security* violation (a reserved header name) or a value that
   * is not a recipe at all. Both must stay visible so an operator can delete
   * them, which is why this degrades instead of hiding the row.
   */
  const readRecipe = (row: SecretRow): InjectionRecipe | null => {
    const parsed = StoredInjectionRecipeSchema.safeParse(row.injection);
    if (parsed.success) return parsed.data;
    app.log.warn(
      { secretId: row.id, scope: row.scope, env: row.env, name: row.name },
      "stored injection recipe is unreadable — this secret must be recreated",
    );
    return null;
  };

  /** For a route that must *act* on the recipe. Refuses rather than degrades. */
  const requireRecipe = (row: SecretRow): InjectionRecipe => {
    const recipe = readRecipe(row);
    if (!recipe) {
      // 409, not 400: the request body is fine — the resource state is what has
      // to change, and recipes are immutable, so that means delete-and-recreate.
      throw new AppError(
        "conflict",
        `secret "${row.name}" has an unreadable injection recipe — delete and recreate it`,
      );
    }
    return recipe;
  };

  const toMetadata = (row: SecretRow, boundApps: string[] = []): SecretMetadata => ({
    id: row.id,
    name: row.name,
    scope: row.scope as SecretScope,
    env: row.env === "dev" ? "dev" : "prod",
    injection: readRecipe(row),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    boundApps,
  });

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
   * Used in two directions. Post-commit (`rotate`, `delete`) the row change already
   * landed, so failing the request would be strictly worse than reporting it. In the
   * rollback direction (`create-rollback`, `rotate-rollback`) the row change did *not*
   * land and we are releasing material `seal()` already wrote to the vault. Either way a
   * swallowed failure strands a live vault entry — exactly the leak `destroy()` exists to
   * prevent (ADR-0006) — so it becomes an operator-visible `secret.destroy_failed` audit
   * event, not a dropped promise. The `reason` tells the two directions apart.
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
      reason: "rotate" | "delete" | "create-rollback" | "rotate-rollback";
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

  /**
   * Swap in freshly sealed `material`, then release the old — as a **compare-and-swap**
   * on the material we read.
   *
   * A plain `update` by id makes concurrent rotations last-write-wins, and each request
   * only releases the material *it* read. Both writes succeed, both release the same
   * original, and the loser's brand-new vault entry is left live, plaintext, and
   * referenced by nothing — under an opaque random name, so nothing can correlate it back.
   * Invisible in dev, where `destroy()` is a no-op and there is nothing to orphan.
   *
   * Losing the CAS is a 409, not a silent 200: the caller's value is not what is stored,
   * and saying otherwise would be a lie about a credential.
   */
  const rotateOrRelease = async (
    row: { id: string; material: string; name: string },
    material: string,
    ctx: { appId: string | null; actor: string; scope: string; env: string; name: string },
  ) => {
    const { count } = await app.prisma.appSecret.updateMany({
      where: { id: row.id, material: row.material },
      data: { material, rotatedAt: new Date() },
    });
    if (count === 0) {
      await release(material, { ...ctx, reason: "rotate-rollback" });
      throw new AppError(
        "conflict",
        `secret "${row.name}" was rotated concurrently — re-read it and retry`,
      );
    }
    await release(row.material, { ...ctx, reason: "rotate" });
    const updated = await app.prisma.appSecret.findUnique({ where: { id: row.id } });
    if (!updated) throw new AppError("not_found", `secret "${row.name}" not found`);
    return updated;
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
      assertMaterialFits(body.injection, body.value);
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
      // The recipe is immutable, so a rotation is where the material can drift away
      // from it. The row is already in hand for the not-found check and the CAS, so
      // this needs no extra query and no change to the rotate request schema.
      assertMaterialFits(requireRecipe(row), value);
      const material = await store().seal(value);
      const updated = await rotateOrRelease(row, material, {
        appId: appRow.id,
        actor: actor.sub,
        scope: "app",
        env,
        name: row.name,
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
    // A friendly pre-check, but *not* the guarantee — it's a non-atomic read-then-insert.
    // The partial unique index `app_secrets_admin_scope_name_key` is what actually holds
    // under concurrency (Postgres treats the NULL `appId` as distinct, so the model's
    // @@unique doesn't cover these scopes). Pinned to the prod tier — uniqueness is now
    // per-env (dev-mode §6); step 2 parametrizes it.
    const existing = await app.prisma.appSecret.findFirst({
      where: { scope: body.scope, env: "prod", name: body.name },
    });
    if (existing) {
      throw new AppError("conflict", `${body.scope} secret "${body.name}" already exists`);
    }
    assertMaterialFits(body.injection, body.value);
    const material = await store().seal(body.value);
    let row;
    try {
      row = await app.prisma.appSecret.create({
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
    } catch (err) {
      // seal() already wrote to the vault, so anything that stops the row landing —
      // the uniqueness race above, or any transient DB error — would otherwise leave a
      // live, unreferenced credential in the vault. Mirrors the app-scoped create.
      await release(material, {
        appId: null,
        actor: actor.sub,
        scope: body.scope,
        env: "prod",
        name: body.name,
        reason: "create-rollback",
      });
      if (isUniqueViolation(err)) {
        throw new AppError("conflict", `${body.scope} secret "${body.name}" already exists`);
      }
      throw err;
    }
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
      assertMaterialFits(requireRecipe(row), value);
      const material = await store().seal(value);
      const updated = await rotateOrRelease(row, material, {
        appId: null,
        actor: actor.sub,
        scope: row.scope,
        env: row.env,
        name: row.name,
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
