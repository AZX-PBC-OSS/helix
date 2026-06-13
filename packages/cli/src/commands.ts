import { readFile } from "node:fs/promises";
import type { App, Version, Visibility } from "@helix/shared";
import { CliError, PortalClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { zipDirectory } from "./zip.js";
import { runDeviceLogin } from "./auth/deviceFlow.js";
import { deleteTokens, writeTokens } from "./auth/tokenStore.js";

function requireSlug(config: ResolvedConfig): string {
  if (!config.slug) {
    throw new CliError("no app slug; set it in azx.json or pass --slug");
  }
  return config.slug;
}

/** Parse a CLI visibility string: `private` | `group:<id>` | `password` | `public`. */
export function parseVisibility(input?: string): Visibility | undefined {
  if (!input) return undefined;
  if (input.startsWith("group:")) {
    const groupId = input.slice("group:".length);
    if (!groupId) throw new CliError("group visibility needs an id: group:<id>");
    return { mode: "group", groupId };
  }
  if (input === "private" || input === "password" || input === "public") {
    return { mode: input };
  }
  throw new CliError(`invalid visibility "${input}" (private | group:<id> | password | public)`);
}

function printVersion(v: Version): void {
  console.log(`  version ${v.number} (${v.status}) — ${v.id}`);
  console.log(`  assets: ${v.blobPrefix}`);
}

function printApp(app: App): void {
  console.log(`  app ${app.slug} — live version: ${app.currentVersionId ?? "(none)"}`);
}

export async function createCommand(
  client: PortalClient,
  config: ResolvedConfig,
  opts: { displayName?: string; visibility?: string },
): Promise<void> {
  const slug = requireSlug(config);
  const app = await client.createApp({
    slug,
    displayName: opts.displayName ?? slug,
    visibility: parseVisibility(opts.visibility),
  });
  console.log(`Created app "${app.slug}".`);
  printApp(app);
}

export async function deployCommand(
  client: PortalClient,
  config: ResolvedConfig,
  opts: { promote?: boolean },
): Promise<void> {
  const slug = requireSlug(config);
  const zip = config.bundle ? await readFile(config.bundle) : await zipDirectory(config.dir);
  console.log(`Uploading bundle to "${slug}"…`);

  const { version, warnings } = await client.uploadVersion(slug, zip);
  console.log(`Uploaded as preview:`);
  printVersion(version);

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} CSP warning(s):`);
    for (const w of warnings) console.log(`  - ${w.file}: ${w.hint}`);
  }

  if (opts.promote) {
    const app = await client.promote(slug, version.number);
    console.log(`\nPromoted version ${version.number} to live.`);
    printApp(app);
  } else {
    console.log(`\nNot live yet — promote with: azx promote ${version.number}`);
  }
}

export async function versionsCommand(client: PortalClient, config: ResolvedConfig): Promise<void> {
  const slug = requireSlug(config);
  const versions = await client.listVersions(slug);
  if (versions.length === 0) {
    console.log(`No versions for "${slug}".`);
    return;
  }
  console.log(`Versions for "${slug}" (newest first):`);
  for (const v of versions) console.log(`  ${v.number}\t${v.status}\t${v.id}`);
}

export async function promoteCommand(
  client: PortalClient,
  config: ResolvedConfig,
  number: number,
): Promise<void> {
  const slug = requireSlug(config);
  const app = await client.promote(slug, number);
  console.log(`Promoted version ${number} to live.`);
  printApp(app);
}

export async function rollbackCommand(
  client: PortalClient,
  config: ResolvedConfig,
  toNumber?: number,
): Promise<void> {
  const slug = requireSlug(config);
  const app = await client.rollback(slug, toNumber);
  console.log(
    toNumber ? `Rolled back to version ${toNumber}.` : `Rolled back to previous version.`,
  );
  printApp(app);
}

/**
 * `azx login` — OIDC device flow against the issuer the portal advertises.
 * Stores tokens in the XDG cache; nothing here is auto-launched on 401
 * (agents and CI run headless — they use AZX_TOKEN).
 */
export async function loginCommand(client: PortalClient, config: ResolvedConfig): Promise<void> {
  const { issuer, cliClientId, audience } = await client.getAuthConfig();
  const tokens = await runDeviceLogin({ issuer, clientId: cliClientId, log: console.log });
  // Bound to THIS portal's origin: a different portal (e.g. one planted via
  // a repo's azx.json) never receives this credential, even if it advertises
  // the same issuer.
  await writeTokens({ portalUrl: config.portalUrl, issuer }, tokens, undefined, { audience });

  // Prove the token against the portal and greet the actor.
  const authed = new PortalClient(config.portalUrl, tokens.accessToken);
  const me = await authed.me();
  console.log(`Logged in as ${me.name ?? me.sub} (${me.sub}).`);
}

export async function logoutCommand(config: ResolvedConfig): Promise<void> {
  const forgot = await deleteTokens(config.portalUrl);
  console.log(forgot ? "Logged out (local tokens forgotten)." : "Already logged out.");
}

export async function whoamiCommand(client: PortalClient): Promise<void> {
  const me = await client.me();
  console.log(`${me.sub} (via ${me.via}${me.name ? `, ${me.name}` : ""})`);
}
