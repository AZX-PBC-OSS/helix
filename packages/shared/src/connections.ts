import { z } from "zod";

import { EnvSchema } from "./env.js";
import { ScopeTokenSchema } from "./providers.js";

/**
 * User connections — the per-user consent substrate (I-02, ADR-0006 §Shared
 * ground). A **connection** is one user's consent to one provider in one
 * environment: the stored `user_connections` row, keyed
 * `(userOid, providerId, env)`.
 *
 * The stored row shape is defined ONCE, here, because **both planes write the
 * row**: egress (renewal outcomes — the material swap, expiry, ledger fields,
 * the reconnect-needed flip) and the portal (callback save, invalidation,
 * disconnect). Every writer and reader — egress writers, the resolver, My
 * Connections, the sweep — parses this one definition; none re-derives a local
 * status vocabulary. Dev-envelope parity with the providers schemas: the
 * domain is greenfield, every row is written through these schemas from the
 * first commit, so there is no legacy row shape a lenient read must tolerate —
 * the parse is strict, and an unexpected shape is a bug surfaced as a parse
 * failure, never a valid-looking row silently carrying something nobody wrote.
 *
 * The credential field carries **sealed material** — the opaque token
 * `SecretStore.seal()` produces (a dev AES-GCM envelope or a Key Vault
 * reference), mirroring `ConnectionProviderSchema`'s material fields. Only
 * egress opens it; no reader renders it.
 */

/**
 * The connection-status vocabulary, bounded and fail closed: an unknown
 * status value fails the parse (and the DB CHECK in migration
 * 20260925065340_connection_substrate fails the write) rather than being
 * coerced into a state a consumer might misread as usable.
 *
 * - `live` — the consent is usable as recorded.
 * - `reconnect-needed` — Helix knows reconnection is required (an uncertain
 *   refresh-token rotation, an explicit permission loss at renewal); the row
 *   never authorizes a call, and the next consent is a fresh explicit Connect.
 * - `invalidated` — the consent was withdrawn or superseded (disconnect, a
 *   sensitive provider edit, provider deletion); kept as a tombstone until
 *   re-consent upserts over it, never usable.
 */
export const CONNECTION_STATUSES = ["live", "reconnect-needed", "invalidated"] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/**
 * The row's `material` field's inner envelope — how the TWO sealed references
 * an exchange produces (the access and refresh materials are sealed separately,
 * `ExchangeResponseSchema`'s `exchanged` variant) fit the ONE column both
 * planes write. The portal's callback serializes this envelope into
 * `user_connections.material`; egress parses it on every renewal and swap
 * (T-0021). The values are `SecretStore.seal()` outputs — opaque references,
 * never plaintext — so the envelope is data-shape only and no custody rule
 * changes: opening happens in egress alone (ADR-0006).
 */
export const ConnectionMaterialSchema = z.strictObject({
  access: z.string().min(1),
  refresh: z.string().min(1),
});
export type ConnectionMaterial = z.infer<typeof ConnectionMaterialSchema>;

/**
 * Sanity rail on the granted-scope list — bounded like the provider schemas'
 * arrays, not a security limit. Items parse as RFC 6749 §3.3 scope tokens
 * (`ScopeTokenSchema`), the same vocabulary `requestedScopes` speaks: the
 * consult's has-all-requested check compares the two lists directly. Duplicates
 * are not refined away — a vendor echoing a scope twice is vendor behavior to
 * display, not a malformed row to fail a read on.
 */
const MAX_GRANTED_SCOPES = 64;
const GrantedScopesSchema = z.array(ScopeTokenSchema).max(MAX_GRANTED_SCOPES);

/**
 * The stored `user_connections` row — the shape both planes agree the row has,
 * mirrored by the portal's Prisma model (`UserConnection`) and written only
 * through this parse. Field-by-field:
 *
 * - `material` — the sealed access + refresh material (`SecretStore.seal()`
 *   output, opaque; never plaintext). A swap writes the OLD reference into
 *   `pendingRetire` in the SAME UPDATE (ADR-0008's rule) so the egress sweep
 *   can destroy what was replaced.
 * - `providerRevision` — the provider row's revision at consent (ADR-0004):
 *   a sensitive provider edit invalidates the row, so a stale stamp fails
 *   closed at resolution.
 * - `expiresAt` — the access token's expiry; egress renews when a call lands
 *   past it. `renewBeforeNext` is criterion 40's flag: set after a pre-expiry
 *   vendor 401 so the next request renews first.
 * - `lastRenewedAt` / `pendingRetire` — the in-row renewal/retirement ledger
 *   (ADR-0008): when egress last renewed, and the sealed reference currently
 *   awaiting the sweep's conditional destroy (NULL once claimed and destroyed).
 */
export const UserConnectionSchema = z.strictObject({
  id: z.uuid(),
  userOid: z.string().min(1),
  providerId: z.uuid(),
  providerRevision: z.int().positive(),
  env: EnvSchema,
  status: ConnectionStatusSchema,
  material: z.string().min(1),
  grantedScopes: GrantedScopesSchema,
  grantedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  renewBeforeNext: z.boolean(),
  pendingRetire: z.string().min(1).nullable(),
  lastRenewedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type UserConnection = z.infer<typeof UserConnectionSchema>;

/**
 * The LISTEN/NOTIFY channel for provider-config distribution (ADR-0011): a
 * statement-level trigger on `connection_providers` (migration
 * 20260925065340_connection_substrate) pings this channel on every provider
 * mutation, and egress's dedicated LISTEN client — the channel's ONLY listener
 * (the edge holds no provider rows and listens to nothing new; the portal does
 * not cache its own table) — reconciles its revision-keyed cache.
 *
 * The migration embeds the same literal; this constant is the single
 * definition the listener and every test import (the keep-in-sync convention
 * the registry channel sets: `REGISTRY_CHANNEL` in
 * apps/edge/src/registry/listener.ts duplicates 'helix_registry_changed').
 */
export const PROVIDERS_CHANNEL = "helix_providers_changed";
