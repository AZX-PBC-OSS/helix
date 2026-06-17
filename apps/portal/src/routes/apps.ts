import type { FastifyInstance } from "fastify";
import {
  CapabilitiesSchema,
  CreateAppRequestSchema,
  PasswordCredentialResponseSchema,
  SetManifestRequestSchema,
  SetPasswordRequestSchema,
} from "@helix/shared";
import { authenticate, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";
import { toApp, toManifest, visibilityToColumns } from "../db/mappers.js";
import {
  appPublicUrl,
  decryptPassword,
  encryptPassword,
  generatePassphrase,
  hashPassword,
} from "../access/password.js";

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

  /* --------------------------------------------------------------------- *
   * Shared-password access (`password` visibility) — the cleartext credential
   * an owner shares out-of-band for external demos (docs/features/
   * authentication.md). All four routes are authenticated, including the GET:
   * the password never appears in `toApp`/`toManifest` or any open read.
   * --------------------------------------------------------------------- */

  const credential = (slug: string, password: string, setAt: Date) =>
    PasswordCredentialResponseSchema.parse({
      password,
      url: appPublicUrl(slug),
      setAt: setAt.toISOString(),
    });

  // Enable password access: flip visibility to `password` and mint a passphrase
  // if there isn't one. Idempotent — re-enabling returns the existing credential
  // rather than rotating it out from under a URL already handed out.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/password",
    { preHandler: authenticate },
    async (req, reply) => {
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      if (row.visibilityMode === "password" && row.passwordEnc && row.passwordSetAt) {
        return credential(row.slug, decryptPassword(row.passwordEnc), row.passwordSetAt);
      }
      const password = generatePassphrase();
      const setAt = new Date();
      const { hash, salt } = await hashPassword(password);
      await app.prisma.app.update({
        where: { id: row.id },
        data: {
          visibilityMode: "password",
          visibilityGroupId: null,
          passwordHash: hash,
          passwordSalt: salt,
          passwordEnc: encryptPassword(password),
          passwordSetAt: setAt,
        },
      });
      await app.prisma.auditEvent.create({
        data: {
          appId: row.id,
          actor: actor.sub,
          action: "app.access.password.enable",
          metadata: {},
        },
      });
      reply.status(201);
      return credential(row.slug, password, setAt);
    },
  );

  // Rotate: reroll a fresh passphrase (no body) or set a manual one (`password`,
  // ≥12 chars). Requires password access to already be enabled.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/password/rotate",
    { preHandler: authenticate },
    async (req) => {
      const { password: manual } = SetPasswordRequestSchema.parse(req.body ?? {});
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      if (row.visibilityMode !== "password") {
        throw new AppError("conflict", "password access is not enabled for this app");
      }
      const password = manual ?? generatePassphrase();
      const setAt = new Date();
      const { hash, salt } = await hashPassword(password);
      await app.prisma.app.update({
        where: { id: row.id },
        data: {
          passwordHash: hash,
          passwordSalt: salt,
          passwordEnc: encryptPassword(password),
          passwordSetAt: setAt,
        },
      });
      await app.prisma.auditEvent.create({
        data: {
          appId: row.id,
          actor: actor.sub,
          action: "app.access.password.rotate",
          metadata: { manual: manual !== undefined },
        },
      });
      return credential(row.slug, password, setAt);
    },
  );

  // Re-display the current credential. Authenticated read — never an open route.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/password",
    { preHandler: authenticate },
    async (req) => {
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      if (row.visibilityMode !== "password" || !row.passwordEnc || !row.passwordSetAt) {
        throw new AppError("not_found", "password access is not enabled for this app");
      }
      return credential(row.slug, decryptPassword(row.passwordEnc), row.passwordSetAt);
    },
  );

  // Disable password access: revert to private and wipe the credential. Mutating,
  // idempotent — a non-password app is already in the desired state.
  app.delete<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/password",
    { preHandler: authenticate },
    async (req, reply) => {
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      if (row.visibilityMode === "password") {
        await app.prisma.app.update({
          where: { id: row.id },
          data: {
            visibilityMode: "private",
            passwordHash: null,
            passwordSalt: null,
            passwordEnc: null,
            passwordSetAt: null,
          },
        });
        await app.prisma.auditEvent.create({
          data: {
            appId: row.id,
            actor: actor.sub,
            action: "app.access.password.disable",
            metadata: {},
          },
        });
      }
      reply.status(204).send();
    },
  );
}
