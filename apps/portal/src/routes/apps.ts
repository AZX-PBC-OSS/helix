import type { FastifyInstance } from "fastify";
import {
  CapabilitiesSchema,
  CreateAppRequestSchema,
  OriginGrantRequestSchema,
  PasswordCredentialResponseSchema,
  SetManifestRequestSchema,
  SetPasswordRequestSchema,
  SetVisibilityRequestSchema,
  captureSnapshot,
  classifyVisibilityChange,
  touchedAreas,
  type ManifestUpdateResult,
  type VisibilityUpdateResult,
} from "@azx-pbc/shared";
import { authenticate, ownsApp, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { passwordAppsAllowed, publicAppsAllowed } from "../policy/visibilityPolicy.js";
import { casPolicyWrite } from "../policy/policyWrite.js";
import { isUniqueViolation } from "../db/errors.js";
import { capabilitiesFromRow, toApp, toManifest, visibilityToColumns } from "../db/mappers.js";
import { applyCapabilityChange, createApprovalRequest } from "../approvals/service.js";
import { Prisma } from "../db/client.js";
import {
  decryptPassword,
  encryptPassword,
  generatePassphrase,
  hashPassword,
} from "../access/password.js";
import { appPublicUrl } from "../deployment.js";

/** App registry routes: create, list, get (architecture §7). */
export async function appRoutes(app: FastifyInstance): Promise<void> {
  // Create an app. Mutating — requires the dev token.
  app.post("/api/v1/apps", { preHandler: authenticate }, async (req, reply) => {
    const body = CreateAppRequestSchema.parse(req.body);
    const actor = requireActor(req);
    // Operator policy: this deployment may forbid creating an open-surface app
    // (PORTAL_ALLOW_*_APPS). The edge enforces the same policy on serving.
    if (body.visibility.mode === "public" && !publicAppsAllowed()) {
      throw new AppError("forbidden", "public apps are disabled on this deployment");
    }
    if (body.visibility.mode === "password" && !passwordAppsAllowed()) {
      throw new AppError("forbidden", "password apps are disabled on this deployment");
    }
    const { visibilityMode, visibilityGroupId } = visibilityToColumns(body.visibility);
    // Fill capability defaults so the stored shape always parses on read.
    const capabilities = CapabilitiesSchema.parse(body.capabilities ?? {});

    let row;
    try {
      row = await app.prisma.app.create({
        data: {
          slug: body.slug,
          displayName: body.displayName,
          ownerId: actor.sub,
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

  // List all apps. Read — sign-in required (any authenticated principal).
  app.get("/api/v1/apps", { preHandler: authenticate }, async () => {
    const rows = await app.prisma.app.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(toApp);
  });

  // Get one app by slug. Read — sign-in required.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug",
    { preHandler: authenticate },
    async (req) => {
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      return toApp(row);
    },
  );

  // Archive an app: the edge serves 410 + Clear-Site-Data for it (architecture
  // §7). Mutating — requires the dev token. Idempotent.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/archive",
    { preHandler: [authenticate, ownsApp] },
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
    { preHandler: [authenticate, ownsApp] },
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

  // Get an app's manifest (slug + visibility + capability grants, §6.3). Read —
  // sign-in required.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/manifest",
    { preHandler: authenticate },
    async (req) => {
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      return toManifest(row);
    },
  );

  // Replace an app's capability grants (architecture §6.3). Mutating — bearer
  // token. Routed through the approvals write-gate (docs/design/approvals.md §3):
  // baseline deltas commit immediately (as before); elevated deltas (e.g. an
  // arbitrary MCP server, a budget above threshold) are bundled into one pending
  // ApprovalRequest and applied later on approve. The edge only ever sees the
  // committed effective state via its registry projection — it never learns a
  // request is open.
  app.put<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/manifest",
    { preHandler: [authenticate, ownsApp] },
    async (req): Promise<ManifestUpdateResult> => {
      const { capabilities: requested, reason } = SetManifestRequestSchema.parse(req.body);
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      // A full replace, so the requested value doesn't depend on the effective one
      // — but it is still classified against the state read inside the txn.
      return applyCapabilityChange(app.prisma, {
        appId: row.id,
        mutate: () => requested,
        actor: actor.sub,
        reason,
      });
    },
  );

  // One-click origin grant from the Violations screen (docs/design/approvals.md
  // §6.2): add a single external origin through the same write-gate. Adding an
  // origin is always elevated, so this opens a med-risk request.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/origin",
    { preHandler: [authenticate, ownsApp] },
    async (req): Promise<ManifestUpdateResult> => {
      const { origin, reason } = OriginGrantRequestSchema.parse(req.body);
      const actor = requireActor(req);
      const row = await app.prisma.app.findUnique({ where: { slug: req.params.slug } });
      if (!row) {
        throw new AppError("not_found", `app "${req.params.slug}" not found`);
      }
      // A *relative* change: the append has to run against the origins read inside
      // the transaction, or two grants filed from the Violations screen at once
      // each append to the same pre-image and one origin is lost.
      return applyCapabilityChange(app.prisma, {
        appId: row.id,
        mutate: (effective) => ({
          ...effective,
          externalOrigins: [...effective.externalOrigins, origin],
        }),
        actor: actor.sub,
        reason,
      });
    },
  );

  // Change how an app gates access (architecture §4.2). Reducing exposure
  // (→ internal/group) commits immediately; going **public** is elevated and
  // opens an approval request (docs/design/approvals.md §3, §6.3). Enabling
  // `password` visibility is NOT done here — it needs a minted credential, so
  // it keeps its dedicated /access/password routes below.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/visibility",
    { preHandler: [authenticate, ownsApp] },
    async (req): Promise<VisibilityUpdateResult> => {
      const { visibility, reason } = SetVisibilityRequestSchema.parse(req.body);
      const actor = requireActor(req);
      if (visibility.mode === "password") {
        throw new AppError(
          "conflict",
          "enable password access via POST /api/v1/apps/:slug/access/password (it mints the credential)",
        );
      }
      return app.prisma.$transaction(async (tx): Promise<VisibilityUpdateResult> => {
        // Read inside the transaction. Two things downstream depend on the current
        // mode: `classifyVisibilityChange` decides elevated-vs-baseline from it, and
        // the elevated branch stores it in `baseSnapshot` for the later approve to
        // compare against. Off a read taken before the transaction, both can be
        // deciding from a mode that has already moved — and a wrong `baseSnapshot`
        // is worse than a stale read, because it is persisted and silently defeats
        // the approve-time conflict check.
        const row = await tx.app.findUnique({ where: { slug: req.params.slug } });
        if (!row) {
          throw new AppError("not_found", `app "${req.params.slug}" not found`);
        }

        const change = classifyVisibilityChange(row.visibilityMode, visibility.mode);
        if (!change) {
          return { app: toApp(row), applied: [], pending: null }; // no-op
        }

        if (change.elevated) {
          // The only elevated change is → public. When public is disabled we
          // refuse outright rather than opening an approval that could never be
          // safely committed. Reductions (→ internal/group) fall through below, so
          // an already-public app can always be migrated down.
          if (!publicAppsAllowed()) {
            throw new AppError("forbidden", "public apps are disabled on this deployment");
          }
          const baseSnapshot = captureSnapshot(
            capabilitiesFromRow(row),
            row.visibilityMode,
            touchedAreas([change.delta]),
          );
          // No policy write here, so nothing to CAS: the request only records what
          // was asked for. A mode that moves while the request sits pending is
          // exactly what `baseSnapshot` exists to catch at approve time (§5).
          const pending = await createApprovalRequest(tx, {
            appId: row.id,
            deltas: [change.delta],
            risk: change.risk,
            baseSnapshot,
            requestedBy: actor.sub,
            reason,
          });
          return { app: toApp(row), applied: [], pending };
        }

        // Baseline reduction — apply now.
        const { visibilityMode, visibilityGroupId } = visibilityToColumns(visibility);
        const updated = await casPolicyWrite(tx, row, { visibilityMode, visibilityGroupId });
        await tx.auditEvent.create({
          data: {
            appId: row.id,
            actor: actor.sub,
            action: "app.visibility.set",
            metadata: { applied: [change.delta] as unknown as Prisma.InputJsonValue },
          },
        });
        return { app: toApp(updated), applied: [change.delta], pending: null };
      });
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
    { preHandler: [authenticate, ownsApp] },
    async (req, reply) => {
      const actor = requireActor(req);
      // Operator policy: enabling a password app is a move into an open surface;
      // refuse when disabled. Disabling (DELETE, reverts to internal) stays open
      // so an owner can always migrate an existing password app away.
      if (!passwordAppsAllowed()) {
        throw new AppError("forbidden", "password apps are disabled on this deployment");
      }
      // Mint before opening the transaction: `hashPassword` is a deliberately slow
      // KDF, and holding a transaction (and its connection) open across it would
      // idle a pool slot for the whole scrypt run. Re-enabling discards this.
      const password = generatePassphrase();
      const setAt = new Date();
      const { hash, salt } = await hashPassword(password);

      const minted = await app.prisma.$transaction(async (tx) => {
        const row = await tx.app.findUnique({ where: { slug: req.params.slug } });
        if (!row) {
          throw new AppError("not_found", `app "${req.params.slug}" not found`);
        }
        if (row.visibilityMode === "password" && row.passwordEnc && row.passwordSetAt) {
          return {
            fresh: false,
            cred: credential(row.slug, decryptPassword(row.passwordEnc), row.passwordSetAt),
          };
        }
        // CAS: the idempotency check above is a read-then-act on `visibilityMode`.
        // Two concurrent enables would both pass it, both mint, and both write —
        // and the loser would be handed a cleartext passphrase that is *not* the
        // one stored, so the URL they were given does not work and the passphrase
        // that does is unrecoverable. The loser now gets a 409 instead.
        await casPolicyWrite(
          tx,
          row,
          {
            visibilityMode: "password",
            visibilityGroupId: null,
            passwordHash: hash,
            passwordSalt: salt,
            passwordEnc: encryptPassword(password),
            passwordSetAt: setAt,
          },
          "this app's access mode changed while password access was being enabled — re-read it and retry",
        );
        await tx.auditEvent.create({
          data: {
            appId: row.id,
            actor: actor.sub,
            action: "app.access.password.enable",
            metadata: {},
          },
        });
        return { fresh: true, cred: credential(row.slug, password, setAt) };
      });
      if (minted.fresh) reply.status(201);
      return minted.cred;
    },
  );

  // Rotate: reroll a fresh passphrase (no body) or set a manual one (`password`,
  // ≥12 chars). Requires password access to already be enabled.
  app.post<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/password/rotate",
    { preHandler: [authenticate, ownsApp] },
    async (req) => {
      const { password: manual } = SetPasswordRequestSchema.parse(req.body ?? {});
      const actor = requireActor(req);
      // Rotating keeps the app a password app — refuse when disabled (only the
      // DELETE migration-away path stays open).
      if (!passwordAppsAllowed()) {
        throw new AppError("forbidden", "password apps are disabled on this deployment");
      }
      // Hashed before the transaction for the same reason as enable, above.
      const password = manual ?? generatePassphrase();
      const setAt = new Date();
      const { hash, salt } = await hashPassword(password);

      return app.prisma.$transaction(async (tx) => {
        const row = await tx.app.findUnique({ where: { slug: req.params.slug } });
        if (!row) {
          throw new AppError("not_found", `app "${req.params.slug}" not found`);
        }
        if (row.visibilityMode !== "password") {
          throw new AppError("conflict", "password access is not enabled for this app");
        }
        // Writes only the credential columns, but the guard above reads a policy
        // column — so it CASes too. Otherwise a concurrent disable landing between
        // the guard and the write re-populates credentials on an app that is no
        // longer a password app, and the edge projects those columns.
        await casPolicyWrite(
          tx,
          row,
          {
            passwordHash: hash,
            passwordSalt: salt,
            passwordEnc: encryptPassword(password),
            passwordSetAt: setAt,
          },
          "this app's access mode changed while the password was being rotated — re-read it and retry",
        );
        await tx.auditEvent.create({
          data: {
            appId: row.id,
            actor: actor.sub,
            action: "app.access.password.rotate",
            metadata: { manual: manual !== undefined },
          },
        });
        return credential(row.slug, password, setAt);
      });
    },
  );

  // Re-display the current credential. Authenticated read — never an open route.
  app.get<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/password",
    { preHandler: [authenticate, ownsApp] },
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

  // Disable password access: revert to internal and wipe the credential. Mutating,
  // idempotent — a non-password app is already in the desired state.
  app.delete<{ Params: { slug: string } }>(
    "/api/v1/apps/:slug/access/password",
    { preHandler: [authenticate, ownsApp] },
    async (req, reply) => {
      const actor = requireActor(req);
      await app.prisma.$transaction(async (tx) => {
        const row = await tx.app.findUnique({ where: { slug: req.params.slug } });
        if (!row) {
          throw new AppError("not_found", `app "${req.params.slug}" not found`);
        }
        if (row.visibilityMode !== "password") return; // already in the desired state
        await casPolicyWrite(
          tx,
          row,
          {
            // Back to the baseline, deliberately: disabling a shared password
            // must not tighten the app past where it started, or turning off a
            // demo credential would silently lock out everyone who had access.
            visibilityMode: "internal",
            passwordHash: null,
            passwordSalt: null,
            passwordEnc: null,
            passwordSetAt: null,
          },
          "this app's access mode changed while password access was being disabled — re-read it and retry",
        );
        await tx.auditEvent.create({
          data: {
            appId: row.id,
            actor: actor.sub,
            action: "app.access.password.disable",
            metadata: {},
          },
        });
      });
      reply.status(204).send();
    },
  );
}
