import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import { passwordAppsAllowed, publicAppsAllowed } from "../policy/visibilityPolicy.js";
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
  publicConfig?: PublicAuthConfig | null;
}

export interface PublicAuthConfig {
  issuer: string;
  cliClientId: string;
  /** Public client the portal SPA uses for code+PKCE in the browser. */
  webClientId?: string;
  audience?: string;
  /** Deployment visibility policy, surfaced so the SPA can hide disallowed modes. */
  allowPublicApps?: boolean;
  allowPasswordApps?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    tokenVerifiers: TokenVerifier[];
    /** null = OIDC not configured (dev-token-only portal). */
    authPublicConfig: PublicAuthConfig | null;
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
        // Dev/CI: let the dev-token actor carry admin groups so scripts can
        // drive the approval loop. Comma-separated; defaults to none.
        (process.env.PORTAL_DEV_ACTOR_GROUPS ?? "")
          .split(",")
          .map((g) => g.trim())
          .filter(Boolean),
      ),
    );
  }
  return chain;
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app, opts) => {
    // Self-approve is a dev-only escape hatch (docs/design/approvals.md §4) —
    // it refuses to exist in production, same posture as PORTAL_DEV_TOKEN.
    if (process.env.PORTAL_ALLOW_SELF_APPROVE === "true" && process.env.NODE_ENV === "production") {
      throw new Error("PORTAL_ALLOW_SELF_APPROVE is a dev flag and is refused in production");
    }
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
              webClientId: process.env.AZX_WEB_CLIENT_ID ?? "azx-portal-web",
              ...(process.env.PORTAL_OIDC_AUDIENCE
                ? { audience: process.env.PORTAL_OIDC_AUDIENCE }
                : {}),
              allowPublicApps: publicAppsAllowed(),
              allowPasswordApps: passwordAppsAllowed(),
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

/**
 * Gate an approvals admin endpoint: the actor must carry the configured admin
 * group claim (docs/design/approvals.md §4). Rides the same `groups` mechanism
 * visibility uses; locally the dev-idp ships alice in `GROUP_PLATFORM_ADMINS`.
 */
export function requireAdmin(req: FastifyRequest): Actor {
  const actor = requireActor(req);
  if (process.env.PORTAL_ADMIN_GROUP_ID === undefined) {
    throw new AppError(
      "forbidden",
      "approvals are not configured: set PORTAL_ADMIN_GROUP_ID to the admin group id",
    );
  }
  if (!actorIsAdmin(actor)) {
    // Diagnostic: after the Entra swap the #1 confusing failure is an
    // authenticated user who simply isn't assigned the `platform-admin` app
    // role, so their token carries no matching `roles`/`groups` value. The
    // code already fails closed — this warn just makes "I can't see the admin
    // page" greppable (who, and what value we required) instead of silent.
    req.log.warn(
      { actor: actor.sub, via: actor.via, expected: process.env.PORTAL_ADMIN_GROUP_ID },
      "admin denied: authenticated principal lacks the configured admin role claim",
    );
    throw new AppError("forbidden", "this action requires the platform-admin role");
  }
  return actor;
}

/** Non-throwing admin check (queue visibility branches on it). */
export function actorIsAdmin(actor: Actor): boolean {
  const adminGroup = process.env.PORTAL_ADMIN_GROUP_ID;
  return adminGroup !== undefined && actor.groups.includes(adminGroup);
}

/**
 * Whether separation-of-duty may be waived so an admin can decide their own
 * request. Dev-only; the boot guard already refused the flag in production.
 */
export function canSelfApprove(): boolean {
  return process.env.PORTAL_ALLOW_SELF_APPROVE === "true";
}
