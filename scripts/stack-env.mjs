#!/usr/bin/env node
// stack-env.mjs — resolve one complete, isolated local stack from a port offset.
//
// Why this exists: every local port was a bare literal in six `dev` scripts and
// in the run-helix smoke driver, so a second stack could not exist and starting
// one killed the first (see scripts/free-port.mjs, which the `dev` scripts run
// as a preflight). One offset knob, `HELIX_PORT_OFFSET`, moves the whole stack:
// ports, the derived public URLs, the dev-IdP redirect allowlist, the blob
// container, and the database name.
//
// Offset 0 is the developer's stack and resolves to an EMPTY env map — nothing
// is overridden, so `pnpm dev:*` behaves exactly as it always has. Any non-zero
// offset is a second stack that shares nothing but the TLS cert (which is
// port-agnostic) and the Postgres/Azurite servers themselves.
//
// Usage:
//   node scripts/stack-env.mjs --ports          # "8080 8081 8082 3001 3002 5173"
//   node scripts/stack-env.mjs --env            # KEY=value lines, for env $(...)
//   node scripts/stack-env.mjs --env --offset 1000
//
// Hand-rolled, no deps — matches the repo's dependency-minimal stance.

/** Base ports, i.e. the developer stack. Offsets are added to these. */
export const BASE_PORTS = {
  edge: 8080,
  egress: 8081,
  devGateway: 8082,
  portal: 3001,
  idp: 3002,
  web: 5173,
};

/** Chrome DevTools port the smoke driver's browser group binds (cdp.mjs). */
export const BASE_CDP_PORT = 9411;

const DEFAULT_BASE_DOMAIN = "local.helix.azxlabs.io";

/** Swap only the database name in a DSN, preserving role, host, port and query. */
function withDatabase(dsn, name) {
  if (!dsn) return undefined;
  try {
    const u = new URL(dsn);
    u.pathname = `/${name}`;
    return u.toString();
  } catch {
    return undefined; // unparseable DSN: leave the caller's value alone
  }
}

/**
 * Resolve a stack.
 *
 * @param {{ offset?: number, suffix?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {{ offset: number, suffix: string, ports: typeof BASE_PORTS,
 *             cdpPort: number, baseDomain: string, database: string|null,
 *             env: Record<string, string> }}
 */
export function resolveStack(opts = {}) {
  const env = opts.env ?? process.env;
  const offset = Number(opts.offset ?? env.HELIX_PORT_OFFSET ?? 0) || 0;
  const suffix = opts.suffix ?? env.HELIX_STACK_SUFFIX ?? "smoke";
  const baseDomain = (env.EDGE_BASE_DOMAIN || DEFAULT_BASE_DOMAIN).toLowerCase();

  const ports = Object.fromEntries(Object.entries(BASE_PORTS).map(([k, v]) => [k, v + offset]));
  const cdpPort = BASE_CDP_PORT + offset;

  // Offset 0 IS the developer stack: override nothing.
  if (offset === 0) {
    return { offset, suffix, ports, cdpPort, baseDomain, database: null, env: {} };
  }

  const database = `helix_${suffix}`;
  const portalOrigin = `http://localhost:${ports.portal}`;
  const out = {
    // Listen ports. The edge distinguishes its listen port from the port it
    // advertises in public URLs, so both are set (config.ts falls back through
    // EDGE_PUBLIC_PORT -> EDGE_PORT -> PORT).
    EDGE_PORT: String(ports.edge),
    EDGE_PUBLIC_PORT: String(ports.edge),
    EGRESS_PORT: String(ports.egress),
    EDGE_DEV_GATEWAY_PORT: String(ports.devGateway),
    PORTAL_PORT: String(ports.portal),
    IDP_PORT: String(ports.idp),
    PORTAL_WEB_PORT: String(ports.web),

    // Derived public URLs. APP_PUBLIC_BASE is what the control plane stamps
    // onto every app's `url`, so it must carry this stack's edge port.
    APP_PUBLIC_BASE: `https://${baseDomain}:${ports.edge}`,
    DEV_API_PUBLIC_BASE: `https://dev-api.${baseDomain}:${ports.devGateway}`,
    EDGE_EGRESS_URL: `http://localhost:${ports.egress}`,
    PORTAL_ORIGIN: portalOrigin,
    HELIX_PORTAL_URL: portalOrigin,

    // The dev IdP's redirect allowlist. Without these it registers the :8080 /
    // :5173 / :3001 literals in apps/dev-idp/src/provider.ts and every login on
    // this stack fails redirect_uri validation.
    IDP_EDGE_REDIRECT_URIS: [
      `https://auth.${baseDomain}:${ports.edge}/callback`,
      `http://auth.${baseDomain}:${ports.edge}/callback`,
    ].join(","),
    IDP_WEB_REDIRECT_URIS: [
      `http://localhost:${ports.web}/auth/callback`,
      `http://localhost:${ports.portal}/auth/callback`,
    ].join(","),

    // Storage isolation: own blob container, own database. Blob keys are
    // uuid-namespaced already, but the container keeps the two stacks' bundles
    // separable by eye.
    BLOB_CONTAINER: `app-bundles-${suffix}`,
  };

  // Each DSN keeps its own least-privilege role; only the database name moves.
  for (const key of [
    "DATABASE_URL",
    "PORTAL_DATABASE_URL",
    "EDGE_DATABASE_URL",
    "EDGE_DEV_DATABASE_URL",
    "EGRESS_DATABASE_URL",
  ]) {
    const moved = withDatabase(env[key], database);
    if (moved) out[key] = moved;
  }

  return { offset, suffix, ports, cdpPort, baseDomain, database, env: out };
}

// ── CLI ───────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const stack = resolveStack({
    ...(flag("--offset") !== undefined ? { offset: Number(flag("--offset")) } : {}),
    ...(flag("--suffix") !== undefined ? { suffix: flag("--suffix") } : {}),
  });

  if (argv.includes("--ports")) {
    console.log(Object.values(stack.ports).join(" "));
  } else if (argv.includes("--env")) {
    for (const [k, v] of Object.entries(stack.env)) console.log(`${k}=${v}`);
  } else {
    console.error("usage: node scripts/stack-env.mjs (--ports | --env) [--offset N] [--suffix S]");
    process.exit(2);
  }
}
