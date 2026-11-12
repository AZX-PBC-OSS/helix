import { z } from "zod";

export const SERVICE_ACCOUNT_WARNING =
  "Requests through this connection use the configured service account's permissions. " +
  "The external API does not apply each app user's individual permissions. " +
  "Only connect accounts whose access is appropriate for everyone allowed to use this connection.";

/** No query credentials, fragments, userinfo, or redirects at the token recipient. */
export const ServiceOAuthRecipeSchema = z
  .strictObject({
    kind: z.literal("oauth-service-account"),
    tokenEndpoint: z
      .url()
      .max(2048)
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search;
      }, "token endpoint must be HTTPS without credentials, query, or fragment"),
    grantType: z.enum(["client_credentials", "password"]),
    clientAuthentication: z.enum(["client_secret_basic", "client_secret_post", "none"]),
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
      )
      .max(64)
      .default([]),
    /** Exact paths of read-only POST operations the owner asserts are safe to replay. */
    replaySafePostPaths: z
      .array(
        z
          .string()
          .max(1024)
          .regex(/^\/[^?#]*$/),
      )
      .max(32)
      .default([]),
  })
  .refine((r) => r.grantType !== "client_credentials" || r.clientAuthentication !== "none", {
    message: "client credentials requires client authentication",
  });
export type ServiceOAuthRecipe = z.infer<typeof ServiceOAuthRecipeSchema>;

export const ServiceOAuthCredentialSchema = z.strictObject({
  kind: z.literal("oauth-service-account"),
  clientId: z.string().min(1).max(4096).optional(),
  clientSecret: z.string().min(1).max(16384).optional(),
  username: z.string().min(1).max(4096).optional(),
  password: z.string().min(1).max(16384).optional(),
});
export type ServiceOAuthCredential = z.infer<typeof ServiceOAuthCredentialSchema>;

export function parseServiceOAuthCredential(
  recipe: ServiceOAuthRecipe,
  value: string,
): ServiceOAuthCredential {
  try {
    const c = ServiceOAuthCredentialSchema.parse(JSON.parse(value));
    if (recipe.clientAuthentication !== "none" && (!c.clientId || !c.clientSecret))
      throw new Error();
    if (recipe.clientAuthentication === "none" && c.clientSecret) throw new Error();
    if (recipe.grantType === "password" && (!c.username || !c.password)) throw new Error();
    if (recipe.grantType !== "password" && (c.username || c.password)) throw new Error();
    return c;
  } catch {
    throw new Error("service-account credential does not match its configuration");
  }
}

export const ServiceOAuthStatusSchema = z.object({
  status: z.enum(["ready", "unconfigured", "recovering", "temporary_failure", "needs_attention"]),
  expiresAt: z.string().nullable(),
  retryAfter: z.string().nullable(),
});
