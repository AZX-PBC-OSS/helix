import { z } from "zod";

/**
 * Dev-token control-plane shapes (dev-mode design §4, §7.2, Appendix A.3). The
 * portal mints/rotates/revokes a scoped dev token for an app; the step-3
 * dev-gateway verifies it. These schemas carry **metadata only** — the plaintext
 * token crosses the API boundary once, on the mint/rotate response, and is never
 * returned again (like the connection-secret value). The hashing primitive lives
 * in the node-only `@azx-pbc/shared/devToken` subpath.
 */

/** Default token lifetime when the mint request omits `ttlDays` (§4.1: hours/days). */
export const DEV_TOKEN_DEFAULT_TTL_DAYS = 30;

/**
 * An allowed CORS origin the dev-gateway will reflect for a token (§4.1). Must be
 * an **exact** origin — `scheme://host[:port]`, http(s) only, no path, query,
 * fragment, credentials, or wildcard. Wildcards are disallowed by design: the
 * owner registers concrete origins (e.g. `https://myapp.lovable.app`,
 * `http://localhost:5173`), so a leaked token can't be replayed from anywhere.
 */
export function isValidDevOrigin(input: string): boolean {
  if (input.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  if (url.username !== "" || url.password !== "") return false;
  // Reject anything the URL parser normalized away (a trailing-slash form is fine).
  return input === url.origin || input === `${url.origin}/`;
}

export const DevOriginSchema = z
  .string()
  .refine(
    isValidDevOrigin,
    "must be an exact origin (scheme://host[:port]) — no path, query, or wildcard",
  )
  // Canonicalize to the URL origin (drops a trailing slash and normalizes case)
  // so the stored form matches the browser `Origin` header the dev-gateway
  // compares against — a `https://x.example/` mint would otherwise never match.
  .transform((o) => new URL(o).origin);

/** Token lifetime, shared by mint and rotate (§4.1). */
const TtlDaysSchema = z.number().int().min(1).max(365).optional();

/** Mint a dev token: the origins it may be used from + an optional lifetime. */
export const DevTokenMintRequestSchema = z.object({
  origins: z.array(DevOriginSchema).min(1).max(20),
  ttlDays: TtlDaysSchema,
});
export type DevTokenMintRequest = z.infer<typeof DevTokenMintRequestSchema>;

/** Rotate a dev token: re-roll the secret, renewing the lifetime (default TTL if omitted). */
export const DevTokenRotateRequestSchema = z.object({
  ttlDays: TtlDaysSchema,
});
export type DevTokenRotateRequest = z.infer<typeof DevTokenRotateRequestSchema>;

/** What the portal returns about a token — never the hash, never the plaintext. */
export const DevTokenMetadataSchema = z.object({
  id: z.string(),
  developerOid: z.string(),
  origins: z.array(z.string()),
  expiresAt: z.string(),
  revokedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type DevTokenMetadata = z.infer<typeof DevTokenMetadataSchema>;

/** Mint/rotate response — the plaintext token, shown once, plus its metadata. */
export const DevTokenMintResponseSchema = z.object({
  token: z.string(),
  metadata: DevTokenMetadataSchema,
});
export type DevTokenMintResponse = z.infer<typeof DevTokenMintResponseSchema>;
