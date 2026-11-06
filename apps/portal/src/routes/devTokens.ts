import type { FastifyInstance } from "fastify";
import { DEV_TOKEN_DEFAULT_TTL_DAYS, type DevTokenMetadata } from "@azx-pbc/shared";
import { parseRequest, portal, responseBody } from "@azx-pbc/shared/contracts";
import { hashDevToken, newDevToken } from "@azx-pbc/shared/devToken";
import { requireActor } from "../plugins/auth.js";
import { contractRoute } from "../plugins/contractRoute.js";
import { AppError } from "../plugins/errors.js";

/**
 * Dev-token CRUD (dev-mode design §4, §7.2). A dev token is a scoped, opaque
 * bearer an app owner mints to develop the app against its `env=dev` partition
 * from a registered foreign origin (Lovable, a cloud IDE). It is **write-only**:
 * the plaintext is returned once on mint/rotate and stored only as a SHA-256 hash
 * (`hashDevToken`) — there is no re-display route. Mutations carry the `ownsApp`
 * gate (a dev token is a credential — issue #9 / §7.2): a leaked mint route would
 * be a self-service path into another owner's dev partition.
 *
 * The step-3 dev-gateway consumes these rows (hash → non-revoked/non-expired
 * lookup → Origin-in-`origins`); nothing here validates or accepts a token.
 */

interface DevTokenRow {
  id: string;
  developerOid: string;
  origins: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

function toMetadata(row: DevTokenRow): DevTokenMetadata {
  return {
    id: row.id,
    developerOid: row.developerOid,
    origins: row.origins,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function expiryFromNow(ttlDays: number): Date {
  return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
}

export async function devTokenRoutes(app: FastifyInstance): Promise<void> {
  const findApp = async (slug: string) => {
    const row = await app.prisma.app.findUnique({ where: { slug } });
    if (!row) throw new AppError("not_found", `app "${slug}" not found`);
    return row;
  };

  const audit = (appId: string, actor: string, action: string, metadata: object = {}) =>
    app.prisma.auditEvent.create({ data: { appId, actor, action, metadata } });

  // List the app's dev tokens (metadata only — never the hash). Authenticated-only,
  // matching the secrets-list read posture; owner-scoped read filtering is the
  // same ADR-0007 v0 residual as everywhere else (reads stay authenticated-only).
  contractRoute(app, portal.listDevTokens, async (req) => {
    requireActor(req);
    const { params } = parseRequest(portal.listDevTokens, req);
    const appRow = await findApp(params.slug);
    const rows = await app.prisma.appDevToken.findMany({
      where: { appId: appRow.id },
      orderBy: { createdAt: "desc" },
    });
    return responseBody(portal.listDevTokens, 200, rows.map(toMetadata));
  });

  // Mint a new dev token → returns the plaintext ONCE, stores only its hash.
  contractRoute(app, portal.mintDevToken, async (req, reply) => {
    const actor = requireActor(req);
    const { params, body } = parseRequest(portal.mintDevToken, req);
    const appRow = await findApp(params.slug);
    const token = newDevToken();
    const row = await app.prisma.appDevToken.create({
      data: {
        appId: appRow.id,
        // The minting developer's canonical id (ADR-0048): the actor's oid,
        // NOT the email-collapsed sub — the dev gateway resolves this into
        // the dev-tier partition key and metering identity, and an opaque id
        // is what those consumers want.
        developerOid: actor.oid,
        tokenHash: hashDevToken(token),
        origins: body.origins,
        expiresAt: expiryFromNow(body.ttlDays ?? DEV_TOKEN_DEFAULT_TTL_DAYS),
      },
    });
    await audit(appRow.id, actor.sub, "app.dev-token.minted", {
      id: row.id,
      origins: body.origins,
    });
    reply.status(201);
    return responseBody(portal.mintDevToken, 201, { token, metadata: toMetadata(row) });
  });

  // Rotate: mint a fresh secret for an existing token, keeping its origins and
  // renewing the lifetime (pass `ttlDays` to override; else the default TTL).
  // Returns the new plaintext once. A revoked token is NOT rotatable — revocation
  // is terminal (it matches the UI's "can't be undone" and the hidden Rotate
  // button); rotating would silently re-activate the row. Mint a new one instead.
  contractRoute(app, portal.rotateDevToken, async (req) => {
    const actor = requireActor(req);
    const { params, body } = parseRequest(portal.rotateDevToken, req);
    const appRow = await findApp(params.slug);
    // Scope the id to the app so a valid owner can't target another app's row.
    const existing = await app.prisma.appDevToken.findFirst({
      where: { id: params.id, appId: appRow.id },
    });
    if (!existing) throw new AppError("not_found", "dev token not found");
    if (existing.revokedAt) {
      throw new AppError("conflict", "cannot rotate a revoked dev token — mint a new one");
    }
    const token = newDevToken();
    const row = await app.prisma.appDevToken.update({
      where: { id: existing.id },
      data: {
        tokenHash: hashDevToken(token),
        expiresAt: expiryFromNow(body?.ttlDays ?? DEV_TOKEN_DEFAULT_TTL_DAYS),
      },
    });
    await audit(appRow.id, actor.sub, "app.dev-token.rotated", { id: row.id });
    return responseBody(portal.rotateDevToken, 200, { token, metadata: toMetadata(row) });
  });

  // Revoke: a soft flip (`revokedAt`) so the dev-gateway's per-request check is a
  // lookup — revocation is immediate (§4.1).
  contractRoute(app, portal.revokeDevToken, async (req, reply) => {
    const actor = requireActor(req);
    const { params } = parseRequest(portal.revokeDevToken, req);
    const appRow = await findApp(params.slug);
    const existing = await app.prisma.appDevToken.findFirst({
      where: { id: params.id, appId: appRow.id },
    });
    if (!existing) throw new AppError("not_found", "dev token not found");
    await app.prisma.appDevToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    await audit(appRow.id, actor.sub, "app.dev-token.revoked", { id: existing.id });
    reply.status(204);
  });
}
