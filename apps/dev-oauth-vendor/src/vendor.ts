import { createHash, randomBytes } from "node:crypto";
import fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AuthorizeModeSchema,
  DEFAULT_API_TOKEN_HEADER,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
  TokenModeSchema,
  type VendorModes,
} from "./modes.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The token endpoint's call log (see {@link TokenEndpointCallSchema}). */
    tokenLog: TokenEndpointCall[];
  }
}

export const VendorOptionsSchema = z.object({
  tokenMode: TokenModeSchema.default("rotating"),
  authorizeMode: AuthorizeModeSchema.default("approve"),
  clientId: z.string().min(1).default(DEFAULT_CLIENT_ID),
  /** `null` means a public client: token requests authenticate by `client_id` in the form only. */
  clientSecret: z.string().min(1).nullable().default(DEFAULT_CLIENT_SECRET),
  /** Registered redirect URIs; empty accepts any (the fixture is controlled, not a reference server). */
  redirectUris: z.array(z.string().min(1)).default([]),
  apiTokenHeaderName: z.string().min(1).max(128).default(DEFAULT_API_TOKEN_HEADER),
  accessTokenTtlSeconds: z.number().int().positive().default(3600),
  grantCodeTtlSeconds: z.number().int().positive().default(600),
});
export type DevOAuthVendorOptions = z.input<typeof VendorOptionsSchema>;

/**
 * What the fake API destination reports about how the access token arrived.
 * The `placement` values mirror @azx-pbc/shared's `TokenPlacement` kinds, plus
 * `none` for a request that arrived without a recognizable token.
 */
export const ApiTokenReportSchema = z.object({
  placement: z.enum(["header-bearer", "header", "none"]),
  headerName: z.string().nullable(),
  token: z.string().nullable(),
  method: z.string(),
  path: z.string(),
});
export type ApiTokenReport = z.infer<typeof ApiTokenReportSchema>;

/**
 * One token-endpoint request, as the fixture's call log records it (I-02
 * T-0021's single-flight evidence): the grant type asked and whether a
 * refresh token was PRESENTED — counts and shapes only, never values, so the
 * log itself is not a credential store.
 */
export const TokenEndpointCallSchema = z.object({
  at: z.number(),
  grantType: z.string(),
  refreshPresented: z.boolean(),
});
export type TokenEndpointCall = z.infer<typeof TokenEndpointCallSchema>;

interface StoredGrant {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  expiresAt: number;
}

interface StoredRefresh {
  clientId: string;
  scope: string;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** RFC 6749 §2.3.1: Basic credentials are form-encoded inside the base64 pair. */
function basicClientCredentials(header: string): { id: string; secret: string } | undefined {
  if (!/^Basic /i.test(header)) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return undefined;
    return {
      id: decodeURIComponent(decoded.slice(0, sep)),
      secret: decodeURIComponent(decoded.slice(sep + 1)),
    };
  } catch {
    return undefined;
  }
}

/** Read the request's token header under the report's priority rule. */
function tokenHeader(
  req: FastifyRequest,
  namedHeader: string,
): { placement: "header-bearer" | "header"; headerName: string; token: string } | undefined {
  const authorization = req.headers.authorization;
  if (authorization !== undefined && /^bearer /i.test(authorization)) {
    return {
      placement: "header-bearer",
      headerName: "authorization",
      token: authorization.slice(7).trim(),
    };
  }
  const named = req.headers[namedHeader.toLowerCase()];
  const value = Array.isArray(named) ? named[0] : named;
  if (typeof value === "string" && value.length > 0) {
    return { placement: "header", headerName: namedHeader, token: value };
  }
  return undefined;
}

/**
 * Build the fixture vendor as a pure fastify app (no listen) — the repo's
 * `buildApp` pattern, so tests can also drive it with `app.inject` when real
 * HTTP is not the thing under test. `modes` is caller-owned per-instance
 * state, read at request time; `startDevOAuthVendor` owns the instance this
 * fixture actually serves.
 */
export function buildVendor(
  modes: VendorModes,
  options: DevOAuthVendorOptions = {},
): FastifyInstance {
  const opts = VendorOptionsSchema.parse(options ?? {});
  const grants = new Map<string, StoredGrant>();
  const refreshTokens = new Map<string, StoredRefresh>();
  // The call log (T-0021): appended at the top of the token endpoint, fault
  // modes included, so "the refresh token was presented exactly once" is
  // observable even when the presentation hung or was consumed-then-dropped.
  const tokenLog: TokenEndpointCall[] = [];

  const app = fastify({ logger: false });
  // Exposed for in-process consumers; `startDevOAuthVendor` surfaces it on the
  // running handle suites actually drive.
  app.decorate("tokenLog", tokenLog);

  // OAuth token requests are form-encoded; @fastify/formbody is deliberately
  // not a dependency (the fixture adds nothing the workspace does not already
  // use), so the parser is three lines of URLSearchParams.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      done(null, new URLSearchParams(text));
    },
  );

  app.get("/authorize", async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const redirectUri = query.redirect_uri;
    if (query.client_id !== opts.clientId) {
      return reply
        .code(400)
        .send({ error: "invalid_client", error_description: "unknown client_id" });
    }
    if (
      redirectUri === undefined ||
      (opts.redirectUris.length > 0 && !opts.redirectUris.includes(redirectUri))
    ) {
      // RFC 6749 §4.1.2.1: a redirect_uri that fails validation must NOT be
      // redirected to — the error goes to the caller as a bare 400.
      return reply
        .code(400)
        .send({ error: "invalid_request", error_description: "unregistered redirect_uri" });
    }
    const redirect = (params: Record<string, string>) => {
      const target = new URL(redirectUri);
      for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
      // RFC 6749 §4.1.2.1: state is echoed on error responses when sent.
      if (query.state !== undefined) target.searchParams.set("state", query.state);
      return reply.redirect(target.toString());
    };
    if (query.response_type !== "code") {
      return redirect({
        error: "unsupported_response_type",
        error_description: "only response_type=code",
      });
    }
    if (query.code_challenge === undefined || query.code_challenge_method !== "S256") {
      return redirect({
        error: "invalid_request",
        error_description: "code_challenge with S256 is required",
      });
    }
    if (modes.authorizeMode === "deny") {
      return redirect({
        error: "access_denied",
        error_description: "the fixture is set to deny this test's consent",
      });
    }
    const code = randomBytes(32).toString("base64url");
    grants.set(code, {
      clientId: opts.clientId,
      redirectUri,
      scope: query.scope ?? "",
      codeChallenge: query.code_challenge,
      expiresAt: Date.now() + opts.grantCodeTtlSeconds * 1000,
    });
    return redirect({ code, state: query.state ?? "" });
  });
  app.post("/token", async (req, reply) => {
    // RFC 6749 §5.1 applies to token responses of every shape.
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");

    const form = req.body as URLSearchParams;
    tokenLog.push({
      at: Date.now(),
      grantType: form.get("grant_type") ?? "",
      refreshPresented: form.get("refresh_token") !== null,
    });
    const basic =
      req.headers.authorization !== undefined
        ? basicClientCredentials(req.headers.authorization)
        : undefined;
    const presentedId = basic?.id ?? form.get("client_id");
    const presentedSecret = basic?.secret ?? form.get("client_secret") ?? null;
    const authenticated =
      presentedId === opts.clientId &&
      (opts.clientSecret === null || presentedSecret === opts.clientSecret);
    if (!authenticated) {
      return reply.code(401).send({
        error: "invalid_client",
        error_description: "client authentication failed",
      });
    }
    const clientId = opts.clientId;

    const issue = (scope: string, refreshToken?: string) => {
      const body: Record<string, unknown> = {
        access_token: randomBytes(32).toString("base64url"),
        token_type: "Bearer",
        expires_in: opts.accessTokenTtlSeconds,
      };
      if (scope !== "") body.scope = scope;
      if (refreshToken !== undefined) body.refresh_token = refreshToken;
      return body;
    };

    // Fault modes apply to valid client presentations; the error paths above
    // stay standard in every mode (the contract must survive wherever the
    // client validates it — ADR-0010).
    if (modes.tokenMode === "hang") {
      // Stall until the caller's side of the socket closes — a caller timeout
      // aborts the request, and shutdown destroys sockets, both of which end
      // the wait without ever answering while the client is listening.
      await new Promise<void>((resolve) => {
        if (req.raw.destroyed || req.raw.errored !== null) return resolve();
        req.raw.on("close", resolve);
      });
      if (req.raw.destroyed) return reply.hijack();
    }
    if (modes.tokenMode === "consumed-then-drop") {
      const code = form.get("code");
      if (code !== null) grants.delete(code);
      const refreshToken = form.get("refresh_token");
      if (refreshToken !== null) refreshTokens.delete(refreshToken);
      return reply.code(400).send({
        error: "invalid_grant",
        error_description: "the presented grant was consumed and its result dropped",
      });
    }

    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code");
      const grant = code !== null ? (grants.get(code) ?? undefined) : undefined;
      // Single-use, strictly: a failed redemption attempt burns the code too.
      if (code !== null) grants.delete(code);
      if (grant === undefined || grant.expiresAt < Date.now() || grant.clientId !== clientId) {
        return reply.code(400).send({
          error: "invalid_grant",
          error_description: "the authorization code is invalid, expired, or already used",
        });
      }
      if (form.get("redirect_uri") !== grant.redirectUri) {
        return reply
          .code(400)
          .send({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }
      const verifier = form.get("code_verifier");
      if (verifier === null || s256(verifier) !== grant.codeChallenge) {
        return reply
          .code(400)
          .send({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }
      const refreshToken = randomBytes(32).toString("base64url");
      refreshTokens.set(refreshToken, { clientId, scope: grant.scope });
      return reply.send(issue(grant.scope, refreshToken));
    }

    if (grantType === "refresh_token") {
      const presented = form.get("refresh_token");
      if (presented === null) {
        return reply
          .code(400)
          .send({ error: "invalid_request", error_description: "refresh_token is required" });
      }
      const record = refreshTokens.get(presented) ?? undefined;
      if (record === undefined || record.clientId !== clientId) {
        // RFC 6749 §10.5: deny and revoke on a client mismatch.
        refreshTokens.delete(presented);
        return reply
          .code(400)
          .send({ error: "invalid_grant", error_description: "invalid refresh token" });
      }
      if (modes.tokenMode === "non-rotating") {
        // No refresh_token in the response; the presented one stays valid.
        return reply.send(issue(record.scope));
      }
      refreshTokens.delete(presented);
      const replacement = randomBytes(32).toString("base64url");
      refreshTokens.set(replacement, { clientId, scope: record.scope });
      return reply.send(issue(record.scope, replacement));
    }

    return reply.code(400).send({
      error: "unsupported_grant_type",
      error_description: "supported grant types: authorization_code, refresh_token",
    });
  });

  // The fake API destination: every path the OAuth surface does not own is an
  // API destination, any method — the delegated-call path (manifest origin +
  // whatever path the app fetches) reports the token's arrival rather than
  // serving anything.
  app.setNotFoundHandler(async (req, reply) => {
    const token = tokenHeader(req, opts.apiTokenHeaderName);
    const shape = {
      method: req.method,
      path: req.url,
    };
    if (token === undefined) {
      return reply.code(401).send(
        ApiTokenReportSchema.parse({
          ...shape,
          placement: "none",
          headerName: null,
          token: null,
        }),
      );
    }
    return reply.send(ApiTokenReportSchema.parse({ ...shape, ...token }));
  });

  return app;
}
