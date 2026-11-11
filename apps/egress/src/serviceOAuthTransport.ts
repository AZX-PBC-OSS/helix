import { request, type Agent } from "undici";
import { z } from "zod";
import { type ServiceOAuthRecipe, type ServiceOAuthCredential } from "@azx-pbc/shared";

export class ServiceOAuthError extends Error {
  constructor(
    readonly outcome: "temporary_failure" | "needs_attention" | "not_authorized",
    readonly retryMs = 30_000,
    readonly allowFallback = true,
  ) {
    super(outcome);
    this.name = "ServiceOAuthError";
  }
}

const TokenResponse = z.object({
  access_token: z
    .string()
    .min(1)
    .max(32768)
    .regex(/^[A-Za-z0-9\-._~+/]+=*$/),
  token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
  expires_in: z.number().int().min(10).max(31_536_000),
  refresh_token: z.string().min(1).max(32768).optional(),
  scope: z.string().max(16384).optional(),
});
export interface IssuedServiceToken {
  access: string;
  refresh?: string;
  expiresAt: Date;
}
export type ServiceTokenExchange = (
  recipe: ServiceOAuthRecipe,
  credential: ServiceOAuthCredential,
  refresh: string | undefined,
  signal: AbortSignal,
) => Promise<IssuedServiceToken>;

/** A narrow form adapter supports password grants without inventing a client ID.
 * Every hop uses the proxy dispatcher; redirects and oversized bodies fail closed. */
export function serviceTokenExchange(dispatcher: Agent): ServiceTokenExchange {
  return async (recipe, credential, refresh, signal) => {
    const form = new URLSearchParams({ grant_type: refresh ? "refresh_token" : recipe.grantType });
    if (refresh) form.set("refresh_token", refresh);
    else if (recipe.grantType === "password") {
      form.set("username", credential.username!);
      form.set("password", credential.password!);
    }
    if (recipe.scopes.length) form.set("scope", recipe.scopes.join(" "));
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (recipe.clientAuthentication === "client_secret_basic") {
      const encode = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
      headers.authorization = `Basic ${Buffer.from(`${encode(credential.clientId!)}:${encode(credential.clientSecret!)}`).toString("base64")}`;
    } else {
      if (credential.clientId) form.set("client_id", credential.clientId);
      if (recipe.clientAuthentication === "client_secret_post")
        form.set("client_secret", credential.clientSecret!);
    }
    const started = Date.now();
    try {
      const response = await request(recipe.tokenEndpoint, {
        method: "POST",
        headers,
        body: form.toString(),
        dispatcher,
        signal,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });
      let raw: unknown;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 65_536) throw new ServiceOAuthError("needs_attention");
          chunks.push(Buffer.from(chunk));
        }
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          raw = undefined;
        }
      } finally {
        response.body.destroy();
      }
      if (response.statusCode === 429 || response.statusCode >= 500) {
        const retry = response.headers["retry-after"];
        const seconds = typeof retry === "string" ? Number(retry) : NaN;
        const time = typeof retry === "string" ? Date.parse(retry) - Date.now() : NaN;
        throw new ServiceOAuthError(
          "temporary_failure",
          Math.min(
            300_000,
            Math.max(
              30_000,
              Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(time) ? time : 0,
            ),
          ),
          false,
        );
      }
      if (response.statusCode !== 200) {
        const code = raw && typeof raw === "object" && "error" in raw ? raw.error : undefined;
        const rejected =
          response.statusCode === 401 ||
          [
            "invalid_grant",
            "invalid_client",
            "unauthorized_client",
            "unsupported_grant_type",
            "invalid_scope",
            "invalid_request",
          ].includes(String(code));
        throw new ServiceOAuthError(rejected ? "needs_attention" : "temporary_failure");
      }
      const parsed = TokenResponse.safeParse(raw);
      if (!parsed.success) throw new ServiceOAuthError("needs_attention");
      const token = parsed.data;
      if (
        token.scope !== undefined &&
        recipe.scopes.some((s) => !token.scope!.split(" ").includes(s))
      ) {
        throw new ServiceOAuthError("needs_attention");
      }
      const expiresAt = new Date(started + token.expires_in * 1000);
      if (expiresAt.getTime() <= Date.now() + 5_000) throw new ServiceOAuthError("needs_attention");
      return { access: token.access_token, refresh: token.refresh_token, expiresAt };
    } catch (error) {
      if (error instanceof ServiceOAuthError) throw error;
      throw new ServiceOAuthError("temporary_failure");
    }
  };
}
