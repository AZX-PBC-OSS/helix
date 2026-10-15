import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

/** The one role/database provisioning definition, parametrized per database. */
const ROLES_SQL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.devcontainer/db-init/01-roles.sql",
);

/**
 * Apply the role/database ACL provisioning (`.devcontainer/db-init/01-roles.sql`)
 * with the TEST database names substituted: the platform runtime roles keep
 * their grants on `helix_test`, and the jobs plane gets `helix_jobs_test`.
 * The file is idempotent — on a cluster where db-init already ran (CI, fresh
 * dev volume) this is the same definition re-applied to different database
 * names; on an older dev volume it is the upgrade that brings the cluster to
 * the current ACL posture. Exported for the jobs-database isolation suite,
 * which re-applies provisioning over existing state as its upgrade leg.
 */
export function provisionTestDatabases(): void {
  execSync(
    `psql "${TEST_DATABASE_URL}" -v ON_ERROR_STOP=1 ` +
      `-v platform_db=helix_test -v jobs_db=helix_jobs_test ` +
      `-f "${ROLES_SQL}"`,
    { stdio: "inherit" },
  );
}
