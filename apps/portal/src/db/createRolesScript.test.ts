import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * create-roles.sh builds a Container Apps job whose container runs every
 * sql/*.sql file through psql inside one `sh -c` string. Nothing runs that
 * job in a test (it needs Azure), so this test renders the job body with the
 * script's own python snippet and runs the container command locally against
 * a stub psql. That exercises the JSON and shell quoting as well as the loop.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = readFileSync(path.join(REPO_ROOT, "infra/azure/scripts/create-roles.sh"), "utf8");

function containerCommand(): string {
  const snippet = SCRIPT.match(/python3 -c '\n([\s\S]*?)\n'\n/);
  expect(snippet, "create-roles.sh must render the job body with python3 -c").not.toBeNull();
  const env = {
    PATH: process.env.PATH ?? "",
    LOCATION: "eastus2",
    ENV_ID: "env-id",
    ADMIN_URL: "postgresql://admin:pw@db:5432/helix",
    EDGE_PW: "e",
    PORTAL_PW: "p",
    EGRESS_PW: "g",
    DEV_PW: "d",
    JOBS_PW: "j",
    JOBS_MIGRATE_PW: "m",
    ROLES_SQL_TAR_B64: "",
  };
  const res = spawnSync("python3", ["-I", "-c", snippet![1]!], { env, encoding: "utf8" });
  expect(res.status, res.stderr).toBe(0);
  const body = JSON.parse(res.stdout) as {
    properties: { template: { containers: Array<{ command: string[]; args: string[] }> } };
  };
  const container = body.properties.template.containers[0]!;
  expect(container.command).toEqual(["/bin/sh", "-c"]);
  expect(container.args).toHaveLength(1);
  return container.args[0]!;
}

let work: string | undefined;
afterEach(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
  work = undefined;
});

/** Runs the container command with the SQL files given and a psql that fails on `failOn`. */
function runRoles(files: string[], failOn: string | undefined) {
  work = mkdtempSync(path.join(tmpdir(), "create-roles-"));
  const sqlSrc = path.join(work, "src");
  const sqlDst = path.join(work, "sql");
  const bin = path.join(work, "bin");
  const log = path.join(work, "psql.log");
  for (const dir of [sqlSrc, bin]) mkdirSync(dir);
  for (const f of files) writeFileSync(path.join(sqlSrc, f), "select 1;\n");
  writeFileSync(
    path.join(bin, "psql"),
    [
      "#!/bin/sh",
      'for a in "$@"; do f="$a"; done',
      `echo "$(basename "$f")" >> "${log}"`,
      `[ "$(basename "$f")" = "${failOn ?? ""}" ] && exit 3`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path.join(bin, "psql"), 0o755);
  const tar = spawnSync("tar", ["-C", sqlSrc, "-cf", "-", "."]);
  const command = containerCommand().replaceAll("/tmp/sql", sqlDst);
  const res = spawnSync("/bin/sh", ["-c", command], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ROLES_SQL_TAR_B64: tar.stdout.toString("base64"),
      ADMIN_URL: "postgresql://admin:pw@db:5432/helix",
    },
    encoding: "utf8",
  });
  const ran = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: res.status, ran };
}

describe("create-roles.sh job command", () => {
  it("applies every SQL file in order when each succeeds", () => {
    const { status, ran } = runRoles(["01-roles.sql", "02-portal-bootstrap-grants.sql"], undefined);
    expect(status).toBe(0);
    expect(ran).toEqual(["01-roles.sql", "02-portal-bootstrap-grants.sql"]);
  });

  it("stops at the first failing file and exits non-zero, even when a later file would succeed", () => {
    const { status, ran } = runRoles(
      ["01-roles.sql", "02-portal-bootstrap-grants.sql"],
      "01-roles.sql",
    );
    expect(status).not.toBe(0);
    expect(ran).toEqual(["01-roles.sql"]);
  });
});
