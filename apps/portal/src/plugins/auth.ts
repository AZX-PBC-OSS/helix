import type { FastifyRequest } from "fastify";
import { AppError } from "./errors.js";

/**
 * The authenticated principal behind a mutating request. M1 establishes this
 * from a static dev token; M3 swaps the *source* (OIDC device-code / Entra) for
 * the same shape, so audit attribution wiring downstream stays unchanged.
 */
export interface Actor {
  /** Authenticated subject (an email or principal id). */
  sub: string;
  /** How the actor was established — `dev-token` in M1. */
  via: string;
}

/**
 * Route `preHandler` that gates mutating endpoints behind a bearer token
 * (`Authorization: Bearer $PORTAL_DEV_TOKEN`) and attaches `request.actor`.
 * Reads stay open. This is a deliberate stub for the M3 auth boundary, not real
 * auth — there is no session, refresh, or per-app scoping yet.
 */
export async function authenticate(req: FastifyRequest): Promise<void> {
  const expected = process.env.PORTAL_DEV_TOKEN;
  if (!expected) {
    throw new AppError("internal", "PORTAL_DEV_TOKEN is not configured");
  }

  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token || token !== expected) {
    throw new AppError("unauthorized", "missing or invalid bearer token");
  }

  req.actor = { sub: process.env.PORTAL_DEV_ACTOR ?? "dev@azx.io", via: "dev-token" };
}

/** The actor on an authenticated request (set by {@link authenticate}). */
export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) {
    throw new AppError("unauthorized", "no authenticated actor");
  }
  return req.actor;
}
