import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  CONFIRM_INVALIDATION_FIELD,
  ConfirmationRequiredDetailsSchema,
  ConnectionProviderSchema,
  ProviderCreateRequestSchema,
  ProviderDeleteRequestSchema,
  ProviderDeleteResponseSchema,
  ProviderExportDocumentSchema,
  ProviderImportPreviewDiffEntrySchema,
  ProviderImportPreviewRequestSchema,
  ProviderImportPreviewResponseSchema,
  ProviderImportRequestSchema,
  ProviderImportResponseSchema,
  ProviderImpactSchema,
  ProviderListResponseSchema,
  ProviderMetadataSchema,
  ProviderUpdateRequestSchema,
  type ConnectionProvider,
  type ProviderConfig,
  type ProviderCreateRequest,
  type ProviderExportDocument,
  type ProviderImpact,
  type ProviderMetadata,
  type ProviderUpdateRequest,
  type SensitiveProviderField,
} from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";
import { Prisma, type PrismaClient } from "../db/client.js";
import { authenticate, requireAdmin, type Actor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";
import { connectionsCallbackUrl } from "../deployment.js";

/** The `connection_providers` row as the route reads it (Prisma's Date columns). */
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
 * Thrown inside the edit transaction when the CAS matches zero rows, so the
 * transaction rolls back whole; the route catches it to release the
 * just-sealed credentials and answer the stale-save 409.
 */
class CasLost extends Error {}

/**
 * The stored row through its one shared definition (`ConnectionProviderSchema`)
 * — the parse the sensitive-delta comparison runs against, so a drifted row
 * fails loudly instead of comparing as silently unsensitive.
 */
function parseStoredRow(row: ProviderRow): ConnectionProvider {
  return ConnectionProviderSchema.parse({
    ...row,
    env: row.env === "dev" ? "dev" : "prod",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

const sortedCopy = (values: string[]): string[] => [...values].sort();

/**
 * The sensitive fields the update request would change — the edit route's
 * half of `SENSITIVE_PROVIDER_FIELDS`' single definition (ADR-0004 §Shared
 * ground): `clientId` by **presence** in the request (the stored identity is
 * sealed material no read returns), every other field by comparing the stored
 * row against the parsed request. Array fields compare as sets — scope and
 * destination order carries no meaning, and letting a reordering manufacture
 * an invalidation would train the form to fear field order.
 */
function sensitiveDelta(
  stored: ConnectionProvider,
  body: ProviderUpdateRequest,
): SensitiveProviderField[] {
  const delta: SensitiveProviderField[] = [];
  if (body.clientId !== undefined) delta.push("clientId");
  if (stored.authorizeEndpoint !== body.authorizeEndpoint) delta.push("authorizeEndpoint");
  if (stored.tokenEndpoint !== body.tokenEndpoint) delta.push("tokenEndpoint");
  if (
    JSON.stringify(sortedCopy(stored.requestedScopes)) !==
    JSON.stringify(sortedCopy(body.requestedScopes))
  ) {
    delta.push("requestedScopes");
  }
  if (
    JSON.stringify(sortedCopy(stored.apiOrigins)) !== JSON.stringify(sortedCopy(body.apiOrigins))
  ) {
    delta.push("apiOrigins");
  }
  // Both sides parse through the same TokenPlacementSchema, so identity
  // serialization is a sound deep-equality here.
  if (JSON.stringify(stored.tokenPlacement) !== JSON.stringify(body.tokenPlacement)) {
    delta.push("tokenPlacement");
  }
  return delta;
}

/**
 * The imported document's fields as an update request — the shape the shared
 * apply path ({@link applyProviderUpdate}) and its `sensitiveDelta` consume.
 * The document carries no credential and no acknowledgement, so both arrive
 * only from the import request's own optional fields; `revision` is the CAS
 * input the caller owns (the target revision the preview showed).
 */
function importUpdateRequest(
  provider: ProviderConfig,
  revision: number,
  extra: Pick<ProviderUpdateRequest, "clientId" | "clientSecret" | "confirmInvalidation"> = {},
): ProviderUpdateRequest {
  return {
    displayName: provider.displayName,
    authorizeEndpoint: provider.authorizeEndpoint,
    tokenEndpoint: provider.tokenEndpoint,
    requestedScopes: provider.requestedScopes,
    apiOrigins: provider.apiOrigins,
    tokenPlacement: provider.tokenPlacement,
    revision,
    ...extra,
  };
}

/**
 * The import preview's full diff (criterion 12): every editable field whose
 * imported value differs from the target's, one line each. The comparisons
 * are the sensitive-delta's — set-compared arrays, identity placement
 * serialization — so a field absent here can never turn sensitive at apply,
 * and an empty diff is exactly the apply path's no-op.
 */
function previewDiff(
  stored: ConnectionProvider,
  imported: ProviderConfig,
): z.output<typeof ProviderImportPreviewDiffEntrySchema>[] {
  const diff: z.output<typeof ProviderImportPreviewDiffEntrySchema>[] = [];
  if (stored.displayName !== imported.displayName) {
    diff.push({
      field: "displayName",
      current: stored.displayName,
      imported: imported.displayName,
    });
  }
  if (stored.authorizeEndpoint !== imported.authorizeEndpoint) {
    diff.push({
      field: "authorizeEndpoint",
      current: stored.authorizeEndpoint,
      imported: imported.authorizeEndpoint,
    });
  }
  if (stored.tokenEndpoint !== imported.tokenEndpoint) {
    diff.push({
      field: "tokenEndpoint",
      current: stored.tokenEndpoint,
      imported: imported.tokenEndpoint,
    });
  }
  if (
    JSON.stringify(sortedCopy(stored.requestedScopes)) !==
    JSON.stringify(sortedCopy(imported.requestedScopes))
  ) {
    diff.push({
      field: "requestedScopes",
      current: stored.requestedScopes,
      imported: imported.requestedScopes,
    });
  }
  if (
    JSON.stringify(sortedCopy(stored.apiOrigins)) !==
    JSON.stringify(sortedCopy(imported.apiOrigins))
  ) {
    diff.push({ field: "apiOrigins", current: stored.apiOrigins, imported: imported.apiOrigins });
  }
  if (JSON.stringify(stored.tokenPlacement) !== JSON.stringify(imported.tokenPlacement)) {
    diff.push({
      field: "tokenPlacement",
      current: stored.tokenPlacement,
      imported: imported.tokenPlacement,
    });
  }
  return diff;
}

/**
 * The connection invalidation, as ONE UPDATE (ADR-0008's rule): the status
 * flip to `invalidated` and the retirement-ledger mark — the row's own sealed
 * material, for the egress sweep (T-0025) to destroy — commit together, never
 * as separate steps. Scoped to this provider id and its env partition; rows
 * already invalidated are tombstones, not impact. Bounded residual in the
 * ledger's single field: a row with a retirement already pending (an egress
 * rotation racing this write) loses the older reference from the ledger —
 * the same accepted residual class as ADR-0008's seal→write window.
 */
function invalidateConnections(
  tx: Prisma.TransactionClient,
  provider: { id: string; env: string },
): Promise<number> {
  return tx.$executeRaw`
    UPDATE user_connections
    SET status = 'invalidated', "pendingRetire" = "material", "updatedAt" = now()
    WHERE "providerId" = ${provider.id}::uuid AND "env" = ${provider.env}
      AND status <> 'invalidated'`;
}

/**
 * The pending-attempt invalidation: an attempt dies by `cancelledAt` — the
 * marker the claim probe already refuses (a claimed-or-cancelled attempt can
 * never complete) — so a killed attempt can never be claimed by anyone,
 * whatever its TTL said. Expired attempts are already dead; this only marks
 * the ones that could still have completed.
 */
function killPendingAttempts(
  tx: Prisma.TransactionClient,
  provider: { id: string; env: string },
): Promise<number> {
  return tx.connectionConsentAttempt
    .updateMany({
      where: { providerId: provider.id, env: provider.env, cancelledAt: null },
      data: { cancelledAt: new Date() },
    })
    .then((r) => r.count);
}

/**
 * The confirmation dialog's blast radius (criterion 9): the apps bound to the
 * provider's ref in their effective manifests, the not-yet-invalidated
 * connection count, and the still-claimable pending-attempt count. Served by
 * `GET …/impact` and carried in the `confirmation_required` rejection, so the
 * review panel renders without a second fetch.
 */
async function providerImpact(prisma: PrismaClient, row: ProviderRow): Promise<ProviderImpact> {
  const [boundApps, connections, pendingAttempts] = await Promise.all([
    // The manifest binding is a ref (ADR-0004 — manifests never carry ids), so
    // the bound set is the apps whose capabilities JSON declares a
    // provider-bound origin with this ref. Containment against a one-element
    // candidate array matches any origin element carrying the provider key.
    prisma.$queryRaw<Array<{ id: string; slug: string; displayName: string }>>(
      Prisma.sql`SELECT id, "slug", "displayName"
        FROM apps
        WHERE capabilities->'fetch'->'origins' @> ${JSON.stringify([{ provider: row.ref }])}::jsonb
        ORDER BY "slug"`,
    ),
    prisma.userConnection.count({
      where: { providerId: row.id, env: row.env, status: { not: "invalidated" } },
    }),
    prisma.connectionConsentAttempt.count({
      where: {
        providerId: row.id,
        env: row.env,
        cancelledAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  ]);
  return ProviderImpactSchema.parse({
    providerId: row.id,
    ref: row.ref,
    env: row.env === "dev" ? "dev" : "prod",
    displayName: row.displayName,
    revision: row.revision,
    boundApps,
    connections,
    pendingAttempts,
  });
}

/**
 * The proof a given id was removed by THIS surface: the `provider.deleted`
 * audit event, written in the same transaction as the removal. Repeat
 * deletions are answered from it (`already_removed`), which is also what
 * keeps the answer id-scoped — a replacement provider recreated under the
 * same ref carries a new surrogate id and never matches.
 */
async function removedProviderEventExists(prisma: PrismaClient, id: string): Promise<boolean> {
  const event = await prisma.auditEvent.findFirst({
    where: {
      action: "provider.deleted",
      metadata: { path: ["providerId"], equals: id },
    },
    select: { id: true },
  });
  return event !== null;
}

/**
 * Connection-provider CRUD (I-02, spec §Provider administration criteria 1–10)
 * — the administrator's vendor OAuth registrations. Admin-direct and audited
 * like global secrets (clarifications Q14); every route gates on
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
 * **Sensitive edits and deletion (T-0010)**: a delta over
 * `SENSITIVE_PROVIDER_FIELDS` is refused with 409 `confirmation_required`
 * (carrying the impact payload) until the request carries the
 * `CONFIRM_INVALIDATION_FIELD` acknowledgement; with it — and for every
 * acknowledged deletion — the revision bump, the connection invalidations
 * (status + the ADR-0008 retirement-ledger mark in one UPDATE), the
 * pending-attempt kills, and the removal all commit as **one transaction**
 * (ADR-0004 §Implementation Notes). The vault is never inside that boundary:
 * credentials are sealed before it and released after it, so an interrupted
 * mutation leaves revision, connections, and attempts exactly as before
 * (criterion 10) and strands nothing.
 *
 * **Import and export (T-0011)**: the export is a credential-free read of one
 * provider's editable configuration against the shared document schema — a
 * failed or drifted read is an export failure, never a partial file, and
 * repeating it changes nothing. Import applies one document with an explicit
 * mode: create (credentials required — they are never imported) rides
 * {@link sealAndCreateProvider}, the form's sealed, audited create path;
 * update names the administrator-selected target by id and rides
 * {@link applyProviderUpdate}, the form's PUT path — validation, the revision
 * CAS, the confirmation gate, and the invalidation transaction included — so
 * an imported sensitive edit and a form edit are indistinguishable in effect.
 * The preview parses and proposes without applying; a name collision never
 * selects a target.
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

  /**
   * The import preview's parse (T-0011) rejects with **400**, not the module's
   * 422: design.md §Portal API endpoints fixes "400 malformed" for the
   * preview — its job is telling the SPA a picked file is not a provider
   * export, a request-shape mistake, while the apply route below keeps the
   * create/PUT convention (422, field errors render on form inputs). The zod
   * issues ride `details` either way.
   */
  const parsePreviewBody = <S extends z.ZodType>(schema: S, body: unknown): z.output<S> => {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new AppError(
        "validation_failed",
        "import preview request is malformed",
        result.error.issues,
        400,
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

  /**
   * The export document (T-0011), from the stored row — field-by-field like
   * `toMetadata`, never a spread, so a future credential column cannot ride
   * into the one artifact administrators move between deployments. A row that
   * fails the shared document schema is a data-integrity failure: reported as
   * an internal export failure (criterion 11 — a failed read is never a
   * successful partial export), issues logged, never echoed.
   */
  const toExportDocument = (row: ProviderRow): ProviderExportDocument => {
    const parsed = ProviderExportDocumentSchema.safeParse({
      version: 1,
      provider: {
        ref: row.ref,
        kind: row.kind,
        displayName: row.displayName,
        authorizeEndpoint: row.authorizeEndpoint,
        tokenEndpoint: row.tokenEndpoint,
        requestedScopes: row.requestedScopes,
        apiOrigins: row.apiOrigins,
        tokenPlacement: row.tokenPlacement,
      },
    });
    if (!parsed.success) {
      app.log.error(
        {
          event: "provider.export_read_failed",
          providerId: row.id,
          ref: row.ref,
          issues: parsed.error.issues,
        },
        "stored provider configuration failed the export document schema",
      );
      throw new AppError(
        "internal",
        `provider "${row.ref}" could not be exported — its stored configuration is invalid`,
      );
    }
    return parsed.data;
  };

  type ReleaseReason = "create-rollback" | "edit-rollback" | "rotate" | "delete";
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

  /**
   * The create path the form route and the import's create mode (T-0011)
   * share: seal both credentials, land the row, and on any failure release
   * what was sealed — nothing strands an unreferenced vault entry. The 409
   * maps the ref+env uniqueness violation, naming the conflict (criterion
   * 10's duplicate class).
   */
  const sealAndCreateProvider = async (
    actor: Actor,
    body: ProviderCreateRequest,
  ): Promise<ProviderRow> => {
    // seal() writes to the vault before the row exists — same window as the
    // secrets routes, so anything that stops the row landing releases both
    // materials (no path strands an unreferenced vault entry).
    const clientIdMaterial = await store().seal(body.clientId);
    const clientSecretMaterial = await store().seal(body.clientSecret);
    let row: ProviderRow;
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
    return row;
  };

  app.post("/api/v1/providers", { preHandler: authenticate }, async (req, reply) => {
    const actor = requireAdmin(req);
    const body = parseBody(ProviderCreateRequestSchema, req.body);
    const row = await sealAndCreateProvider(actor, body);
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

  app.get<{ Params: { id: string } }>(
    "/api/v1/providers/:id/export",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireAdmin(req);
      // The read is the export's failure surface (criterion 11): an unknown id
      // is a 404, a failed or drifted read a 5xx — never a successful partial
      // document the SPA could save as if it were the provider's configuration.
      const row = await app.prisma.connectionProvider.findUnique({
        where: { id: req.params.id },
      });
      if (!row) throw new AppError("not_found", `provider "${req.params.id}" not found`);
      const document = toExportDocument(row);
      // A read-only mutation of nothing: repeating an export re-reads the same
      // configuration and changes it nowhere — the audit trail is the only
      // trace (bounded metadata; no endpoint URL, no material).
      await audit("provider.exported", actor.sub, {
        providerId: row.id,
        ref: row.ref,
        env: row.env,
        kind: row.kind,
      });
      return document;
    },
  );

  /**
   * The edit path the form route and the import's update mode (T-0011) share:
   * the sensitive-delta detection, the `confirmation_required` gate, the
   * sealed-credential CAS, the one all-or-nothing transaction, and the
   * releases. The audit action is the caller's — `provider.updated` for the
   * form, `provider.imported` for an import — with the same bounded metadata
   * plus the caller's extra. An imported update and a form edit are
   * indistinguishable in effect by construction: there is no second
   * implementation of any of these rules.
   */
  const applyProviderUpdate = async (
    actor: Actor,
    row: ProviderRow,
    body: ProviderUpdateRequest,
    auditEvent: {
      action: "provider.updated" | "provider.imported";
      extra?: Record<string, unknown>;
    },
  ): Promise<ProviderMetadata> => {
    const stored = parseStoredRow(row);
    const delta = sensitiveDelta(stored, body);

    // The acknowledgement gate, BEFORE any custody work: a sensitive delta
    // submitted without the review panel's confirmation applies nothing and
    // must not even seal — the impact payload answers from stored state
    // alone. Display-name changes and secret rotations never reach this
    // (they are not on SENSITIVE_PROVIDER_FIELDS).
    if (delta.length > 0 && body.confirmInvalidation !== true) {
      throw new AppError(
        "confirmation_required",
        `editing ${delta.join(", ")} of provider "${row.ref}" invalidates its ` +
          `existing user connections and pending consent attempts, and affected ` +
          `apps need approval again — confirm to apply`,
        ConfirmationRequiredDetailsSchema.parse({
          impact: await providerImpact(app.prisma, row),
          sensitiveFields: delta,
        }),
      );
    }

    const secretRotated = body.clientSecret !== undefined;
    const clientIdentityChanged = body.clientId !== undefined;
    // Seal any supplied credential before the CAS: a lost race must release
    // what was sealed, and a won race swaps the row to material that already
    // exists. Absent means keep — the stored material is never read back, so
    // "blank" is the only way an edit form says "unchanged". Sealing (a vault
    // write) happens OUTSIDE the transaction below — the all-or-nothing
    // boundary never spans the vault.
    const clientIdMaterial = body.clientId === undefined ? null : await store().seal(body.clientId);
    const clientSecretMaterial =
      body.clientSecret === undefined ? null : await store().seal(body.clientSecret);
    const supplied: CredentialRelease[] = [
      ...(clientIdMaterial !== null
        ? [{ material: clientIdMaterial, field: "clientId" as const }]
        : []),
      ...(clientSecretMaterial !== null
        ? [{ material: clientSecretMaterial, field: "clientSecret" as const }]
        : []),
    ];

    // The mutation itself, all-or-nothing (ADR-0004 §Implementation Notes;
    // criterion 10): the CAS'd settings write — with the revision bump when
    // the delta is sensitive — plus the connection and attempt
    // invalidations, in one transaction. An interrupted edit leaves
    // revision, connections, and attempts exactly as before, and nothing
    // intermediate is observable.
    let updated: ProviderRow;
    let invalidatedConnections = 0;
    let killedAttempts = 0;
    try {
      const applied = await app.prisma.$transaction(async (tx) => {
        // The CAS: the loaded revision, plus — for each supplied credential —
        // the row's current material, so two concurrent rotations arbitrate
        // even though neither advances the revision (the `rotateOrRelease`
        // pattern; without it, both land and the loser's sealed material is
        // stranded).
        const { count } = await tx.connectionProvider.updateMany({
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
            // Only a sensitive mutation advances the revision (ADR-0004) —
            // the bump IS the binding block: T-0009's
            // isProviderBindingEffective turns false for every stamp filed
            // against the old revision, which is what the manifest read's
            // reapproval-needed badge and the consult's not_available
            // outcome report. No separate blocked-state storage exists.
            ...(delta.length > 0 ? { revision: { increment: 1 } } : {}),
          },
        });
        if (count === 0) throw new CasLost();

        if (delta.length > 0) {
          invalidatedConnections = await invalidateConnections(tx, row);
          killedAttempts = await killPendingAttempts(tx, row);
        }

        return tx.connectionProvider.findUniqueOrThrow({ where: { id: row.id } });
      });
      updated = applied;
    } catch (err) {
      // Every failure path releases what was sealed — nothing referenced the
      // new materials, so no path strands them (the create/CAS-loss
      // discipline, widened to the whole transaction).
      await releaseAll(supplied, {
        actor: actor.sub,
        ref: row.ref,
        env: row.env,
        reason: "edit-rollback",
      });
      if (err instanceof CasLost) {
        throw new AppError(
          "conflict",
          `provider "${row.ref}" changed since it was loaded — reload the current settings, review them, and confirm again`,
        );
      }
      throw err;
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

    await audit(auditEvent.action, actor.sub, {
      ref: row.ref,
      env: row.env,
      secretRotated,
      clientIdentityChanged,
      sensitive: delta.length > 0,
      ...(delta.length > 0
        ? { sensitiveFields: delta, invalidatedConnections, killedAttempts }
        : {}),
      ...(auditEvent.extra ?? {}),
    });
    return toMetadata(updated);
  };

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
      return applyProviderUpdate(actor, row, body, { action: "provider.updated" });
    },
  );

  app.post("/api/v1/providers/import/preview", { preHandler: authenticate }, async (req) => {
    requireAdmin(req);
    const body = parsePreviewBody(ProviderImportPreviewRequestSchema, req.body);
    const imported = body.document.provider;
    // The cross-field consistency the request schema deliberately leaves to
    // the route (see the schema's docblock) — one readable 400 per mistake.
    const malformed = (message: string) =>
      new AppError("validation_failed", message, undefined, 400);
    if (body.mode === undefined) {
      if (body.env !== undefined || body.targetId !== undefined) {
        throw malformed("a preview without a mode proposes nothing — drop env and targetId");
      }
      // The file-picker's validate-only call: the document parsed against the
      // shared schema — no mode chosen, nothing proposed yet.
      return ProviderImportPreviewResponseSchema.parse({ mode: null, provider: imported });
    }
    if (body.mode === "create") {
      if (body.env === undefined) {
        throw malformed(
          "a create-mode preview names the environment the provider would be created in",
        );
      }
      if (body.targetId !== undefined) {
        throw malformed("a create-mode proposal targets nothing — drop targetId");
      }
      // The collision preview (design.md §Import/export): an existing ref+env
      // row is surfaced here, before apply — a collision never becomes an
      // implicit update; the administrator switches modes or environments.
      const existing = await app.prisma.connectionProvider.findUnique({
        where: { ref_env: { ref: imported.ref, env: body.env } },
      });
      return ProviderImportPreviewResponseSchema.parse({
        mode: "create",
        env: body.env,
        provider: imported,
        collision: existing
          ? {
              providerId: existing.id,
              ref: existing.ref,
              env: existing.env === "dev" ? "dev" : "prod",
            }
          : null,
      });
    }
    if (body.targetId === undefined) {
      throw malformed(
        "an update-mode preview names its target provider explicitly — a name collision never selects one",
      );
    }
    if (body.env !== undefined) {
      throw malformed("an update applies to the target's own environment — drop env");
    }
    const row = await app.prisma.connectionProvider.findUnique({
      where: { id: body.targetId },
    });
    if (!row) throw new AppError("not_found", `provider "${body.targetId}" not found`);
    const stored = parseStoredRow(row);
    return ProviderImportPreviewResponseSchema.parse({
      mode: "update",
      target: {
        providerId: row.id,
        ref: row.ref,
        env: row.env === "dev" ? "dev" : "prod",
        displayName: row.displayName,
        revision: row.revision,
      },
      diff: previewDiff(stored, imported),
      // The same comparison the apply path's confirmation gate runs — the
      // panel's sensitive-field list can never disagree with the 409.
      sensitiveFields: sensitiveDelta(stored, importUpdateRequest(imported, row.revision)),
    });
  });

  app.post("/api/v1/providers/import", { preHandler: authenticate }, async (req, reply) => {
    const actor = requireAdmin(req);
    const body = parseBody(ProviderImportRequestSchema, req.body);
    if (body.mode === "create") {
      // The document supplies the configuration, the request the partition and
      // the required credentials — the only place credential input is accepted
      // on this surface (criteria 5, 12).
      const row = await sealAndCreateProvider(actor, {
        ...body.document.provider,
        env: body.env,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
      });
      await audit("provider.imported", actor.sub, {
        mode: "create",
        ref: row.ref,
        env: row.env,
        kind: row.kind,
      });
      reply.status(201);
      return ProviderImportResponseSchema.parse({ outcome: "created", provider: toMetadata(row) });
    }
    const row = await app.prisma.connectionProvider.findUnique({
      where: { id: body.targetId },
    });
    if (!row) throw new AppError("not_found", `provider "${body.targetId}" not found`);
    const confirm = body[CONFIRM_INVALIDATION_FIELD];
    const provider = await applyProviderUpdate(
      actor,
      row,
      importUpdateRequest(body.document.provider, body.revision, {
        ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
        ...(body.clientSecret !== undefined ? { clientSecret: body.clientSecret } : {}),
        ...(confirm !== undefined ? { confirmInvalidation: confirm } : {}),
      }),
      { action: "provider.imported", extra: { mode: "update", providerId: row.id } },
    );
    return ProviderImportResponseSchema.parse({ outcome: "updated", provider });
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/providers/:id/impact",
    { preHandler: authenticate },
    async (req) => {
      requireAdmin(req);
      const row = await app.prisma.connectionProvider.findUnique({
        where: { id: req.params.id },
      });
      if (!row) throw new AppError("not_found", `provider "${req.params.id}" not found`);
      return providerImpact(app.prisma, row);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/providers/:id",
    { preHandler: authenticate },
    async (req) => {
      const actor = requireAdmin(req);
      // An absent body parses as no acknowledgement — deletion's confirmation
      // is never optional, and the 409 below is the outcome that teaches it.
      const body = parseBody(ProviderDeleteRequestSchema, req.body ?? {});
      const row = await app.prisma.connectionProvider.findUnique({
        where: { id: req.params.id },
      });
      if (!row) {
        // Distinguishable repeat (criterion 10): the id this call names was
        // removed here — answered from the audit event, never from a ref
        // match, so a replacement provider recreated under the same ref (a new
        // surrogate id) is untouched by an old id's repeat deletion.
        if (await removedProviderEventExists(app.prisma, req.params.id)) {
          return ProviderDeleteResponseSchema.parse({ outcome: "already_removed" });
        }
        throw new AppError("not_found", `provider "${req.params.id}" not found`);
      }

      if (body[CONFIRM_INVALIDATION_FIELD] !== true) {
        throw new AppError(
          "confirmation_required",
          `deleting provider "${row.ref}" invalidates its existing user connections ` +
            `and pending consent attempts, and affected apps need approval again — confirm to delete`,
          ConfirmationRequiredDetailsSchema.parse({
            impact: await providerImpact(app.prisma, row),
          }),
        );
      }

      const boundApps = (await providerImpact(app.prisma, row)).boundApps.length;
      await app.prisma.$transaction(async (tx) => {
        // The invalidations, the removal, and the audit row: one transaction
        // (criterion 10's all-or-nothing). The audit row is what a repeat
        // deletion is answered from, so it commits with the removal or not at
        // all.
        const invalidatedConnections = await invalidateConnections(tx, row);
        const killedAttempts = await killPendingAttempts(tx, row);
        const { count } = await tx.connectionProvider.deleteMany({ where: { id: row.id } });
        if (count === 0) {
          // A concurrent removal won; roll everything back — the loser answers
          // from the audit event on its next call.
          throw new CasLost();
        }
        await tx.auditEvent.create({
          data: {
            appId: null,
            actor: actor.sub,
            action: "provider.deleted",
            // Bounded metadata (design.md §Operator-visible signals): refs,
            // env, ids, and counts — never a credential, sealed material, or
            // endpoint URL.
            metadata: {
              ref: row.ref,
              env: row.env,
              providerId: row.id,
              boundApps,
              connections: invalidatedConnections,
              pendingAttempts: killedAttempts,
            },
          },
        });
      });

      // The row is gone — its sealed credentials are unreferenced. Released
      // OUTSIDE the transaction (the vault is never inside the
      // all-or-nothing boundary); a failed destroy is reported as
      // provider.destroy_failed and never un-deletes the row.
      await releaseAll(
        [
          { material: row.clientIdMaterial, field: "clientId" },
          { material: row.clientSecretMaterial, field: "clientSecret" },
        ],
        { actor: actor.sub, ref: row.ref, env: row.env, reason: "delete" },
      );
      return ProviderDeleteResponseSchema.parse({ outcome: "deleted" });
    },
  );
}
