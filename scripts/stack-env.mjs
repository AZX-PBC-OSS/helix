#!/usr/bin/env node
// Resolve an isolated local stack from HELIX_PORT_OFFSET: ports, public URLs,
// IdP redirects, Blob container, and database name. Offset 0 returns an empty
// env map, preserving the developer's settings. Other stacks share only the
// TLS certificate and the Postgres/Azurite server processes.
//
// The jobs plane (background-jobs design §8) resolves with the stack: its
// listen port, its private database DSNs, and each consumer's permitted subset
// of one local deployment map (the edge's forwarding document, the portal's
// delivery document + credential-free catalogue projection, and the jobs
// service's own env). The map is minted here so every consumer's configuration
// comes from one source and cannot disagree; each consumer's boot parse still
// refuses anything outside its custody. HELIX_JOBS_ENABLED=0|false resolves the
// stack fully disabled — no jobs key is emitted anywhere. HELIX_JOBS_STATE
// (serving|retiring) and HELIX_JOBS_ACCEPTING (1/true|0/false) set the server's
// state and intake; a retiring server always has closed intake.
// HELIX_JOBS_DIAGNOSTICS=1|true opts a non-production stack into the diagnostic
// job type; off by default.
//
// Usage:
//   node scripts/stack-env.mjs --ports
//   node scripts/stack-env.mjs --env
//   node scripts/stack-env.mjs --env --offset 1000

import { createHash } from "node:crypto";

import { isJobsStoreName, jobsDatabaseName, withDatabase, withLogin } from "./dsn.mjs";

/** Base ports, i.e. the developer stack. Offsets are added to these. */
export const BASE_PORTS = {
  edge: 8080,
  egress: 8081,
  devGateway: 8082,
  portal: 3001,
  idp: 3002,
  web: 5173,
  vendor: 3003,
  vendorTls: 3443,
  // The jobs service's documented dev port (AGENTS.md, apps/jobs). It shares
  // the number with `vendor`'s standalone default by pre-existing coincidence;
  // the vendor is not part of any stack composition, so no resolved stack
  // ever boots both.
  jobs: 3003,
};

/** Chrome DevTools port the smoke driver's browser group binds (cdp.mjs). */
export const BASE_CDP_PORT = 9411;

const DEFAULT_BASE_DOMAIN = "local.helix.azxlabs.io";

// ── the jobs plane ──────────────────────────────────────────────────────────

/** The one configured local jobs server (background-jobs design §1: only `jobs` ships). */
const JOBS_SERVER_ID = "jobs";
/** Its one installed production type. */
const JOBS_TYPE = "jobs:fetch";
/** The non-production diagnostic type, installed only on an opted-in stack. */
const JOBS_DIAGNOSTIC_TYPE = "jobs:diagnostic";

/**
 * A dev signing root: deterministic per stack suffix and direction, so
 * terminals that resolve the same stack independently mint agreeing roots
 * (random roots would make `env $(stack-env --env) pnpm dev:X` unusable on
 * the human path), while the three directions never share a secret — the
 * custody the consumers' own boot parses enforce. Dev-only well-known-derived
 * material, the same class as the compose file's literal dev secrets.
 */
function devJobsRoot(suffix, direction) {
  return createHash("sha256").update(`helix-dev-jobs-root:${suffix}:${direction}`).digest("base64");
}

/** HELIX_JOBS_ENABLED: unset/1/true ⇒ on; 0/false ⇒ off; anything else is a typo and fails loudly. */
function jobsEnabled(env) {
  const raw = env.HELIX_JOBS_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`HELIX_JOBS_ENABLED must be 1/true or 0/false — got ${JSON.stringify(raw)}`);
}

/**
 * HELIX_JOBS_DIAGNOSTICS: unset/blank/0/false ⇒ off (the default); 1/true ⇒
 * on. Validated even where it can emit nothing — a typo must refuse the
 * resolution, never read as "off".
 */
function jobsDiagnosticsEnabled(env) {
  const raw = env.HELIX_JOBS_DIAGNOSTICS;
  if (raw === undefined || raw.trim() === "") return false;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`HELIX_JOBS_DIAGNOSTICS must be 1/true or 0/false — got ${JSON.stringify(raw)}`);
}

/**
 * HELIX_JOBS_STATE and HELIX_JOBS_ACCEPTING: the server's state (unset ⇒
 * serving) and its intake (unset ⇒ open while serving, closed while
 * retiring). A retiring server never admits new work, so an explicit open
 * intake on one is refused rather than silently ignored; typos fail loudly.
 */
function jobsServerPosture(env) {
  const rawState = env.HELIX_JOBS_STATE;
  let state = "serving";
  if (rawState !== undefined && rawState.trim() !== "") {
    state = rawState.trim().toLowerCase();
    if (state !== "serving" && state !== "retiring") {
      throw new Error(
        `HELIX_JOBS_STATE must be serving or retiring — got ${JSON.stringify(rawState)}`,
      );
    }
  }
  const rawAccepting = env.HELIX_JOBS_ACCEPTING;
  let accepting = state === "serving";
  if (rawAccepting !== undefined && rawAccepting.trim() !== "") {
    const value = rawAccepting.trim().toLowerCase();
    if (value === "1" || value === "true") accepting = true;
    else if (value === "0" || value === "false") accepting = false;
    else {
      throw new Error(
        `HELIX_JOBS_ACCEPTING must be 1/true or 0/false — got ${JSON.stringify(rawAccepting)}`,
      );
    }
    if (accepting && state === "retiring") {
      throw new Error(
        "HELIX_JOBS_ACCEPTING cannot be true for a retiring server — retirement never admits new work",
      );
    }
  }
  return { state, accepting };
}

/**
 * Resolve the jobs plane for a non-zero-offset stack: the service's listen
 * port and private DSN, plus each consumer's permitted subset of one local
 * deployment map. The runtime DSN keeps the developer's own `JOBS_DATABASE_URL`
 * when they set one (only the database name moves, like every other DSN);
 * otherwise it is minted from the platform DSN's server under the dev-well-known
 * `helix_jobs` role. The migration identity's DSN is deliberately NOT emitted —
 * it never rides a runtime environment (background-jobs design §8); the stack
 * prep (`scripts/ensure-db.mjs`) derives it for the migration step alone.
 *
 * @returns {{ enabled: boolean, env: Record<string, string> }}
 */
function resolveJobsPlane({ offset, suffix, baseDomain, ports, env }) {
  // The diagnostics knob is validated even when it emits nothing (a disabled
  // jobs plane, a zero offset): the same loud-typo posture as jobsEnabled.
  const diagnostics = jobsDiagnosticsEnabled(env);
  if (offset === 0 || !jobsEnabled(env)) return { enabled: false, env: {} };
  const posture = jobsServerPosture(env);

  // Two DSN sources with two different degradations. The operator's explicit
  // `JOBS_DATABASE_URL` is a choice: set-but-unparseable refuses the resolution
  // naming the key — silently substituting the derived well-known DSN would
  // relocate the operator's private store without a signal (the jobsEnabled
  // typo's precedent). An unparseable platform DSN, the fallback source,
  // degrades to key-omission: the edge and portal documents stay complete
  // (neither carries a database URL) and the jobs service's own boot refuses
  // loudly naming JOBS_DATABASE_URL — the failure surfaces at the boundary
  // that owns it.
  // The stack's jobs database is the platform name's pairing (one derivation
  // with ensure-db's verification). A suffix outside the convention leaves the
  // pairing underivable — refusing here naming the suffix, never minting a
  // database name from a null (the unconstrained suffix was previously carried
  // through verbatim, so this is the earliest stage that can catch it).
  const jobsDatabase = jobsDatabaseName(`helix_${suffix}`);
  if (jobsDatabase === null) {
    throw new Error(
      `HELIX_STACK_SUFFIX=${JSON.stringify(suffix)} does not form a valid database name — ` +
        `the suffix must be lowercase letters, digits and underscores`,
    );
  }
  let runtimeDsn;
  if (env.JOBS_DATABASE_URL !== undefined && env.JOBS_DATABASE_URL.trim() !== "") {
    runtimeDsn = withDatabase(env.JOBS_DATABASE_URL, jobsDatabase);
    if (runtimeDsn === undefined) {
      throw new Error(
        `JOBS_DATABASE_URL is set but is not a parseable connection string — ` +
          `the operator's explicit store is never silently substituted`,
      );
    }
  } else if (env.DATABASE_URL) {
    runtimeDsn = withDatabase(
      withLogin(env.DATABASE_URL, "helix_jobs", "helix_jobs"),
      jobsDatabase,
    );
  }
  const endpoint = `http://localhost:${ports.jobs}`;
  const edgeProdCallbackUrl = `https://${baseDomain}:${ports.edge}`;
  const edgeDevCallbackUrl = `https://${baseDomain}:${ports.devGateway}`;
  const roots = {
    edgeToJobs: devJobsRoot(suffix, "edgeToJobs"),
    jobsToEdge: devJobsRoot(suffix, "jobsToEdge"),
    portalToJobs: devJobsRoot(suffix, "portalToJobs"),
  };

  return {
    enabled: true,
    env: {
      JOBS_PORT: String(ports.jobs),
      // The edge's (and the dev-gateway's) forwarding subset: the two roots
      // this process mints forwards with and verifies callbacks against —
      // never the portal root or the database URL.
      EDGE_JOBS_CONFIG: JSON.stringify({
        servers: {
          [JOBS_SERVER_ID]: {
            endpoint,
            edgeToJobsRoot: roots.edgeToJobs,
            jobsToEdgeRoot: roots.jobsToEdge,
          },
        },
      }),
      // The portal's lifecycle-delivery subset: its own root and the target —
      // never the edge roots or the database URL.
      PORTAL_JOBS_CONFIG: JSON.stringify({
        servers: { [JOBS_SERVER_ID]: { endpoint, portalToJobsRoot: roots.portalToJobs } },
      }),
      // The credential-free catalogue projection: state + installed types,
      // nothing else (the derivation `jobsCatalogueServers` owns in
      // @azx-pbc/shared; the contract test pins this document to it). The
      // edge and portal documents above do not change with the state: a
      // retiring server keeps its routing and its lifecycle delivery. The
      // diagnostic type rides only on the opted-in, non-production stack.
      PORTAL_JOBS_CATALOGUE: JSON.stringify({
        servers: {
          [JOBS_SERVER_ID]: {
            state: posture.state,
            types: diagnostics ? [JOBS_TYPE, JOBS_DIAGNOSTIC_TYPE] : [JOBS_TYPE],
          },
        },
      }),
      // The jobs service's own env: its identity, its private store, and its
      // three direction roots — the only place all three exist together.
      JOBS_SERVER_ID: JOBS_SERVER_ID,
      JOBS_ACCEPTING: String(posture.accepting),
      // Present only when the stack opted in: the jobs service's own knob,
      // refused outright by a production boot (config.ts).
      ...(diagnostics ? { JOBS_DIAGNOSTICS: "true" } : {}),
      ...(runtimeDsn ? { JOBS_DATABASE_URL: runtimeDsn } : {}),
      JOBS_EDGE_TO_JOBS_SECRET: roots.edgeToJobs,
      JOBS_PORTAL_TO_JOBS_SECRET: roots.portalToJobs,
      JOBS_JOBS_TO_EDGE_SECRET: roots.jobsToEdge,
      // The edge's fetch-callback bases, selected by the job's signed tier:
      // prod instructions go to the edge process, dev instructions to the
      // dev-gateway process. Each host classifies as a platform host, so the
      // callback routes answer there and on no app host.
      JOBS_EDGE_PROD_URL: edgeProdCallbackUrl,
      JOBS_EDGE_DEV_URL: edgeDevCallbackUrl,
    },
  };
}

/**
 * Resolve a stack.
 *
 * @param {{ offset?: number, suffix?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {{ offset: number, suffix: string, ports: typeof BASE_PORTS,
 *             cdpPort: number, baseDomain: string, database: string|null,
 *             jobs: { enabled: boolean, env: Record<string, string> },
 *             env: Record<string, string> }}
 */
export function resolveStack(opts = {}) {
  const env = opts.env ?? process.env;
  // A garbage offset ("abc", a NaN env var, a fraction) must refuse rather
  // than silently resolve the DEV stack: `Number(...) || 0` turned it into
  // offset 0, whose --ports output is the developer's own ports — and the
  // SKILL's documented stop line frees whatever that prints. Refusing is the
  // jobsEnabled typo's precedent, at the same stage. The raw value rides the
  // error (NaN is not JSON, so non-strings render via String). A blank-but-set
  // offset refuses for the same reason, and there is no safe blank fallback:
  // unset's own resolution is the dev stack, so the empty pointing would land
  // the operator on the one stack they meant to avoid.
  const rawOffset = opts.offset ?? env.HELIX_PORT_OFFSET ?? 0;
  if (typeof rawOffset === "string" && rawOffset.trim() === "") {
    throw new Error(
      `HELIX_PORT_OFFSET is set but blank — it must be a non-negative whole number of ports`,
    );
  }
  const offset = Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) {
    const shown = typeof rawOffset === "string" ? JSON.stringify(rawOffset) : String(rawOffset);
    throw new Error(
      `HELIX_PORT_OFFSET must be a non-negative whole number of ports — got ${shown}`,
    );
  }
  const suffix = opts.suffix ?? env.HELIX_STACK_SUFFIX ?? "smoke";
  const baseDomain = (env.EDGE_BASE_DOMAIN || DEFAULT_BASE_DOMAIN).toLowerCase();

  const ports = Object.fromEntries(Object.entries(BASE_PORTS).map(([k, v]) => [k, v + offset]));
  const cdpPort = BASE_CDP_PORT + offset;

  // Offset 0 IS the developer stack: override nothing. The developer's own
  // settings (their .env.local files) are the jobs configuration there.
  if (offset === 0) {
    return {
      offset,
      suffix,
      ports,
      cdpPort,
      baseDomain,
      database: null,
      jobs: { enabled: false, env: {} },
      env: {},
    };
  }

  const jobs = resolveJobsPlane({ offset, suffix, baseDomain, ports, env });
  const database = `helix_${suffix}`;
  // The platform database must not wear a jobs-store name: that namespace is
  // the jobs pairing's own (helix_jobs — the dev stack's store — and every
  // resolved stack's helix_jobs_<suffix>), and a platform database inside it
  // would have this stack boot and migrate into a database the jobs plane
  // owns, exiting 0 — the isolation the suffix exists to provide, broken by an
  // accepted input. The damage is the platform DSNs', so the check holds
  // whatever the jobs plane's enablement.
  if (isJobsStoreName(database)) {
    throw new Error(
      `HELIX_STACK_SUFFIX=${JSON.stringify(suffix)} would make this stack's platform database ` +
        `"${database}" a jobs-store name (helix_jobs, helix_jobs_<suffix>) — the stack would ` +
        `boot and migrate into a database the jobs plane owns; pick another suffix`,
    );
  }
  const portalOrigin = `http://localhost:${ports.portal}`;
  const out = {
    // The stack env is authoritative for a resolved stack: every service's
    // composition root skips its developer-local override file (.env.local)
    // when this is set, so a second stack cannot boot cross-wired into the
    // developer's own credentials (the isolation the offset exists to
    // provide). The developer's files remain sovereign on the dev stack
    // (offset 0, which emits nothing).
    HELIX_STACK_ENV: "1",

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
    OAUTH_VENDOR_PORT: String(ports.vendor),
    OAUTH_VENDOR_TLS_PORT: String(ports.vendorTls),

    // Derived public URLs. APP_PUBLIC_BASE is what the control plane stamps
    // onto every app's `url`, so it must carry this stack's edge port.
    APP_PUBLIC_BASE: `https://${baseDomain}:${ports.edge}`,
    DEV_API_PUBLIC_BASE: `https://dev-api.${baseDomain}:${ports.devGateway}`,
    EDGE_EGRESS_URL: `http://localhost:${ports.egress}`,
    PORTAL_ORIGIN: portalOrigin,
    HELIX_PORTAL_URL: portalOrigin,

    // The services' half of the IdP wire. The redirect-URI half is minted
    // below (IDP_*_REDIRECT_URIS, the offset IdP's allowlist) — without this
    // half the offset edge and portal inherit the compose values
    // (http://localhost:3002, the DEV stack's IdP): interactive login could
    // never complete on an offset stack, and the smoke could not see it (its
    // paths drive the IdP directly and inject the portal token). Each stack's
    // IdP is its own; none is shared.
    EDGE_OIDC_ISSUER: `http://localhost:${ports.idp}`,
    PORTAL_OIDC_ISSUER: `http://localhost:${ports.idp}`,

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
  // The jobs plane's env joins the stack's: each consumer reads only its own
  // keys, and `--env` is the one source every terminal shares.
  Object.assign(out, jobs.env);

  return { offset, suffix, ports, cdpPort, baseDomain, database, jobs, env: out };
}

// ── CLI ───────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  // A valueless flag must refuse, not silently take its default: a trailing
  // `--offset` would resolve the DEV stack and the SKILL's stop line would
  // free the developer's own ports; a trailing `--suffix` would resolve onto
  // the smoke stack's database.
  for (const name of ["--offset", "--suffix"]) {
    if (argv.includes(name) && flag(name) === undefined) {
      console.error(`${name} requires a value`);
      process.exit(2);
    }
  }
  const stack = resolveStack({
    // The raw strings: the resolution owns the parse (and the refusal naming
    // the value) — parsing here would double it and misquote NaN.
    ...(flag("--offset") !== undefined ? { offset: flag("--offset") } : {}),
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
