// dsn.mjs — the DSN surgeries and the database-name pairing the local stack
// tooling shares. One home: stack-env moves a developer DSN's login or database
// name onto a stack's isolated database; ensure-db derives the migration
// identity's DSN from a runtime one and verifies a supplied jobs DSN names the
// stack's own jobs database. Both surgeries preserve everything they do not
// name — host, port, query — so a DSN's connect options survive the move.

/** Swap only the login in a DSN. Unparseable input returns undefined. */
export function withLogin(dsn, user, password) {
  try {
    const u = new URL(dsn);
    u.username = user;
    u.password = password;
    return u.toString();
  } catch {
    return undefined; // unparseable DSN: the caller's absence handling applies
  }
}

/** Swap only the database name in a DSN. Unparseable input returns undefined. */
export function withDatabase(dsn, name) {
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
 * The stack's jobs-database pairing: the platform database `helix` pairs with
 * `helix_jobs`, and an isolated stack's `helix_<suffix>` with
 * `helix_jobs_<suffix>` — the same relation scripts/stack-env.mjs mints DSNs
 * with and scripts/ensure-db.mjs verifies a supplied jobs DSN against. Null for
 * a name outside the convention: no pairing is derivable, and a caller that
 * cannot verify isolation must refuse rather than guess.
 */
export function jobsDatabaseName(platformName) {
  const pairing = platformName.match(/^helix(?<suffix>_[a-z0-9_]+)?$/);
  return pairing ? `helix_jobs${pairing.groups?.suffix ?? ""}` : null;
}

/**
 * Whether a database name IS a jobs-store name — the namespace the pairing
 * above maps stack names into (`helix_jobs` itself, or `helix_jobs_<suffix>`):
 * the dev stack's jobs store, or some resolved stack's. A stack's PLATFORM
 * database must never wear one — it would boot and migrate into a database the
 * jobs plane owns — so the resolver refuses such suffixes at the resolution
 * stage. The two predicates are the one convention's two faces: derive a jobs
 * name from a platform name; recognize a jobs name. Change them together.
 */
export function isJobsStoreName(databaseName) {
  return /^helix_jobs(_[a-z0-9_]+)?$/.test(databaseName);
}
