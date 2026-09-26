import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MyConnectionSchema,
  MyConnectionsResponseSchema,
  type DisconnectResponse,
} from "@azx-pbc/shared";
import {
  ATTR_ATTEMPTS_KILLED,
  ATTR_ENV,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  ROUTE_CONNECTIONS_MINE,
  ROUTE_CONNECTIONS_MINE_ID,
  SPAN_CONNECTIONS_DISCONNECT,
  SPAN_CONNECTIONS_MINE,
} from "@azx-pbc/shared/telemetry";
import { Prisma } from "../db/client.js";
import { authenticate, requireActor } from "../plugins/auth.js";
import { AppError } from "../plugins/errors.js";
import { withSpan } from "../telemetry.js";

/**
 * My Connections (I-02 T-0024, spec §My Connections and recovery criteria
 * 42–46) — the caller's own connections, scoped to the authenticated
 * principal by construction: every read and write carries `userOid` from the
 * verified actor, never from the request. No owner or admin gate — this is
 * the one user-scoped portal surface (clarifications Q11).
 *
 * **Metadata only**: the projection names the columns it selects and never
 * selects `material`, so the sealed reference cannot ride a payload even by
 * re-projection; the shared schemas structurally omit it. The list makes no
 * claim about the vendor-side grant — `status` is Helix's own row state
 * (criterion 42).
 *
 * **Disconnect is one transaction** (ADR-0008's one-UPDATE rule): the row's
 * status flip to `invalidated` and the retirement-ledger mark commit as one
 * UPDATE, the pending consent attempts started before it die beside them, and
 * the `connection.disconnected` audit row commits in the same boundary — so
 * use stops immediately (egress resolution and renewal both re-assert
 * `status = 'live'` on the row) and a repeat, a lost race, or an interrupted
 * mutation is all-or-nothing. A failure propagates: the response is an error,
 * never a successful removal (criterion 44).
 *
 * **Repeat semantics are the row's own state, id-scoped** (criterion 43): the
 * tombstone a disconnect leaves answers `already_removed` and writes nothing,
 * so a newer connection re-established over it inherits nothing from the
 * repeat. The answer never consults another principal's data — a foreign id
 * and an unknown id are the same 404.
 */
export async function myConnectionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/connections/mine", { preHandler: authenticate }, async (req) => {
    const actor = requireActor(req);
    return withSpan(SPAN_CONNECTIONS_MINE, { "http.route": ROUTE_CONNECTIONS_MINE }, async () => {
      const rows = await app.prisma.$queryRaw<
        Array<{
          id: string;
          status: string;
          grantedScopes: unknown;
          grantedAt: Date;
          env: string;
          providerRef: string;
          providerDisplayName: string;
        }>
      >(
        // The join is inner by design: a provider's rows are invalidated in the
        // same transaction that deletes it (T-0010), so a live connection whose
        // provider row vanished is not a state this platform can write.
        Prisma.sql`SELECT uc.id, uc.status, uc."grantedScopes", uc."grantedAt", uc.env,
              cp.ref AS "providerRef", cp."displayName" AS "providerDisplayName"
          FROM user_connections uc
          JOIN connection_providers cp ON cp.id = uc."providerId"
          WHERE uc."userOid" = ${actor.oid} AND uc.status <> 'invalidated'
          ORDER BY uc."grantedAt" DESC`,
      );

      // The apps bound to each provider ref — the disconnect confirmation's
      // blast radius (criteria 43, 45), carried per connection so the dialog
      // needs no second fetch. One query across all the caller's refs.
      const refs = [...new Set(rows.map((r) => r.providerRef))];
      const sharing = new Map<string, Array<{ id: string; slug: string; displayName: string }>>();
      if (refs.length > 0) {
        const bound = await app.prisma.$queryRaw<
          Array<{ id: string; slug: string; displayName: string; ref: string }>
        >(
          // The same containment T-0010's impact query runs, unrolled across
          // refs; a manifest binding is by ref and env-agnostic (who connects
          // decides the tier), so every ref-bound app shares the connection.
          Prisma.sql`SELECT DISTINCT a.id, a.slug, a."displayName", origin->>'provider' AS ref
            FROM apps a, jsonb_array_elements(a.capabilities->'fetch'->'origins') AS origin
            WHERE origin->>'provider' IN (${Prisma.join(refs)})`,
        );
        for (const b of bound) {
          const list = sharing.get(b.ref) ?? [];
          list.push({ id: b.id, slug: b.slug, displayName: b.displayName });
          sharing.set(b.ref, list);
        }
      }

      return MyConnectionsResponseSchema.parse({
        connections: rows.map((r) =>
          MyConnectionSchema.parse({
            id: r.id,
            providerRef: r.providerRef,
            providerDisplayName: r.providerDisplayName,
            env: r.env === "dev" ? "dev" : "prod",
            status: r.status,
            grantedScopes: r.grantedScopes,
            grantedAt: r.grantedAt.toISOString(),
            sharedApps: sharing.get(r.providerRef) ?? [],
          }),
        ),
      });
    });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/connections/mine/:id",
    { preHandler: authenticate },
    async (req): Promise<DisconnectResponse> => {
      const actor = requireActor(req);
      return withSpan(
        SPAN_CONNECTIONS_DISCONNECT,
        { "http.route": ROUTE_CONNECTIONS_MINE_ID },
        async (span) => {
          // A malformed id cannot name a connection: the same 404 an unknown
          // one gets, keeping the failure classes indistinguishable.
          const parsedId = z.uuid().safeParse(req.params.id);
          if (!parsedId.success) {
            throw new AppError("not_found", "connection not found");
          }
          const id = parsedId.data;

          const outcome = await app.prisma.$transaction(async (tx): Promise<DisconnectResponse> => {
            // The one UPDATE (ADR-0008): the invalidation and the ledger mark
            // — this row's own sealed material, for the egress sweep to
            // destroy — commit together. Scoped to the caller's row and
            // excluding the tombstone, so a repeat matches zero rows and
            // writes nothing at all. The single-slot residual (an egress
            // rotation racing this mark) is T-0010's accepted class.
            const invalidated = await tx.$queryRaw<Array<{ providerId: string; env: string }>>(
              Prisma.sql`UPDATE user_connections
                SET status = 'invalidated', "pendingRetire" = material, "updatedAt" = now()
                WHERE id = ${id}::uuid AND "userOid" = ${actor.oid}
                  AND status <> 'invalidated'
                RETURNING "providerId", env`,
            );
            if (invalidated.length === 0) {
              // Zero rows: unknown, another principal's, or already
              // invalidated. Decide from the caller's OWN row state only —
              // a foreign id looks exactly like a missing one (BOLA).
              const own = await tx.userConnection.findFirst({
                where: { id, userOid: actor.oid },
                select: { status: true },
              });
              if (own && own.status === "invalidated") {
                return { outcome: "already_removed" };
              }
              throw new AppError("not_found", "connection not found");
            }
            const row = invalidated[0]!;
            const env = row.env === "dev" ? "dev" : "prod";

            const provider = await tx.connectionProvider.findUnique({
              where: { id: row.providerId },
              select: { ref: true },
            });
            // Unreachable by construction (a provider's rows are invalidated
            // in the same transaction that deletes it), so the audit's bounded
            // metadata is always writable — fail rather than audit a guess.
            if (!provider) {
              throw new AppError("internal", "disconnected connection has no provider record");
            }

            // The pending consent attempts started before this disconnect:
            // killed by `cancelledAt`, the marker the claim probe already
            // refuses — a killed attempt can never complete (T-0010's
            // pattern, scoped to this one connection).
            const killed = await tx.connectionConsentAttempt.updateMany({
              where: {
                userOid: actor.oid,
                providerId: row.providerId,
                env,
                cancelledAt: null,
              },
              data: { cancelledAt: new Date() },
            });

            // The audit row is the removal's record and commits with it
            // (criterion 44: never a successful removal without the write).
            // Actor is the principal, pairing with `connection.connected`;
            // metadata bounded to ids, ref, env — never identity-bearing
            // beyond that, never material.
            await tx.auditEvent.create({
              data: {
                appId: null,
                actor: actor.oid,
                action: "connection.disconnected",
                metadata: { connectionId: id, providerRef: provider.ref, env },
              },
            });

            span.setAttributes({
              [ATTR_PROVIDER_REF]: provider.ref,
              [ATTR_ENV]: env,
              [ATTR_ATTEMPTS_KILLED]: killed.count,
            });
            return { outcome: "disconnected" };
          });

          span.setAttributes({ [ATTR_OUTCOME]: outcome.outcome });
          return outcome;
        },
      );
    },
  );
}
