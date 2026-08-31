import { z } from "zod";

/**
 * What kind of principal a metered call or a collection submission came from.
 *
 * Recorded because it cannot be reliably *inferred*. The obvious inference —
 * read it off `userOid`'s shape — is wrong: a shared-password pseudonym is
 * `pw_` + 12 base64url chars, and Entra's `sub` is 32 random bytes in the same
 * base64url alphabet, **which includes `_`**. So roughly one real subject in
 * 262,144 begins `pw_`, and a prefix test labels that person's calls as coming
 * from an anonymous shared-password visitor. A wrong attribution in an audit UI
 * is worse than no attribution, and the odds are not small enough to wave at:
 * one tenant with a few hundred thousand sign-ins expects a collision.
 *
 * So the edge writes down what it *knows* at capture time — it always knows,
 * because the kind is decided by which code path minted the principal — and the
 * portal reads a value instead of guessing at one.
 *
 * - `user` — a directory subject from an OIDC login. The only kind that can
 *   carry a captured `userName`/`userEmail`.
 * - `password` — a shared-password visitor (`pw_*`). A fresh pseudonym per
 *   login, so unattributable *across* sessions by construction, not by omission.
 * - `anon` — a public-app visitor. No principal at all (app-data design §6);
 *   the ledger records the `"anon"` sentinel, collections record NULL.
 * - `dev` — a dev-token developer, keyed by the portal actor's subject.
 *
 * Plain `TEXT` in the database with this array as the source of truth, matching
 * `GATEWAY_OUTCOMES` — an enum type would need a migration to add a kind.
 * Nullable in the DB: rows predating the column carry no kind, and the portal
 * renders those from `userOid` alone rather than inventing one.
 */
export const PRINCIPAL_KINDS = ["user", "password", "anon", "dev"] as const;
export const PrincipalKindSchema = z.enum(PRINCIPAL_KINDS);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;
