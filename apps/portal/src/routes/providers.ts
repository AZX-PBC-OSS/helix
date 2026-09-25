import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ProviderCreateRequestSchema,
  ProviderListResponseSchema,
  ProviderMetadataSchema,
  ProviderUpdateRequestSchema,
  type ProviderMetadata,
} from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";
import { authenticate, requireAdmin } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";
import { connectionsCallbackUrl } from "../deployment.js";

/**
 * Connection-provider CRUD (I-02, spec §Provider administration criteria 1–6,
 * 10) — the administrator's vendor OAuth registrations. Admin-direct and
 * audited like global secrets (clarifications Q14); all four routes gate on
 * `requireAdmin`, including the management reads (criterion 2).
 *
 * **Metadata-only reads**: a client's credentials cross the API boundary only
 * on create and edit, sealed by the {@link SecretStore} onto the row
 * (ADR-0006 part 1 — the portal is the kv-connections Officer, egress opens),
 * and `toMetadata` maps every response through `ProviderMetadataSchema`,
 * whose shape structurally omits both material fields. There is no route that
 * reads them back.
 *
 * **Concurrency**: the edit CASes on the loaded `revision` (ADR-0004) and —
 * for an edit that supplies credentials — on the row's current sealed
 * material, the `rotateOrRelease` pattern: two concurrent rotations cannot
 * both land, and the loser's just-sealed material is released rather than
 * stranded live in the vault.
 *
 * The **revision advance, the sensitive-delta detection
 * (`SENSITIVE_PROVIDER_FIELDS`), the invalidation acknowledgement, and the
 * connection/attempt invalidation transaction are T-0010's**, layered onto the
 * edit handler's single CAS application point — the vault writes here already
 * sit outside any transaction, which is where T-0010's all-or-nothing boundary
 * needs them (its constraint: the transaction must not span the vault).
 * T-0008 ships the CAS compare and the custody posture that transaction
 * composes with.
 */
export async function providerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Provider bodies reject with **422**, not the portal's generic zod-path
   * 400: design.md §Portal API endpoints fixes the status, and the SPA's
   * edit form renders the issues inline on the inputs (criterion 1's
   * field-level errors).
   */
  const parseBody = <S extends z.ZodType>(schema: S, body: unknown): z.output<S> => {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new AppError(
        "validation_failed",
        "provider request validation failed",
        result.error.issues,
        422,
      );
    }
    return result.data;
  };

  // Custody must be configured (a KEK in dev / Key Vault in prod) to seal.
  const store = (): SecretStore => {
    if (!app.secretStore) {
      throw new AppError("capability_unavailable", "secret store is not configured");
    }
    return app.secretStore;
  };

  const audit = (action: string, actor: string, metadata: object = {}) =>
    app.prisma.auditEvent.create({ data: { appId: null, actor, action, metadata } });

  interface ProviderRow {
    id: string;
    ref: string;
    kind: string;
    displayName: string;
    authorizeEndpoint: string;
    tokenEndpoint: string;
    requestedScopes: unknown;
    apiOrigins: unknown;
    tokenPlacement: unknown;
    env: string;
    clientIdMaterial: string;
    clientSecretMaterial: string;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  }

  /**
   * Map a row to its metadata — **constructed field-by-field, never spread**,
   * so the sealed material cannot ride into a payload even if the row grows a
   * column; the strict `ProviderMetadataSchema` parse then fails loudly if the
   * mapped shape and the wire contract ever drift.
   */
  const toMetadata = (row: ProviderRow): ProviderMetadata =>
    ProviderMetadataSchema.parse({
      id: row.id,
      ref: row.ref,
      kind: row.kind,
      displayName: row.displayName,
      authorizeEndpoint: row.authorizeEndpoint,
      tokenEndpoint: row.tokenEndpoint,
      requestedScopes: row.requestedScopes,
      apiOrigins: row.apiOrigins,
      tokenPlacement: row.tokenPlacement,
      env: row.env === "dev" ? "dev" : "prod",
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });

  type ReleaseReason = "create-rollback" | "edit-rollback" | "rotate";
  type CredentialRelease = { material: string; field: "clientId" | "clientSecret" };

  /**
   * Release a superseded or rolled-back `material` — **non-throwing, but never
   * silent**, mirroring the secrets routes: a swallowed failure strands a live
   * kv-connections entry (ADR-0006), so it becomes an operator-visible
   * `provider.destroy_failed` audit event. The vault `ref` is recorded only
   * for `kv:` material; dev envelope ciphertext is never copied anywhere.
   */
  const release = async (
    material: string,
    ctx: {
      actor: string;
      ref: string;
      env: string;
      field: "clientId" | "clientSecret";
      reason: ReleaseReason;
    },
  ): Promise<void> => {
    try {
      await store().destroy(material);
    } catch (err) {
      const vaultRef = material.startsWith("kv:") ? material : undefined;
      app.log.error(
        { event: "provider.destroy_failed", err, ...ctx, vaultRef },
        "provider credential destroy failed — vault entry may be stranded",
      );
      await audit("provider.destroy_failed", ctx.actor, {
        ref: ctx.ref,
        env: ctx.env,
        field: ctx.field,
        reason: ctx.reason,
        ...(vaultRef ? { vaultRef } : {}),
      }).catch((auditErr: unknown) => {
        app.log.error(
          { event: "provider.audit_write_failed", err: auditErr },
          "could not record provider.destroy_failed",
        );
      });
    }
  };

  const releaseAll = async (
    credentials: CredentialRelease[],
    ctx: { actor: string; ref: string; env: string; reason: ReleaseReason },
  ): Promise<void> => {
    for (const { material, field } of credentials) {
      await release(material, { ...ctx, field });
    }
  };

  app.get("/api/v1/providers", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const rows = await app.prisma.connectionProvider.findMany({
      orderBy: [{ env: "asc" }, { ref: "asc" }],
    });
    return ProviderListResponseSchema.parse({
      callbackUrl: connectionsCallbackUrl(),
      providers: rows.map(toMetadata),
    });
  });

  app.post("/api/v1/providers", { preHandler: authenticate }, async (req, reply) => {
    const actor = requireAdmin(req);
    const body = parseBody(ProviderCreateRequestSchema, req.body);
    // seal() writes to the vault before the row exists — same window as the
    // secrets routes, so anything that stops the row landing releases both
    // materials (no path strands an unreferenced vault entry).
    const clientIdMaterial = await store().seal(body.clientId);
    const clientSecretMaterial = await store().seal(body.clientSecret);
    let row;
    try {
      row = await app.prisma.connectionProvider.create({
        data: {
          ref: body.ref,
          kind: body.kind,
          displayName: body.displayName,
          authorizeEndpoint: body.authorizeEndpoint,
          tokenEndpoint: body.tokenEndpoint,
          requestedScopes: body.requestedScopes,
          apiOrigins: body.apiOrigins,
          tokenPlacement: body.tokenPlacement,
          env: body.env,
          clientIdMaterial,
          clientSecretMaterial,
        },
      });
    } catch (err) {
      await releaseAll(
        [
          { material: clientIdMaterial, field: "clientId" },
          { material: clientSecretMaterial, field: "clientSecret" },
        ],
        { actor: actor.sub, ref: body.ref, env: body.env, reason: "create-rollback" },
      );
      if (isUniqueViolation(err)) {
        throw new AppError(
          "conflict",
          `provider "${body.ref}" already exists in the ${body.env} environment`,
        );
      }
      throw err;
    }
    await audit("provider.created", actor.sub, { ref: body.ref, env: body.env, kind: body.kind });
    reply.status(201);
    return toMetadata(row);
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/providers/:id",
    { preHandler: authenticate },
    async (req) => {
      requireAdmin(req);
      const row = await app.prisma.connectionProvider.findUnique({
        where: { id: req.params.id },
      });
      if (!row) throw new AppError("not_found", `provider "${req.params.id}" not found`);
      return toMetadata(row);
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/providers/:id",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireAdmin(req);
      const body = parseBody(ProviderUpdateRequestSchema, req.body);
      const row = await app.prisma.connectionProvider.findUnique({
        where: { id: req.params.id },
      });
      if (!row) throw new AppError("not_found", `provider "${req.params.id}" not found`);

      const secretRotated = body.clientSecret !== undefined;
      const clientIdentityChanged = body.clientId !== undefined;
      // Seal any supplied credential before the CAS: a lost race must release
      // what was sealed, and a won race swaps the row to material that already
      // exists. Absent means keep — the stored material is never read back, so
      // "blank" is the only way an edit form says "unchanged".
      const clientIdMaterial =
        body.clientId === undefined ? null : await store().seal(body.clientId);
      const clientSecretMaterial =
        body.clientSecret === undefined ? null : await store().seal(body.clientSecret);

      // The CAS: the loaded revision, plus — for each supplied credential — the
      // row's current material, so two concurrent rotations arbitrate even
      // though neither advances the revision (the `rotateOrRelease` pattern;
      // without it, both land and the loser's sealed material is stranded).
      const { count } = await app.prisma.connectionProvider.updateMany({
        where: {
          id: row.id,
          revision: body.revision,
          ...(clientIdMaterial !== null ? { clientIdMaterial: row.clientIdMaterial } : {}),
          ...(clientSecretMaterial !== null
            ? { clientSecretMaterial: row.clientSecretMaterial }
            : {}),
        },
        data: {
          displayName: body.displayName,
          authorizeEndpoint: body.authorizeEndpoint,
          tokenEndpoint: body.tokenEndpoint,
          requestedScopes: body.requestedScopes,
          apiOrigins: body.apiOrigins,
          tokenPlacement: body.tokenPlacement,
          ...(clientIdMaterial !== null ? { clientIdMaterial } : {}),
          ...(clientSecretMaterial !== null ? { clientSecretMaterial } : {}),
        },
      });
      if (count === 0) {
        await releaseAll(
          [
            ...(clientIdMaterial !== null
              ? [{ material: clientIdMaterial, field: "clientId" as const }]
              : []),
            ...(clientSecretMaterial !== null
              ? [{ material: clientSecretMaterial, field: "clientSecret" as const }]
              : []),
          ],
          { actor: actor.sub, ref: row.ref, env: row.env, reason: "edit-rollback" },
        );
        throw new AppError(
          "conflict",
          `provider "${row.ref}" changed since it was loaded — reload the current settings, review them, and confirm again`,
        );
      }

      // Post-commit: the swapped-out materials are unreferenced now — release
      // the old, like a secret rotation. The identity half is sealed too, so a
      // client-id change retires its material the same way.
      if (clientIdentityChanged) {
        await release(row.clientIdMaterial, {
          actor: actor.sub,
          ref: row.ref,
          env: row.env,
          field: "clientId",
          reason: "rotate",
        });
      }
      if (secretRotated) {
        await release(row.clientSecretMaterial, {
          actor: actor.sub,
          ref: row.ref,
          env: row.env,
          field: "clientSecret",
          reason: "rotate",
        });
      }

      const updated = await app.prisma.connectionProvider.findUnique({
        where: { id: row.id },
      });
      if (!updated) throw new AppError("not_found", `provider "${row.ref}" not found`);
      await audit("provider.updated", actor.sub, {
        ref: row.ref,
        env: row.env,
        secretRotated,
        clientIdentityChanged,
      });
      return toMetadata(updated);
    },
  );
}
