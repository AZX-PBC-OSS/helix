/**
 * Internal service JWTs (I-02 architecture ADR-0003): the two internal call
 * directions the platform gains beyond the attested instruction — edge→portal
 * (consult, cancel, reverse proxy) and portal→egress (code exchange).
 *
 * Every internal call carries a per-call minted JWT in the instruction's
 * signing discipline (`./instruction.ts`): HS256 via jose over a shared secret
 * that is bilateral per trust direction, distinct `typ` + `aud` per direction,
 * a ~30 s TTL, and no burn store — the consult is read-only, cancel is
 * own-attempt-scoped, and a replayed exchange re-sends an already-consumed
 * grant code the vendor rejects, so every operation is self-limiting within
 * the TTL.
 *
 * The verify rule is **aud + typ + max age, fail closed**: jose asserts the
 * audience (a token without it, or for another audience, is refused — no token
 * passthrough between seams, the ADR-0013 Step 1 rule applied to the new
 * directions), the `typ` header, and `maxTokenAge`; the verifier additionally
 * requires `exp`/`iat` to be present (jose only enforces them when present)
 * and rejects any other claim (the ADR-0005 strict-parse discipline — a future
 * claim update rolls verifiers first, it is never silently ignored). The
 * implementation lives per plane, like the instruction's: the edge mints
 * (`apps/edge/src/internalJwt.ts`), the portal verifies and mints
 * (`apps/portal/src/internalJwt.ts`), egress verifies
 * (`apps/egress/src/internalJwt.ts`) — all importing these constants.
 *
 * The three bilateral keys after ADR-0003: `HELIX_INSTRUCTION_SECRET`
 * (edge↔egress, the existing instruction key — untouched), `HELIX_INTERNAL_SECRET`
 * (edge↔portal), and `HELIX_EXCHANGE_SECRET` (portal↔egress).
 */

/** JWT `typ` header for the edge→portal direction — unredeemable as any other token. */
export const INTERNAL_JWT_TYP = "helix-internal+jwt";
/** JWT `aud` for the edge→portal direction — the portal trust domain. */
export const INTERNAL_AUDIENCE = "azx-portal";
/** Short TTL: the edge→portal token is minted per call and consumed immediately. */
export const INTERNAL_TTL_SECONDS = 30;
/** HKDF info string for the edge↔portal key (domain separation). */
export const INTERNAL_KEY_INFO = "helix-internal-v1";

/** JWT `typ` header for the portal→egress direction — unredeemable as any other token. */
export const EXCHANGE_JWT_TYP = "helix-exchange+jwt";
/**
 * JWT `aud` for the portal→egress direction — egress's exchange trust domain.
 * Deliberately distinct from {@link INSTRUCTION_AUDIENCE} (`azx-egress`): the
 * same plane verifies both seams, so the audience is what keeps an exchange
 * token unredeemable at the instruction seam and vice versa.
 */
export const EXCHANGE_AUDIENCE = "azx-egress-exchange";
/** Short TTL: the portal→egress token is minted per call and consumed immediately. */
export const EXCHANGE_TTL_SECONDS = 30;
/** HKDF info string for the portal↔egress key (domain separation). */
export const EXCHANGE_KEY_INFO = "helix-exchange-v1";

/** Header carrying the edge→portal internal JWT (the consult, cancel, and reverse proxy). */
export const INTERNAL_AUTH_HEADER = "x-helix-internal-authorization";
/** Header carrying the portal→egress exchange JWT. */
export const EXCHANGE_AUTH_HEADER = "x-helix-exchange-authorization";
