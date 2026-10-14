import { z } from "zod";

import {
  JOB_TYPE_CATALOGUE,
  type JobTypeCatalogueEntry,
  JobServerIdSchema,
  isValidJobsRootSecret,
  QualifiedJobTypeSchema,
  RawInputKeyScreen,
  strictWireObject,
  strictWireRecord,
  qualifiedTypeMatchesServer,
} from "./jobs.js";

/**
 * The jobs deployment configuration (`JobsDeploymentConfig`) — the one
 * validated schema for the static server map and the finite operator limits,
 * for local and Azure wiring alike (background-jobs-plane design §§1, 4, 8;
 * ADR-0007: the exact environment serialization of the map is an
 * implementation detail, this schema owns keys and requiredness; ADR-0008:
 * each entry supplies its endpoint, installed types, state and three
 * directional secret references).
 *
 * The map is the whole routing truth: a configured server resolves only to
 * its own supplied endpoint — there is no discovery, no fallback destination
 * and no second source a consumer could consult. An **empty map is a fully
 * disabled installation**: no configured or retained servers, every jobs
 * operation refused, and no jobs credentials required anywhere in the
 * deployment. A `retiring` entry stays addressable for retained recovery,
 * reads, cancellation and cleanup while its records exist; it has closed
 * intake and is withdrawn from new-grant discovery. Intake (`accepting`) is
 * separately controllable on a serving entry — disabling an active
 * installation closes intake without touching the map.
 *
 * The roots are fields of each server's entry — never singleton shared
 * secrets — and the map refuses any root repeated across servers or
 * directions, holding the custody matrix (ADR-0002): a jobs service gets only
 * its own three roots and its own `databaseUrl`; the edge gets each
 * configured server's edge→jobs and jobs→edge roots; the portal gets only
 * portal→jobs roots. Loading the permitted subset is each consumer's job —
 * this schema defines the keys and requiredness, not the delivery.
 *
 * Public discovery data is the other side of that line and is derived, not
 * configured: {@link jobsCatalogueTypes} emits only qualified ids and display
 * names — never an endpoint, database URL or root.
 */

// ── Server state ─────────────────────────────────────────────────────────────

/**
 * The state of one configured server. There is no per-server "disabled":
 * removing the entry (producing an empty map, if it was the last) is what a
 * fully disabled installation is, and a retiring entry keeps its routes and
 * credentials until its records are gone (design §8).
 */
export const JOBS_SERVER_STATES = ["serving", "retiring"] as const;
export const JobsServerStateSchema = z.enum(JOBS_SERVER_STATES);
export type JobsServerState = z.infer<typeof JobsServerStateSchema>;

/** The signing directions a server entry holds roots for — the keys of the entry's `roots` field and of `JobsSigningDomains` in `./jobsSigning.ts`. */
export const JOBS_ROOT_DIRECTIONS = ["edgeToJobs", "jobsToEdge", "portalToJobs"] as const;

// ── Capacity defaults and operator limits (design §4) ────────────────────────

/**
 * The largest accepted limit value. The defaults never approach it (the
 * largest is 10,000 retained per server); the ceiling exists so an
 * "unbounded" setting is decidable at parse time — a finite number past this
 * ceiling does not bound anything and is refused like an infinite one.
 */
export const JOBS_CAPACITY_LIMIT_MAX = 1_000_000;

/**
 * A capacity control: a finite positive whole number under the ceiling.
 * Zero and negative settings are refused (a limit of zero is not a capacity),
 * and non-finite values never parse as integers — this is design §4's
 * "reject zero/negative/unbounded settings" as one schema.
 */
const JobsCapacityLimitSchema = z.int().positive().max(JOBS_CAPACITY_LIMIT_MAX);

/** The capacity-control field set, as design §4's table defines it. */
const CAPACITY_LIMIT_FIELDS = {
  /** Submission attempts per app/environment per fixed window — edge-enforced throttle. */
  submissionAttemptsPerAppEnv: JobsCapacityLimitSchema,
  /** Submission attempts across the deployment per fixed window — one aggregate across servers and environments, edge-enforced. */
  submissionAttemptsDeployment: JobsCapacityLimitSchema,
  /** The fixed submission-throttle window in seconds. */
  submissionWindowSeconds: JobsCapacityLimitSchema,
  /** Unfinished (nonterminal) jobs per app/environment, per server — checked with enqueue. */
  unfinishedPerAppEnv: JobsCapacityLimitSchema,
  /** Unfinished jobs per server, across types and overlapping replicas. */
  unfinishedPerServer: JobsCapacityLimitSchema,
  /** Retained (physically stored, active or terminal) jobs per app/environment, per server. */
  retainedPerAppEnv: JobsCapacityLimitSchema,
  /** Retained jobs per server. */
  retainedPerServer: JobsCapacityLimitSchema,
  /** Running jobs per app/environment in each worker process — pg-boss local limit across types. */
  runningPerAppEnv: JobsCapacityLimitSchema,
  /** Running jobs per worker process, across types. */
  runningPerWorker: JobsCapacityLimitSchema,
} as const;

const CapacityLimitsObject = z.strictObject(CAPACITY_LIMIT_FIELDS);

/** A resolved limit set — every control present. */
export const JobsCapacityLimitsSchema = RawInputKeyScreen.pipe(CapacityLimitsObject);
export type JobsCapacityLimits = z.infer<typeof JobsCapacityLimitsSchema>;

/**
 * An operator override of the platform defaults: every control optional, an
 * unknown control refused (a typo'd key would otherwise silently leave the
 * default in force while looking tuned). Built from the same raw object as
 * the complete schema so the two cannot drift.
 */
const CapacityOverridesObject = CapacityLimitsObject.partial();
export const JobsCapacityOverridesSchema = RawInputKeyScreen.pipe(CapacityOverridesObject);
export type JobsCapacityOverrides = z.infer<typeof JobsCapacityOverridesSchema>;

/**
 * The platform's initial capacity defaults — design §4's table, verbatim.
 * These are fairness and resource-protection controls, not entitlements:
 * manifests, inputs and approvals cannot change them, and operator overrides
 * may only tune them downward or upward within the finite ceiling. Frozen:
 * every consumer reaches this export and resolve reads it per call — one
 * stray write must not silently retune the platform's capacity posture.
 */
export const JOBS_CAPACITY_DEFAULTS: JobsCapacityLimits = Object.freeze({
  submissionAttemptsPerAppEnv: 10,
  submissionAttemptsDeployment: 100,
  submissionWindowSeconds: 60,
  unfinishedPerAppEnv: 20,
  unfinishedPerServer: 200,
  retainedPerAppEnv: 1_000,
  retainedPerServer: 10_000,
  runningPerAppEnv: 2,
  runningPerWorker: 8,
});

/**
 * Resolve the effective capacity limits: the platform defaults with any
 * operator overrides applied. Accepts `undefined` (no tuning) and the
 * `limits` field of a validated {@link JobsDeploymentConfig}; the merge is
 * re-checked against the complete schema, so a hand-built override carrying a
 * zero, a non-finite value or an unknown key throws instead of resolving.
 */
export function resolveJobsCapacityLimits(overrides?: JobsCapacityOverrides): JobsCapacityLimits {
  // An explicitly-undefined control means what an absent key means — the
  // setting was not made (the natural shape of an env loader passing an unset
  // variable through) — so it never clobbers its default in the merge.
  //
  // The walk is over the override's OWN property names, enumerable or not:
  // Object.entries sees enumerable keys only, so a non-enumerable control
  // would be shed there and its default would silently stay in force. Each
  // entry is DEFINED onto the merged copy rather than assigned: a plain write
  // of the key "__proto__" invokes the prototype setter, which installs
  // nothing a parse can refuse when the value is a primitive — defined, the
  // hostile key lands as an own key the raw-input screen refuses. The parse
  // below is the guard: a document that validated must resolve, and whatever
  // bypassed validation meets the complete schema here.
  const merged: Record<string, unknown> = { ...JOBS_CAPACITY_DEFAULTS };
  for (const control of Object.getOwnPropertyNames(overrides ?? {})) {
    const value = (overrides as Record<string, unknown>)[control];
    if (value !== undefined) {
      Object.defineProperty(merged, control, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return JobsCapacityLimitsSchema.parse(merged);
}

// ── One server entry ─────────────────────────────────────────────────────────

/**
 * The base URL of a private internal destination: scheme + host + optional
 * port and path prefix, reached only from inside the deployment. Absolute
 * http(s) — the deployed hops are HTTPS, local development uses the
 * established local transport. No credentials: a userinfo part is outside
 * this shape, and one pasted in would sit in a routing constant every
 * consumer logs, so it draws a boot-time refusal instead. No query string or
 * fragment either: these are bases the callers append internal routes to, and
 * a query there would be silently dropped by URL composition while looking
 * configured.
 */
const JobsInternalUrlSchema = z.url({ protocol: /^https?$/ }).refine(
  (url) => {
    const parsed = new URL(url);
    return (
      parsed.username === "" && parsed.password === "" && !url.includes("?") && !url.includes("#")
    );
  },
  {
    message:
      "an internal destination is scheme + host + optional port and path — no credentials, query string or fragment",
  },
);

/** The private database connection for exactly this server's store (its `JOBS_DATABASE_URL`). Postgres only. */
const JobsDatabaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/** One independently generated 32-byte root secret per direction, in its canonical base64 encoding (ADR-0002). */
const JobsRootSecretSchema = z.string().refine(isValidJobsRootSecret, {
  message: "a signing root must be the canonical base64 encoding of exactly 32 bytes",
});

/** The three directional signing roots of one server — fields of the entry, never shared (see the module docblock's custody matrix). */
const JobsServerRootsSchema = strictWireObject({
  edgeToJobs: JobsRootSecretSchema,
  jobsToEdge: JobsRootSecretSchema,
  portalToJobs: JobsRootSecretSchema,
});

/**
 * One configured server. Every field is required — a partial entry is a
 * boot-time configuration error, never a defaulted one — and the
 * superRefine holds the relationships a map may not violate: installed types
 * belong to this server and to the production catalogue, intake stays closed
 * on a retiring entry.
 */
export const JobsServerEntrySchema = strictWireObject({
  /** The configured server id — must equal the map key it is listed under. */
  server: JobServerIdSchema,
  /** The private internal endpoint the edge routes this server's operations to — the only destination this name resolves to. */
  endpoint: JobsInternalUrlSchema,
  state: JobsServerStateSchema,
  /** Whether new submissions are admitted (per-server `JOBS_ACCEPTING`); retained recovery, reads and cancellation continue either way. */
  accepting: z.boolean(),
  /** The installed local types, as qualified ids. Retiring entries keep their list — retained-key recovery still resolves it. */
  types: z.array(QualifiedJobTypeSchema),
  /** This server's private database — no other component receives it. */
  databaseUrl: JobsDatabaseUrlSchema,
  /** The edge callback base for `prod` jobs — selected by the job's signed tier, never by input. */
  edgeProdCallbackUrl: JobsInternalUrlSchema,
  /** The edge callback base for `dev` jobs; no fallback to the other destination when one is unavailable. */
  edgeDevCallbackUrl: JobsInternalUrlSchema,
  roots: JobsServerRootsSchema,
}).superRefine((entry, ctx) => {
  // zod runs checks against the partial output of an already-failing parse;
  // the comparisons here refine a structurally complete entry, and a partial
  // one is already rejected by the fields it is missing.
  if (
    typeof entry.server !== "string" ||
    !Array.isArray(entry.types) ||
    typeof entry.roots !== "object" ||
    entry.roots === null
  ) {
    return;
  }
  entry.types.forEach((type, index) => {
    if (!qualifiedTypeMatchesServer(type, entry.server)) {
      ctx.addIssue({
        code: "custom",
        path: ["types", index],
        message: "the installed type's server prefix must equal the entry's server",
      });
      return;
    }
    if (!JOB_TYPE_CATALOGUE.some((known) => known.id === type)) {
      ctx.addIssue({
        code: "custom",
        path: ["types", index],
        message:
          "the installed type must be a production catalogue type — configuration cannot install a type no platform code implements",
      });
    }
  });
  if (new Set(entry.types).size !== entry.types.length) {
    ctx.addIssue({
      code: "custom",
      path: ["types"],
      message: "the installed type list carries a duplicate",
    });
  }
  // The roots' custody is an entry-local property: one root per direction,
  // never shared — including within the entry the consumer that validates
  // one server's entry standalone (a jobs service loading its own three
  // roots) sees.
  const entryRoots = new Map<string, string>();
  for (const direction of JOBS_ROOT_DIRECTIONS) {
    const first = entryRoots.get(entry.roots[direction]);
    if (first === undefined) {
      entryRoots.set(entry.roots[direction], direction);
    } else {
      ctx.addIssue({
        code: "custom",
        path: ["roots", direction],
        message: `this root is the same secret as the ${first} root — each direction holds an independently generated root`,
      });
    }
  }
  if (entry.state === "retiring" && entry.accepting) {
    ctx.addIssue({
      code: "custom",
      path: ["accepting"],
      message: "a retiring server has closed intake — retirement never admits new work",
    });
  }
});
export type JobsServerEntry = z.infer<typeof JobsServerEntrySchema>;

// ── The deployment configuration document ────────────────────────────────────

/**
 * The whole deployment configuration: the static server map plus the optional
 * capacity override. Requiredness is the contract's other half — an empty
 * map is valid and carries no credentials (fully disabled), while every
 * present entry must be complete: no jobs credential is optional once any
 * server is configured.
 */
export const JobsDeploymentConfigSchema = RawInputKeyScreen.pipe(
  z.strictObject({
    /** The static server map, keyed by server id. */
    servers: strictWireRecord(JobServerIdSchema, JobsServerEntrySchema),
    /** Operator tuning of {@link JOBS_CAPACITY_DEFAULTS}; absent means the defaults apply unchanged. */
    limits: JobsCapacityOverridesSchema.optional(),
  }),
).superRefine((config, ctx) => {
  const seenRoots = new Map<string, string>();
  const seenDatabases = new Map<string, string>();
  for (const [serverId, entry] of Object.entries(config.servers)) {
    // As above: a partial entry is already rejected by its own fields; these
    // comparisons only refine a structurally complete one.
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.server !== "string" ||
      typeof entry.roots !== "object" ||
      entry.roots === null
    ) {
      continue;
    }
    if (entry.server !== serverId) {
      ctx.addIssue({
        code: "custom",
        path: ["servers", serverId, "server"],
        message: `the entry names server "${entry.server}" but is mapped under "${serverId}"`,
      });
    }
    for (const direction of JOBS_ROOT_DIRECTIONS) {
      const root = entry.roots[direction];
      const firstServer = seenRoots.get(root);
      if (firstServer === undefined) {
        seenRoots.set(root, serverId);
      } else if (firstServer !== serverId) {
        // Within-entry sharing is the entry schema's own refusal; this walk
        // holds the cross-server half of the custody matrix.
        ctx.addIssue({
          code: "custom",
          path: ["servers", serverId, "roots", direction],
          message: `this root is also ${firstServer}'s — each server holds an independently generated root`,
        });
      }
    }
    const firstDatabase = seenDatabases.get(entry.databaseUrl);
    if (firstDatabase === undefined) {
      seenDatabases.set(entry.databaseUrl, serverId);
    } else {
      ctx.addIssue({
        code: "custom",
        path: ["servers", serverId, "databaseUrl"],
        message: `this database is also ${firstDatabase}'s — each server keeps a private database and never shares its store`,
      });
    }
  }
});
export type JobsDeploymentConfig = z.infer<typeof JobsDeploymentConfigSchema>;

// ── Installation state and public discovery ──────────────────────────────────

/**
 * Is this installation fully disabled — no configured (or retained) servers?
 * Fully disabled jobs refuses every jobs operation, omits the catalogue
 * entirely, and makes ordinary app hosting depend on no jobs configuration
 * or credential (spec criterion 8; design §8).
 */
export function isJobsFullyDisabled(config: JobsDeploymentConfig): boolean {
  return Object.keys(config.servers).length === 0;
}

/**
 * The types the public capability catalogue advertises for this deployment:
 * the installed types of every serving entry, with the display names owned by
 * the production catalogue. Retiring types are withdrawn from discovery (their
 * saved grants survive), and a fully disabled installation advertises nothing
 * at all. The output is the entire public surface — qualified ids and display
 * names, never an endpoint, database URL or root.
 */
export function jobsCatalogueTypes(config: JobsDeploymentConfig): JobTypeCatalogueEntry[] {
  const advertised: JobTypeCatalogueEntry[] = [];
  for (const entry of Object.values(config.servers)) {
    if (entry.state !== "serving") continue;
    for (const typeId of entry.types) {
      const known = JOB_TYPE_CATALOGUE.find((catalogueEntry) => catalogueEntry.id === typeId);
      // Unreachable behind a schema-validated config: the parse refuses an
      // installed type outside the production catalogue. A hand-built config
      // that bypassed it fails loudly here instead of advertising a name with
      // no implementation.
      if (!known) {
        throw new Error(`the installed type ${typeId} is not in the production catalogue`);
      }
      advertised.push({ id: known.id, displayName: known.displayName });
    }
  }
  return advertised;
}
