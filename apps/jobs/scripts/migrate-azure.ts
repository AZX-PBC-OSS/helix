import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { managedIdentityTokenProviderFromEnv } from "@azx-pbc/secret-store";

/**
 * The Azure migration entry point — what
 * infra/azure/modules/jobs-migrate-job.bicep runs. The jobs store is
 * private-endpoint-only, so its migrations run as a Container Apps Job in the
 * apps environment (inside the VNet) instead of from a pipeline or a laptop.
 *
 * The job receives a vault URL and a managed-identity client id; its identity
 * reads the migration identity's DSN (`helix_jobs_migrate`) from kv-platform
 * at run time, so neither the deployment pipeline nor the job definition ever
 * holds that credential. The DSN is passed only to the migration child
 * process's environment — never logged, never written to disk.
 *
 * Unlike the portal's migrate-deploy.ts, this script does not use
 * @azure/identity: the jobs image keeps a minimal dependency closure, so it
 * authenticates through the Container Apps managed-identity endpoint via the
 * secret-store's provider — the same seam egress uses.
 *
 * Usage inside the job (values supplied by the template):
 *   AZURE_CLIENT_ID=<the job identity's client id>
 *   PLATFORM_VAULT_URL=https://<kv-platform>.vault.azure.net/
 *   node --import tsx scripts/migrate-azure.ts
 */

const VAULT_API_VERSION = "7.4";
/** The kv-platform secret holding the migration identity's DSN (kv-secrets.bicep). */
const SECRET_NAME = "jobs-migrate-database-url";
const SECRET_READ_TIMEOUT_MS = 30_000;

/** Options for {@link readMigrateDsn} — the bounded-wait configuration. */
export interface ReadMigrateDsnOptions {
  /** The vault secret GET's bound, in ms. Defaults to the job's 30 s. */
  secretReadTimeoutMs?: number;
}

/**
 * The package's own migration command (`db:migrate`) without its leading
 * `node` — `process.execPath` supplies that, so the child runs the exact
 * command the `db:migrate` script names.
 */
const MIGRATE_COMMAND = ["--import", "tsx", "src/migrate.ts"] as const;

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is required — it is set by infra/azure/modules/jobs-migrate-job.bicep`,
    );
  }
  return value;
}

/**
 * Read one secret from Key Vault over the data plane. The token is for the
 * vault-wide resource `https://vault.azure.net`, not the specific vault host.
 * The failure body may carry a useful Key Vault error code
 * (Forbidden vs NotFound); it never contains the secret value.
 */
async function readVaultSecret(
  vaultUrl: string,
  name: string,
  getToken: () => Promise<string>,
  timeoutMs: number,
): Promise<string> {
  const token = await getToken();

  // `new URL` normalises whether or not the vault URL carries a trailing slash.
  const url = new URL(`secrets/${name}`, vaultUrl.endsWith("/") ? vaultUrl : `${vaultUrl}/`);
  url.searchParams.set("api-version", VAULT_API_VERSION);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Name the wait that was bounded — a bare timeout abort carries neither
    // the operation nor the bound.
    throw new Error(
      `reading the migration DSN from the vault timed out or failed after ${timeoutMs} ms`,
      { cause: err },
    );
  }
  if (!response.ok) {
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

/**
 * Resolve the migration identity's DSN from the job's environment: a
 * managed-identity token from the ambient Container Apps identity endpoint,
 * then one Key Vault data-plane read. Throws a named error for every missing
 * or failing input — the DSN itself never appears in a message.
 */
export async function readMigrateDsn(
  env: NodeJS.ProcessEnv,
  options: ReadMigrateDsnOptions = {},
): Promise<string> {
  const vaultUrl = required("PLATFORM_VAULT_URL", env);
  const tokenProvider = managedIdentityTokenProviderFromEnv(env);
  if (!tokenProvider) {
    throw new Error(
      "this process is not running under a managed identity " +
        "(need IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID) — " +
        "the migration DSN is only readable inside the jobs migrate job",
    );
  }
  try {
    return await readVaultSecret(
      vaultUrl,
      SECRET_NAME,
      () => tokenProvider.getToken(),
      options.secretReadTimeoutMs ?? SECRET_READ_TIMEOUT_MS,
    );
  } finally {
    await tokenProvider.close();
  }
}

async function main(): Promise<void> {
  const vaultUrl = required("PLATFORM_VAULT_URL", process.env);

  const dsn = await readMigrateDsn(process.env);
  console.log(`read ${SECRET_NAME} from ${vaultUrl}`);

  // Run the package's own migration command so its structured
  // start/outcome/duration events are the job log verbatim, inheriting stdio
  // and exiting with its status so the job execution reflects the real
  // result.
  const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, [...MIGRATE_COMMAND], {
    stdio: "inherit",
    env: { ...process.env, JOBS_MIGRATE_DATABASE_URL: dsn },
    cwd: packageDir,
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) =>
      signal
        ? reject(new Error(`the migration command was killed by ${signal}`))
        : resolve(status ?? 1),
    );
  });

  if (code !== 0) {
    throw new Error(`the migration command exited ${code}`);
  }
  console.log("jobs storage migration applied");
}

// The command entry point, guarded so importing the module (the tests read
// `readMigrateDsn`) does not run the job.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    // Deliberately the message only — an Error carrying the DSN in a stack frame
    // would put the migration credential in the job log.
    console.error(
      `migrate-azure failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    // `process.exitCode`, NOT `process.exit()` — when stdout/stderr is a pipe
    // (always, under a container log collector) Node's writes are asynchronous,
    // and `process.exit()` can drop the only diagnostic this script produces.
    process.exitCode = 1;
  });
}
