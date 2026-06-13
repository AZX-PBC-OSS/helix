import { mkdir, readFile, rename, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * On-disk token cache for `azx login`: one file, mode 0600 — it holds bearer
 * credentials. Entries are keyed by the **portal origin** the user logged in
 * to, with the issuer recorded alongside: the portal URL is repo-influenced
 * config (`azx.json`), so a token cached for portal A must never be sent to
 * portal B — even one that advertises the same (real) issuer and would
 * otherwise be handed a replayable credential.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  clientId: string;
}

/** What a cache entry is bound to: the portal it may be sent to. */
export interface TokenKey {
  /** The portal the user logged in to; normalized to its origin. */
  portalUrl: string;
  /** The issuer that portal advertised at login time. */
  issuer: string;
}

interface StoredEntry {
  issuer: string;
  /** The token audience the portal advertised at login, when it did. */
  audience?: string;
  tokens: StoredTokens;
}

interface TokenFile {
  version: 2;
  byPortal: Record<string, StoredEntry>;
}

/** Normalize a portal URL to the origin tokens are bound to. */
export function portalOrigin(portalUrl: string): string {
  return new URL(portalUrl).origin;
}

/** `$XDG_CONFIG_HOME/azx/tokens.json`, defaulting to `~/.config`. */
export function defaultTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "azx", "tokens.json");
}

async function readFileTolerant(file: string): Promise<TokenFile> {
  const empty: TokenFile = { version: 2, byPortal: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as TokenFile;
    // A version-1 file (issuer-keyed, unbound to a portal) reads as logged
    // out — re-running `azx login` rebinds the tokens correctly.
    if (parsed.version !== 2 || typeof parsed.byPortal !== "object" || !parsed.byPortal) {
      return empty;
    }
    return parsed;
  } catch {
    // Missing or corrupt — treat as logged out rather than crashing the CLI.
    return empty;
  }
}

/**
 * Tokens for this portal origin, but only if the issuer it advertises today
 * matches the one it advertised at login — an origin whose config changed
 * gets a fresh `azx login`, never a silently re-targeted credential.
 */
export async function readTokens(
  key: TokenKey,
  file = defaultTokenPath(),
): Promise<StoredTokens | undefined> {
  const data = await readFileTolerant(file);
  const entry = data.byPortal[portalOrigin(key.portalUrl)];
  if (!entry || entry.issuer !== key.issuer) return undefined;
  const tokens = entry.tokens;
  if (!tokens || typeof tokens.accessToken !== "string" || typeof tokens.expiresAt !== "number") {
    return undefined;
  }
  return tokens;
}

async function writeFile0600(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Write-then-rename: a crash never leaves a half-written credential file.
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600); // rename preserves tmp's mode, but be explicit
}

export async function writeTokens(
  key: TokenKey,
  tokens: StoredTokens,
  file = defaultTokenPath(),
  opts: { audience?: string } = {},
): Promise<void> {
  const data = await readFileTolerant(file);
  data.byPortal[portalOrigin(key.portalUrl)] = {
    issuer: key.issuer,
    ...(opts.audience ? { audience: opts.audience } : {}),
    tokens,
  };
  await writeFile0600(file, JSON.stringify(data, null, 2));
}

/** Forget this portal's tokens (whatever issuer they were bound to). Returns true if there was something to forget. */
export async function deleteTokens(portalUrl: string, file = defaultTokenPath()): Promise<boolean> {
  const data = await readFileTolerant(file);
  const origin = portalOrigin(portalUrl);
  if (!(origin in data.byPortal)) return false;
  delete data.byPortal[origin];
  if (Object.keys(data.byPortal).length === 0) {
    await rm(file, { force: true });
  } else {
    await writeFile0600(file, JSON.stringify(data, null, 2));
  }
  return true;
}
