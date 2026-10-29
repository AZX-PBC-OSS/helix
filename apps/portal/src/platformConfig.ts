/**
 * The portal environment variables the Platform Settings screen lists
 * (`GET /api/v1/admin/config`). Only names on this list are reported, so a
 * variable added later stays hidden until someone decides how to show it.
 *
 * A `secret` entry reports only whether it is set; its value never leaves this
 * module. A non-secret value that parses as a URL with userinfo, a query
 * string or a fragment is withheld the same way, in case a deployment puts a
 * password or a SAS token where a plain URL was expected.
 */

import type { PlatformConfigEntry } from "@azx-pbc/shared";

interface ConfigVar {
  name: string;
  description: string;
  secret?: true;
}

export const PLATFORM_CONFIG_VARS: readonly ConfigVar[] = [
  { name: "NODE_ENV", description: "Runtime mode; production enables the strict boot checks" },
  { name: "APP_PUBLIC_BASE", description: "Where apps are served (apps base URL)" },
  { name: "PORTAL_PUBLIC_ORIGIN", description: "This portal's public origin" },
  { name: "DEV_API_PUBLIC_BASE", description: "Dev gateway base; empty when not deployed" },
  { name: "PORTAL_OIDC_ISSUER", description: "OIDC issuer for portal sign-in" },
  { name: "PORTAL_OIDC_AUDIENCE", description: "Expected token audience" },
  { name: "PORTAL_OIDC_PRINCIPAL_CLAIM", description: "Claim used as the principal id" },
  { name: "PORTAL_OIDC_ALLOW_SUB_PRINCIPAL", description: "Allow `sub` as the principal" },
  { name: "PORTAL_OIDC_ALLOW_INSECURE", description: "Allow a non-https issuer (dev only)" },
  { name: "AZX_CLI_CLIENT_ID", description: "OIDC client id for the helix CLI" },
  { name: "AZX_WEB_CLIENT_ID", description: "OIDC client id for the portal SPA" },
  { name: "PORTAL_ADMIN_GROUP_ID", description: "Group or app role that grants platform admin" },
  { name: "PORTAL_ALLOW_SELF_APPROVE", description: "Let an admin approve their own requests" },
  { name: "PORTAL_ALLOW_PUBLIC_APPS", description: "Permit public (anonymous) apps" },
  { name: "PORTAL_ALLOW_PASSWORD_APPS", description: "Permit shared-password apps" },
  { name: "PORTAL_REPO_DEPLOY_ENABLED", description: "Accept GitHub Actions deploys" },
  { name: "PORTAL_GITHUB_OIDC_ISSUER", description: "GitHub Actions OIDC issuer" },
  { name: "PORTAL_GITHUB_SERVER_URL", description: "GitHub server URL" },
  { name: "DEPLOY_MAX_FILE_MB", description: "Largest single file in a deploy" },
  { name: "DEPLOY_MAX_BUNDLE_MB", description: "Largest deploy bundle" },
  { name: "PLATFORM_MONTHLY_USD_CAP", description: "Platform-wide monthly LLM spend cap" },
  { name: "PORTAL_LLM_MODEL_ALLOWLIST", description: "Models apps may request" },
  { name: "PORTAL_LLM_MODEL_BLOCKLIST", description: "Models apps may not request" },
  { name: "PORTAL_DIRECTORY", description: "Directory provider for the group picker" },
  { name: "PORTAL_DIRECTORY_SEARCH", description: "Directory search mode" },
  { name: "PORTAL_EGRESS_URL", description: "Internal egress service URL" },
  { name: "AZURE_KEY_VAULT_URL", description: "Key Vault for connection secrets" },
  { name: "AZURE_CLIENT_ID", description: "Managed identity client id" },
  { name: "AZURE_STORAGE_BLOB_ENDPOINT", description: "Blob storage endpoint" },
  { name: "BLOB_CONTAINER", description: "Blob container for app bundles" },
  { name: "PORTAL_GEOIP_DB_PATH", description: "GeoIP database for the Visitors view" },
  { name: "PORTAL_WEB_DIST", description: "Built SPA directory" },
  { name: "PORTAL_DEV_ACTOR", description: "Actor for the dev token" },
  { name: "PORTAL_DEV_ADMIN_ACTOR", description: "Actor for the dev admin token" },
  { name: "PORTAL_DATABASE_URL", description: "Portal database connection", secret: true },
  { name: "DATABASE_URL", description: "Fallback database connection", secret: true },
  {
    name: "AZURE_STORAGE_CONNECTION_STRING",
    description: "Blob storage connection string",
    secret: true,
  },
  { name: "PORTAL_SECRET", description: "Key that encrypts shared app passwords", secret: true },
  { name: "HELIX_INTERNAL_SECRET", description: "Edge ↔ portal internal JWT key", secret: true },
  { name: "HELIX_EXCHANGE_SECRET", description: "Token-exchange signing key", secret: true },
  { name: "PORTAL_DEV_TOKEN", description: "Dev bearer token", secret: true },
  { name: "PORTAL_DEV_ADMIN_TOKEN", description: "Dev admin bearer token", secret: true },
  { name: "DEV_SECRETS_KEK_FILE", description: "Dev key-encryption key file", secret: true },
];

/**
 * True for a URL that could carry a credential: userinfo, or any query string
 * or fragment (a SAS token rides the query, `?sv=…&sig=…`).
 */
function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "";
  } catch {
    return false;
  }
}

/** The listed variables as the admin screen shows them. */
export function platformConfigEntries(env: NodeJS.ProcessEnv = process.env): PlatformConfigEntry[] {
  return PLATFORM_CONFIG_VARS.map(({ name, description, secret }) => {
    const raw = env[name];
    const set = raw !== undefined && raw !== "";
    const withheld = secret === true || (set && hasUrlCredentials(raw));
    return {
      name,
      description,
      secret: withheld,
      set,
      value: set && !withheld ? raw : null,
    };
  });
}
