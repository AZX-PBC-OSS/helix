import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import {
  createDevTokenVerifier,
  createOidcVerifier,
  type Actor,
  type TokenVerifier,
} from "../auth/verifier.js";

export type { Actor, TokenVerifier } from "../auth/verifier.js";

/**
 * Portal auth (M3): bearer tokens through a verifier chain — OIDC JWTs
 * (the real path; the CLI gets them via device flow) first, then the demoted
 * M1 dev token (CI/scripts; refused in production). `authenticate` and
 * `requireActor` keep their M1 signatures, so routes and audit attribution
 * are untouched.
 *
 * Authorization model (v0): any authenticated portal-audience principal may
 * mutate — the same trust level as the M1 shared token, now attributed.
 * Per-app RBAC is a v1 portal feature.
 */

export interface AuthPluginOptions {
  /** Inject a verifier chain (tests). Defaults are built from the env. */
  verifiers?: TokenVerifier[];
  /** Public IdP discovery info served at /api/v1/auth/config. */
  publicConfig?: { issuer: string; cliClientId: string; audience?: string } | null;
}

declare module "fastify" {
  interface FastifyInstance {
    tokenVerifiers: TokenVerifier[];
    /** null = OIDC not configured (dev-token-only portal). */
    authPublicConfig: { issuer: string; cliClientId: string; audience?: string } | null;
  }
}

function verifiersFromEnv(): TokenVerifier[] {
  const chain: TokenVerifier[] = [];
  const issuer = process.env.PORTAL_OIDC_ISSUER;
  const audience = process.env.PORTAL_OIDC_AUDIENCE;
  if (issuer && audience) {
    chain.push(
      createOidcVerifier({
        issuer: issuer.replace(/\/+$/, ""),
        audience,
        // The verifier requires https unless this is set; it refuses the
        // flag in production. Dev needs it: the local IdP is plain http.
        allowInsecure: process.env.PORTAL_OIDC_ALLOW_INSECURE === "true",
      }),
    );
  } else if (issuer || audience) {
    throw new Error("PORTAL_OIDC_ISSUER and PORTAL_OIDC_AUDIENCE must be set together");
  }
  if (process.env.PORTAL_DEV_TOKEN) {
    chain.push(
      createDevTokenVerifier(
        process.env.PORTAL_DEV_TOKEN,
        process.env.PORTAL_DEV_ACTOR ?? "dev@azx.io",
      ),
    );
  }
  return chain;
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app, opts) => {
    const verifiers = opts.verifiers ?? verifiersFromEnv();
    if (verifiers.length === 0) {
      throw new Error(
        "No auth verifier configured: set PORTAL_OIDC_ISSUER + PORTAL_OIDC_AUDIENCE " +
          "(and/or PORTAL_DEV_TOKEN outside production)",
      );
    }
    const issuer = process.env.PORTAL_OIDC_ISSUER;
    app.decorate("tokenVerifiers", verifiers);
    app.decorate(
      "authPublicConfig",
      opts.publicConfig !== undefined
        ? opts.publicConfig
        : issuer
          ? {
              issuer: issuer.replace(/\/+$/, ""),
              cliClientId: process.env.AZX_CLI_CLIENT_ID ?? "azx-cli",
              ...(process.env.PORTAL_OIDC_AUDIENCE
                ? { audience: process.env.PORTAL_OIDC_AUDIENCE }
                : {}),
            }
          : null,
    );
  },
  { name: "auth" },
);

/**
 * Route `preHandler` gating mutating endpoints: extracts the bearer token,
 * walks the verifier chain, attaches `request.actor`. Reads stay open (v0).
 */
export async function authenticate(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    throw new AppError("unauthorized", "missing bearer token");
  }
  for (const verifier of req.server.tokenVerifiers) {
    const actor = await verifier.verify(token);
    if (actor) {
      req.actor = actor;
      return;
    }
  }
  throw new AppError("unauthorized", "invalid bearer token");
}

/** The actor on an authenticated request (set by {@link authenticate}). */
export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) {
    throw new AppError("unauthorized", "no authenticated actor");
  }
  return req.actor;
}
