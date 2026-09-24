import { spawn } from "node:child_process";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Run Prisma migrations as the schema owner (helixadmin, ADR-0002).
 * The database is private, so this runs in the VNet through the Container Apps
 * job defined in infra/azure/modules/migrate-job.bicep.
 *
 * The job receives a vault URL, database hostname, and managed-identity client
 * id. Its identity reads the owner password from kv-platform at runtime, so
 * the deployment pipeline and ARM resources do not hold that credential.
 * The password is passed only in the Prisma child process environment, never
 * logged or written to disk.
 *
 * Use the portal's existing @azure/identity dependency for authentication and
 * one REST GET for the secret; no Key Vault SDK dependency is needed.
 *
 * Usage inside the job (values supplied by the template):
 *   AZURE_CLIENT_ID=<client id>
 *   PLATFORM_VAULT_URL=https://<kv-platform>.vault.azure.net/
 *   POSTGRES_HOST=<server>.postgres.database.azure.com
 *   POSTGRES_ADMIN_LOGIN=helixadmin
 *   pnpm --filter @azx-pbc/portal db:deploy:azure
 */

const VAULT_API_VERSION = "7.4";
const SECRET_NAME = "postgres-admin-password";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required — it is set by infra/azure/modules/migrate-job.bicep`);
  }
  return value;
}

/**
 * Read one secret from Key Vault over the data plane. Note the `.default` scope
 * on `https://vault.azure.net` — the resource, not the specific vault host.
 */
async function readVaultSecret(vaultUrl: string, name: string): Promise<string> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://vault.azure.net/.default");
  if (!token) {
    throw new Error(
      "failed to acquire a managed-identity token for Key Vault — is AZURE_CLIENT_ID the job's user-assigned identity?",
    );
  }

  // `new URL` normalises whether or not the vault URL carries a trailing slash.
  const url = new URL(`secrets/${name}`, vaultUrl.endsWith("/") ? vaultUrl : `${vaultUrl}/`);
  url.searchParams.set("api-version", VAULT_API_VERSION);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token.token}` },
  });
  if (!response.ok) {
    // Body may carry a useful Key Vault error code (e.g. Forbidden vs NotFound);
    // it does not contain the secret value on a failure path.
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Key Vault GET ${name} failed: ${response.status} ${response.statusText}. ${detail.slice(0, 400)}`,
    );
  }
  const body = (await response.json()) as { value?: string };
  if (!body.value) {
    throw new Error(`Key Vault secret ${name} exists but has no value`);
  }
  return body.value;
}

async function main(): Promise<void> {
  const vaultUrl = required("PLATFORM_VAULT_URL");
  const host = required("POSTGRES_HOST");
  const login = process.env.POSTGRES_ADMIN_LOGIN ?? "helixadmin";
  const database = process.env.POSTGRES_DATABASE ?? "helix";

  console.log(`reading ${SECRET_NAME} from ${vaultUrl}`);
  const password = await readVaultSecret(vaultUrl, SECRET_NAME);

  // Percent-encode both credential halves: the deploy recipe generates base64url
  // passwords precisely so they are DSN-safe, but an operator-set password is not
  // guaranteed to be, and a stray '@' or '/' would silently retarget the host.
  const dsn =
    `postgresql://${encodeURIComponent(login)}:${encodeURIComponent(password)}` +
    `@${host}:5432/${database}?sslmode=require`;

  console.log(`applying migrations to ${database} at ${host} as ${login}`);

  // Inherit stdio so Prisma's output is the job log verbatim, and exit with its
  // status so the job execution reflects the real result.
  const child = spawn("prisma", ["migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: dsn },
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) =>
      signal
        ? reject(new Error(`prisma migrate deploy killed by ${signal}`))
        : resolve(status ?? 1),
    );
  });

  if (code !== 0) {
    throw new Error(`prisma migrate deploy exited ${code}`);
  }
  console.log("migrations applied");
}

main().catch((error: unknown) => {
  // Deliberately the message only — an Error carrying the DSN in a stack frame
  // would put the password in the job log.
  console.error(`migrate-deploy failed: ${error instanceof Error ? error.message : String(error)}`);
  // `process.exitCode`, NOT `process.exit()`. When stdout/stderr is a pipe — which it
  // always is under a container log collector — Node's writes are asynchronous, and
  // `process.exit()` tears the process down before the buffer flushes. That silently
  // swallowed the only diagnostic this script produces: the first real failure in the
  // Franklin migrate job logged nothing but pnpm's "Exit status 1", and the cause had
  // to be found with a separate diagnostic job. Setting exitCode lets the event loop
  // drain and still exits non-zero.
  process.exitCode = 1;
});
