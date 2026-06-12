import { mkdir, readFile, rename, writeFile, chmod, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * On-disk token cache for `azx login`: one file, keyed by issuer (a portal
 * switch in dev/prod just works), mode 0600 — it holds bearer credentials.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  clientId: string;
}

interface TokenFile {
  version: 1;
  byIssuer: Record<string, StoredTokens>;
}

/** `$XDG_CONFIG_HOME/azx/tokens.json`, defaulting to `~/.config`. */
export function defaultTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "azx", "tokens.json");
}

async function readFileTolerant(file: string): Promise<TokenFile> {
  const empty: TokenFile = { version: 1, byIssuer: {} };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as TokenFile;
    if (parsed.version !== 1 || typeof parsed.byIssuer !== "object" || !parsed.byIssuer) {
      return empty;
    }
    return parsed;
  } catch {
    // Missing or corrupt — treat as logged out rather than crashing the CLI.
    return empty;
  }
}

export async function readTokens(
  issuer: string,
  file = defaultTokenPath(),
): Promise<StoredTokens | undefined> {
  const data = await readFileTolerant(file);
  const entry = data.byIssuer[issuer];
  if (!entry || typeof entry.accessToken !== "string" || typeof entry.expiresAt !== "number") {
    return undefined;
  }
  return entry;
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
  issuer: string,
  tokens: StoredTokens,
  file = defaultTokenPath(),
): Promise<void> {
  const data = await readFileTolerant(file);
  data.byIssuer[issuer] = tokens;
  await writeFile0600(file, JSON.stringify(data, null, 2));
}

/** Returns true if there was something to forget. */
export async function deleteTokens(issuer: string, file = defaultTokenPath()): Promise<boolean> {
  const data = await readFileTolerant(file);
  if (!(issuer in data.byIssuer)) return false;
  delete data.byIssuer[issuer];
  if (Object.keys(data.byIssuer).length === 0) {
    await rm(file, { force: true });
  } else {
    await writeFile0600(file, JSON.stringify(data, null, 2));
  }
  return true;
}
