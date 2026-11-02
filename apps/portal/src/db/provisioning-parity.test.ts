import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The role/database ACL provisioning is one definition that exists twice —
 * dev/CI/test (`.devcontainer/db-init`) and prod (`infra/azure/sql`) — plus
 * the prod wrapper that feeds it its passwords (`infra/azure/scripts/
 * create-roles.sh`). Nothing executes these files together in a test run: the
 * prod pair only ever runs against Azure, so the cross-artifact contracts are
 * pinned here, statically.
 *
 * The contracts:
 *
 * - The dev and prod `01-roles.sql` state the same ACLs. A grant added to one
 *   side only silently splits the dev and prod security postures — the dev
 *   suite would go green over a boundary prod does not have (or vice versa).
 * - The dev and prod `02-portal-bootstrap-grants.sql` state the same portal
 *   bootstrap, modulo the object owner each database's `ALTER DEFAULT
 *   PRIVILEGES` is scoped to.
 * - Every psql password variable prod 01 references is passed by
 *   create-roles.sh, and every password the script passes is referenced. An
 *   unreferenced `-v` is dead; an unpassed reference expands to the empty
 *   string and provisions a role with no password.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Every migrations directory the static pins below scan — one entry per
 * prisma schema the platform ships. The scan-inventory test fails the moment
 * a migrations directory exists outside this list, so a new plane's
 * migrations cannot land unscanned.
 */
const MIGRATIONS_DIRS = ["apps/portal/prisma/migrations"].map((d) => path.join(REPO_ROOT, d));

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * The statement content of a SQL file: comments and blanks dropped, internal
 * whitespace collapsed. Comparison is order-insensitive — these are
 * idempotent statements whose relative order carries no meaning, so the
 * contracts below catch a statement present on one side only, not a benign
 * reordering.
 */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .sort();
}

/**
 * The one place dev 01 and prod 01 are allowed to differ: where the role's
 * password comes from (dev literal vs `:'…_password'` psql variable). Both
 * forms collapse to a placeholder so everything else must match.
 */
function normalizePasswordSource(sql: string): string[] {
  return statements(sql).map((line) =>
    line.replace(/^\('([a-z_]+)',\s*(?:'[^']*'|:'[a-z_]+')(\),?)$/, "('$1', :PW:$2"),
  );
}

/** Prod 02 scopes its defaults to the prod owner; dev, to the dev owner. */
function normalizeObjectOwner(sql: string): string[] {
  return statements(sql).map((line) =>
    line.replace(
      /^ALTER DEFAULT PRIVILEGES FOR ROLE [a-z_]+/,
      "ALTER DEFAULT PRIVILEGES FOR ROLE :OWNER:",
    ),
  );
}

describe("the dev and prod provisioning state the same ACLs", () => {
  it("01-roles.sql is statement-identical modulo the password source", () => {
    expect(normalizePasswordSource(read(".devcontainer/db-init/01-roles.sql"))).toEqual(
      normalizePasswordSource(read("infra/azure/sql/01-roles.sql")),
    );
  });

  it("02-portal-bootstrap-grants.sql is statement-identical modulo the object owner", () => {
    expect(
      normalizeObjectOwner(read(".devcontainer/db-init/02-portal-bootstrap-grants.sql")),
    ).toEqual(normalizeObjectOwner(read("infra/azure/sql/02-portal-bootstrap-grants.sql")));
  });
});

describe("create-roles.sh and prod 01-roles.sql agree on the password variables", () => {
  it("every referenced variable is passed, and every passed password is referenced", () => {
    const sqlVars = new Set(
      [...read("infra/azure/sql/01-roles.sql").matchAll(/:'([a-z_]+)'/g)].map((m) => m[1]!),
    );
    expect(sqlVars.size).toBeGreaterThan(0);

    // Only the executing lines count — the header comment repeats the same
    // -v list as documentation and must not mask drift in the real args.
    const script = read("infra/azure/scripts/create-roles.sh")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    const passedVars = new Set([...script.matchAll(/-v ([a-z_]+)=/g)].map((m) => m[1]!));

    // The SQL's password variables are the contract surface (its database-name
    // variables are deliberately NOT passed in prod — the defaults are the prod
    // names). The script's ON_ERROR_STOP is a psql setting, not a password.
    const sqlPasswords = [...sqlVars].filter((v) => v.endsWith("_password")).sort();
    const passedPasswords = [...passedVars].filter((v) => v.endsWith("_password")).sort();
    expect(sqlPasswords).toEqual(passedPasswords);

    // The filter above is only honest if every single-quoted variable ref IS
    // a password or a database name: passwords must be script-passed, and the
    // database names (which appear single-quoted in the create-database
    // statement, e.g. `quote_ident(:'jobs_db')`) are defined by the file's own
    // \if defaults and deliberately not passed in prod. A ref outside either
    // set would silently drop out of the contract.
    const guardedNames = [
      ...read("infra/azure/sql/01-roles.sql").matchAll(/\\set ([a-z_]+) /g),
    ].map((m) => m[1]!);
    const offConvention = [...sqlVars].filter(
      (v) => !v.endsWith("_password") && !guardedNames.includes(v),
    );
    expect(
      offConvention,
      "prod 01-roles.sql references a psql variable that is neither a *_password variable nor a \\set-guarded database name",
    ).toEqual([]);
  });

  it("every HELIX_* password the script requires is exported by both doc copies of the secrets block", () => {
    // This contract already broke once: the script's two jobs-password
    // requirements landed while getting-started.md — the published
    // fresh-install guide — still exported the admin plus four platform
    // passwords, and an operator following it died at step 4 with "missing
    // required environment". Both doc copies of the secrets block (the
    // README and the getting-started guide) must name exactly the set the
    // script requires: one unexported requirement is a broken install path;
    // an exported extra is a variable the script silently ignores.
    const script = read("infra/azure/scripts/create-roles.sh")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    const required = new Set([...script.matchAll(/HELIX_[A-Z_]*PASSWORD\b/g)].map((m) => m[0]));
    expect(required.size, "create-roles.sh requires no HELIX_* password").toBeGreaterThan(0);

    for (const [side, file] of [
      ["getting-started.md", "apps/docs/src/deploy/getting-started.md"],
      ["README.md", "infra/azure/README.md"],
    ] as const) {
      const exported = new Set(
        [...read(file).matchAll(/export (HELIX_[A-Z_]*PASSWORD\b)/g)].map((m) => m[1]!),
      );
      expect(exported.size, `${side}: no HELIX_* password exports found`).toBeGreaterThan(0);
      expect(
        exported,
        `${side} exports a HELIX_* password the script does not require, or misses one it does`,
      ).toEqual(required);
    }
  });
});

describe("the bicep topology declares only databases the prod provisioning defines", () => {
  /**
   * prod 01's `\set` defaults are the names its statements ACL-harden (create
   * if missing, PUBLIC CONNECT revoked, grants issued). A flexibleServers
   * databases resource named outside that set would come up with default
   * ACLs — PUBLIC CONNECT, no jobs grants — exactly the state the provisioning
   * exists to prevent, and nothing else would catch the mismatch.
   */
  it("every flexibleServers/databases resource name resolves to a name prod 01-roles.sql provisions", () => {
    const provisioned = new Set(
      [
        ...read("infra/azure/sql/01-roles.sql").matchAll(
          /\\set (?:platform_db|jobs_db) '([a-z_]+)'/g,
        ),
      ].map((m) => m[1]!),
    );
    expect(provisioned.size).toBeGreaterThan(0);

    const bicep = read("infra/azure/modules/postgres.bicep");
    const declared = databaseResourceNames(bicep, "infra/azure/modules/postgres.bicep");
    for (const name of declared) {
      expect(
        provisioned.has(name),
        `postgres.bicep declares database "${name}", which prod 01-roles.sql does not provision`,
      ).toBe(true);
    }
  });
});

/**
 * The names declared by `resource … 'Microsoft.DBforPostgreSQL/flexibleServers/
 * databases@…'` blocks in a module: a quoted literal is used as-is; a param
 * reference resolves against the param's default in the same file. Anything
 * else is a loud failure — a name this test cannot resolve is a name whose
 * agreement with the provisioning is unverified.
 */
function databaseResourceNames(bicep: string, sourceName: string): string[] {
  const lines = bicep.split("\n");
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (
      !/resource\s+\w+\s+'Microsoft\.DBforPostgreSQL\/flexibleServers\/databases@/.test(lines[i]!)
    ) {
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (/^}\s*$/.test(lines[j]!)) break;
      const nameLine = lines[j]!.match(/^\s*name:\s*(.+?)\s*$/);
      if (!nameLine) continue;
      const expr = nameLine[1]!;
      const literal = expr.match(/^'([^']+)'$/);
      const paramRef = literal ? null : expr.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
      if (literal) {
        names.push(literal[1]!);
        break;
      }
      if (paramRef) {
        const paramDefault = bicep.match(
          new RegExp(`param\\s+${paramRef[0]}\\s+string\\s*=\\s*'([^']+)'`),
        );
        if (paramDefault) {
          names.push(paramDefault[1]!);
          break;
        }
      }
      throw new Error(
        `cannot resolve the databases resource name \`${expr}\` in ${sourceName} — extend this test's parser`,
      );
    }
  }
  return names;
}

type CarveOut = Map<string, Set<string>>;

/**
 * Every `REVOKE … ON … FROM <role>` statement in a SQL file as table →
 * privilege set, for the roles the bootstrap files (re-)grant: helix_portal
 * is the only role the blanket and default privileges touch, so it is the
 * only role whose once-only migration revokes a bootstrap re-run can
 * resurrect. A role list naming helix_portal alongside other roles is still
 * a portal carve-out — the statement's privilege set applies to every listed
 * role, so the portal half is the whole list, and the re-run would resurrect
 * all of it. Revokes aimed at PUBLIC / helix_edge / helix_egress / helix_dev
 * (no portal in the list) are recognised and deliberately skipped — the
 * bootstrap grants them nothing. Any REVOKE that matches neither shape fails
 * loudly: a carve-out this extractor cannot see is a mirror obligation it
 * cannot enforce.
 */
function portalCarveOuts(sql: string, sourceName: string): CarveOut {
  const executing = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");

  const carveOuts: CarveOut = new Map();
  const tableRevoke =
    /REVOKE\s+((?:ALL|[A-Z]+)(?:\s*,\s*(?:ALL|[A-Z]+))*)\s+ON\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*;/g;
  // The bootstrap grants nothing to PUBLIC and nothing beyond helix_portal's
  // table DML, so revokes on other roles or on functions cannot be resurrected
  // by a re-run — recognised and skipped, but never silently.
  const otherRevoke = /REVOKE\s+[^;]+?\s+FROM\s+(?:PUBLIC|helix_edge|helix_egress|helix_dev)\s*;/gi;

  const covered = new Set<number>();
  for (const match of executing.matchAll(tableRevoke)) {
    covered.add(match.index!);
    const privileges = new Set(match[1]!.toUpperCase().split(/\s*,\s*/));
    const roles = match[3]!.toUpperCase().split(/\s*,\s*/);
    // A mixed list still revokes the full privilege set from helix_portal —
    // record it, or the portal half rides the blanket's next re-grant.
    if (!roles.includes("HELIX_PORTAL")) continue;
    for (const table of match[2]!.split(/\s*,\s*/)) {
      const held = carveOuts.get(table) ?? new Set<string>();
      for (const privilege of privileges) held.add(privilege);
      carveOuts.set(table, held);
    }
  }
  for (const match of executing.matchAll(otherRevoke)) {
    covered.add(match.index!);
  }

  // Every executing REVOKE must have been one of the shapes above; an
  // unconsumed one means the file grew a shape the mirror check cannot see.
  const occurrences = [...executing.matchAll(/\bREVOKE\b/gi)];
  const uncovered = occurrences.filter(({ index }) => index === undefined || !covered.has(index));
  if (uncovered.length > 0) {
    throw new Error(
      `${sourceName}: ${uncovered.length} REVOKE statement(s) do not match the known shapes — extend this test's parser`,
    );
  }
  return carveOuts;
}

/**
 * Every executing GRANT in a bootstrap file, as per-statement grantee sets —
 * the shapes the blanket-scope check recognises (the schema-wide blanket and
 * the two ALTER DEFAULT PRIVILEGES). A GRANT matching neither shape (a
 * `WITH GRANT OPTION` suffix, a new object class) throws: a widening the
 * parser cannot see is a skip-rule assumption it cannot police.
 */
function bootstrapGrants(sql: string, sourceName: string): Array<Set<string>> {
  const executing = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");

  const granteeSets: Array<Set<string>> = [];
  const covered = new Set<number>();
  const blanket =
    /GRANT\s+((?:ALL|[A-Z]+)(?:\s*,\s*(?:ALL|[A-Z]+))*)\s+ON\s+ALL\s+(?:TABLES|SEQUENCES)\s+IN\s+SCHEMA\s+public\s+TO\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*;/g;
  const defaults =
    /ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+[A-Za-z_][A-Za-z0-9_]*\s+GRANT\s+((?:ALL|[A-Z]+)(?:\s*,\s*(?:ALL|[A-Z]+))*)\s+ON\s+(?:TABLES|SEQUENCES)\s+TO\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*;/g;
  for (const match of executing.matchAll(blanket)) {
    granteeSets.push(new Set(match[2]!.toUpperCase().split(/\s*,\s*/)));
    covered.add(match.index!);
  }
  for (const match of executing.matchAll(defaults)) {
    granteeSets.push(new Set(match[2]!.toUpperCase().split(/\s*,\s*/)));
    covered.add(match.index! + match[0].indexOf("GRANT"));
  }

  const occurrences = [...executing.matchAll(/\bGRANT\b/gi)];
  const uncovered = occurrences.filter(({ index }) => index === undefined || !covered.has(index));
  if (uncovered.length > 0) {
    throw new Error(
      `${sourceName}: ${uncovered.length} GRANT statement(s) do not match the known shapes — extend this test's parser`,
    );
  }
  return granteeSets;
}

describe("the migrations' portal carve-outs are mirrored in both bootstrap files", () => {
  it("every REVOKE from helix_portal in a migration is re-asserted identically in dev and prod 02", () => {
    // The blanket is additive and migrations are once-only, while the
    // bootstrap re-run is the supported upgrade path — so a carve-out that
    // lives only in its migration is silently resurrected by the next
    // create-roles.sh invocation (the sessions resurrection this mirrors).
    // The scan covers every directory in MIGRATIONS_DIRS — the jobs plane's
    // migrations directory joins it when it lands (the scan-inventory test
    // fails the moment a migrations directory appears outside the list).
    const migrationCarveOuts: Array<{ migration: string; carveOuts: CarveOut }> =
      MIGRATIONS_DIRS.flatMap((migrationsDir) =>
        readdirSync(migrationsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const file = path.join(migrationsDir, entry.name, "migration.sql");
            return {
              migration: path.relative(REPO_ROOT, file),
              carveOuts: portalCarveOuts(readFileSync(file, "utf8"), file),
            };
          }),
      );

    const dev = portalCarveOuts(
      read(".devcontainer/db-init/02-portal-bootstrap-grants.sql"),
      "dev 02",
    );
    const prod = portalCarveOuts(read("infra/azure/sql/02-portal-bootstrap-grants.sql"), "prod 02");

    const found = migrationCarveOuts.filter(({ carveOuts }) => carveOuts.size > 0);
    expect(found.length, "expected at least one carve-out migration").toBeGreaterThan(0);
    for (const { migration, carveOuts } of found) {
      for (const [table, privileges] of carveOuts) {
        for (const [side, mirror] of [
          ["dev 02", dev],
          ["prod 02", prod],
        ] as const) {
          expect(
            mirror.get(table),
            `${migration} revokes ${[...privileges].sort().join(", ")} on ${table} from helix_portal, but ${side} does not re-assert it — the next bootstrap re-run resurrects it`,
          ).toEqual(privileges);
        }
      }
    }
  });

  it("the bootstrap blanket grants helix_portal alone", () => {
    // The mirror's skip rule is only sound while the blanket (and the default
    // privileges) re-grant to helix_portal alone: that is what makes another
    // role's revokes non-resurrectable. A grantee added to the blanket would
    // silently rot the assumption the extractor's skip is built on.
    for (const [side, file] of [
      ["dev 02", ".devcontainer/db-init/02-portal-bootstrap-grants.sql"],
      ["prod 02", "infra/azure/sql/02-portal-bootstrap-grants.sql"],
    ] as const) {
      const grantees = new Set(
        [
          ...read(file).matchAll(
            /\bTO\b\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*;/gi,
          ),
        ].flatMap((m) => m[1]!.toUpperCase().split(/\s*,\s*/)),
      );
      expect(grantees.size, `${side} grantee list`).toBeGreaterThan(0);
      expect(grantees, `${side} grants to a role other than helix_portal`).toEqual(
        new Set(["HELIX_PORTAL"]),
      );
    }
  });

  it("cannot be evaded by a GRANT shape the grantee check does not parse", () => {
    // The grantee pin above reads `TO … ;` lists from raw text: a grant whose
    // TO clause it cannot see — a `WITH GRANT OPTION` suffix, a new object
    // class — passes it vacuously while widening the re-run's grants, and the
    // extractor's skip rule rots with it (it holds only while the bootstrap
    // re-grants to helix_portal alone). Every executing GRANT must be a
    // recognised shape granting helix_portal alone.
    for (const [side, file] of [
      ["dev 02", ".devcontainer/db-init/02-portal-bootstrap-grants.sql"],
      ["prod 02", "infra/azure/sql/02-portal-bootstrap-grants.sql"],
    ] as const) {
      const grants = bootstrapGrants(read(file), side);
      expect(grants.length, `${side}: the shape check saw no grants`).toBeGreaterThan(0);
      for (const grantees of grants) {
        expect(grantees, `${side} grant shape widens beyond helix_portal`).toEqual(
          new Set(["HELIX_PORTAL"]),
        );
      }
    }
  });
});

describe("the carve-out extractor's own contract", () => {
  /**
   * The mirror above is only as fail-closed as `portalCarveOuts`. These pin
   * its two non-obvious behaviours directly, on synthetic statements — the
   * real files never contain these shapes (verified: every migration REVOKE
   * is single-role), which is exactly why the extractor must not guess.
   */
  it("records the portal half of a mixed-role revoke, and skips portal-free lists", () => {
    const mixed = portalCarveOuts(
      "REVOKE INSERT, UPDATE ON jobs_queue FROM helix_portal, helix_dev;",
      "synthetic",
    );
    expect(mixed.get("jobs_queue")).toEqual(new Set(["INSERT", "UPDATE"]));

    const portalFree = portalCarveOuts(
      "REVOKE INSERT ON other_table FROM helix_edge, helix_dev;",
      "synthetic",
    );
    expect(portalFree.size).toBe(0);
  });

  it("throws on a REVOKE shape it cannot parse (column-level grants are not table-level)", () => {
    expect(() =>
      portalCarveOuts("REVOKE SELECT (payload) ON ledger FROM helix_portal;", "synthetic"),
    ).toThrow(/extend this test's parser/);
  });
});

type SchemaLevelStatement = { privileges: Set<string>; kind: string; roles: Set<string> };

/**
 * Database- and schema-level GRANTs in a provisioning file — the surface 01's
 * re-run re-applies: CONNECT on the databases, USAGE/CREATE on the schemas.
 * The database name is matched loosely (`:"platform_db"`, `helix`, …) because
 * the kind, not the name, is what a re-run resurrects against.
 */
function schemaLevelGrants(sql: string, sourceName: string): SchemaLevelStatement[] {
  const executing = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  const shape =
    /GRANT\s+((?:ALL|CONNECT|USAGE|CREATE|TEMPORARY|TEMP)(?:\s*,\s*(?:ALL|CONNECT|USAGE|CREATE|TEMPORARY|TEMP))*)\s+ON\s+(DATABASE|SCHEMA)\s+(?::?"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+TO\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*;/gi;
  const statements: SchemaLevelStatement[] = [];
  const covered = new Set<number>();
  for (const match of executing.matchAll(shape)) {
    covered.add(match.index!);
    statements.push({
      privileges: new Set(match[1]!.toUpperCase().split(/\s*,\s*/)),
      kind: match[2]!.toUpperCase(),
      roles: new Set(match[3]!.toUpperCase().split(/\s*,\s*/)),
    });
  }
  const occurrences = [...executing.matchAll(/\bGRANT\b/gi)];
  const uncovered = occurrences.filter(({ index }) => index === undefined || !covered.has(index));
  if (uncovered.length > 0) {
    throw new Error(
      `${sourceName}: ${uncovered.length} GRANT statement(s) do not match the known schema-level shapes — extend this test's parser`,
    );
  }
  return statements;
}

/**
 * Database- and schema-level REVOKEs in a migration — the narrowing shape a
 * provisioning re-run can resurrect. Privilege `ALL` expands to the classes
 * 01 grants. Table- and function-level revokes are recognised and skipped:
 * 01 grants no table or function privileges, so only the 02 mirror (pinned
 * above) can resurrect those.
 */
function schemaLevelRevokes(sql: string, sourceName: string): SchemaLevelStatement[] {
  const executing = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  const schemaLevel =
    /REVOKE\s+((?:ALL|CONNECT|USAGE|CREATE|TEMPORARY|TEMP)(?:\s*,\s*(?:ALL|CONNECT|USAGE|CREATE|TEMPORARY|TEMP))*)\s+ON\s+(DATABASE|SCHEMA)\s+[^;]+?\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*;/gi;
  const statements: SchemaLevelStatement[] = [];
  const covered = new Set<number>();
  for (const match of executing.matchAll(schemaLevel)) {
    covered.add(match.index!);
    const privileges = new Set(
      match[1]!
        .toUpperCase()
        .split(/\s*,\s*/)
        .flatMap((p) => (p === "ALL" ? ["CONNECT", "USAGE", "CREATE", "TEMP"] : [p])),
    );
    statements.push({
      privileges,
      kind: match[2]!.toUpperCase(),
      roles: new Set(match[3]!.toUpperCase().split(/\s*,\s*/)),
    });
  }
  const tableLevel =
    /REVOKE\s+(?:[^;]+?)\s+ON\s+(?:TABLE\s+|FUNCTION\s+)?[^;]+?\s+FROM\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*\s*;/gi;
  for (const match of executing.matchAll(tableLevel)) covered.add(match.index!);
  const occurrences = [...executing.matchAll(/\bREVOKE\b/gi)];
  const uncovered = occurrences.filter(({ index }) => index === undefined || !covered.has(index));
  if (uncovered.length > 0) {
    throw new Error(
      `${sourceName}: ${uncovered.length} REVOKE statement(s) do not match the known shapes — extend this test's parser`,
    );
  }
  return statements;
}

describe("01's re-applied grant surface", () => {
  it("intersects no migration's database- or schema-level revoke", () => {
    // 01 re-applies CONNECT and schema USAGE/CREATE on every run — the same
    // additive semantics that resurrected the ledger carve-outs from 02. A
    // future migration that narrows a runtime role's connect or schema
    // surface would be silently reverted by the next re-run (initdb, CI, or
    // create-roles.sh) unless 01 mirrors the carve-out the way both 02 files
    // re-assert the table carve-outs. Fail-closed on both sides: a GRANT or
    // REVOKE shape the parsers cannot see throws instead of passing.
    // The scan covers every directory in MIGRATIONS_DIRS — the jobs plane's
    // migrations directory joins it when it lands (the scan-inventory test
    // fails the moment a migrations directory appears outside the list).
    const migrationRevokes: Array<{ migration: string; revokes: SchemaLevelStatement[] }> =
      MIGRATIONS_DIRS.flatMap((migrationsDir) =>
        readdirSync(migrationsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const file = path.join(migrationsDir, entry.name, "migration.sql");
            return {
              migration: path.relative(REPO_ROOT, file),
              revokes: schemaLevelRevokes(readFileSync(file, "utf8"), file),
            };
          }),
      );

    // The extractor must recognise the class it polices — a broken-and-empty
    // parser would pass vacuously.
    expect(
      schemaLevelRevokes("REVOKE USAGE ON SCHEMA public FROM helix_dev;", "synthetic"),
      "the extractor must recognise a schema-level revoke",
    ).toEqual([{ privileges: new Set(["USAGE"]), kind: "SCHEMA", roles: new Set(["HELIX_DEV"]) }]);

    for (const [side, file] of [
      ["dev 01", ".devcontainer/db-init/01-roles.sql"],
      ["prod 01", "infra/azure/sql/01-roles.sql"],
    ] as const) {
      const grants = schemaLevelGrants(read(file), side);
      expect(grants.length, `${side}: the shape check saw no grants`).toBeGreaterThan(0);
      for (const { migration, revokes } of migrationRevokes) {
        for (const revoke of revokes) {
          for (const grant of grants) {
            if (grant.kind !== revoke.kind) continue;
            const sharedPrivileges = [...revoke.privileges].filter((p) => grant.privileges.has(p));
            const sharedRoles = [...revoke.roles].filter((r) => grant.roles.has(r));
            expect(
              sharedPrivileges.length === 0 || sharedRoles.length === 0,
              `${migration} revokes ${sharedPrivileges.join(", ") || "privileges"} on ${revoke.kind.toLowerCase()} from ${sharedRoles.join(", ") || "roles"}, but ${side} re-grants it on every run — mirror the carve-out in 01 (the pattern both 02 files use) or stop re-granting it`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe("the static pins' scan inventory", () => {
  /**
   * Both scans above cover exactly the directories in MIGRATIONS_DIRS. The
   * pins' one blind spot is a migrations directory they have never heard of —
   * a plane whose migrations land elsewhere (the jobs plane's will) is
   * outside every carve-out and intersection pin until someone remembers to
   * extend the list. This walk makes forgetting loud: any directory holding
   * a `migration.sql` (the prisma convention, whatever the plane) that is
   * not in the list fails here, before its migrations can drift from the
   * provisioning unpoliced.
   */
  it("every migrations directory in the repo is covered by the scans", () => {
    const discovered = discoveredMigrationsDirs(REPO_ROOT, 0);
    expect(discovered.length, "the inventory walk found no migrations directory").toBeGreaterThan(
      0,
    );
    const scanned = new Set(MIGRATIONS_DIRS.map((d) => path.relative(REPO_ROOT, d)));
    for (const dir of discovered) {
      expect(
        scanned.has(dir),
        `"${dir}" contains migrations but no static pin scans it — add it to MIGRATIONS_DIRS and confirm both scans' extractors cover the new plane's statement shapes`,
      ).toBe(true);
    }
  });
});

/** Directories the inventory walk never descends into. */
const INVENTORY_SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
]);

/**
 * Every migrations directory under `dir` (prisma's shape: `migration_lock.toml`
 * beside per-migration subdirectories, each holding a `migration.sql`), as
 * repo-relative paths. A directory that holds migrations is returned whole —
 * its subdirectories are its migrations, not nested migrations directories.
 */
function discoveredMigrationsDirs(dir: string, depth: number): string[] {
  if (depth > 6) return [];
  const childDirs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !INVENTORY_SKIP.has(e.name))
    .map((e) => path.join(dir, e.name));
  const holdsMigrations =
    existsSync(path.join(dir, "migration_lock.toml")) ||
    childDirs.some((c) => existsSync(path.join(c, "migration.sql")));
  if (holdsMigrations) return [path.relative(REPO_ROOT, dir)];
  return childDirs.flatMap((c) => discoveredMigrationsDirs(c, depth + 1));
}
