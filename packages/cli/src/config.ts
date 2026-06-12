import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CliFlags {
  slug?: string;
  portalUrl?: string;
  dir?: string;
  bundle?: string;
  token?: string;
}

export interface ResolvedConfig {
  portalUrl: string;
  token?: string;
  slug?: string;
  /** Directory to zip when no prebuilt bundle is given. */
  dir: string;
  /** Path to a prebuilt zip; takes precedence over `dir` for deploy. */
  bundle?: string;
}

const DEFAULT_PORTAL_URL = "http://localhost:3001";
const DEFAULT_DIR = "dist";

interface AzxFile {
  slug?: string;
  portalUrl?: string;
  dir?: string;
}

async function readAzxJson(cwd: string): Promise<AzxFile> {
  try {
    return JSON.parse(await readFile(path.join(cwd, "azx.json"), "utf8")) as AzxFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Merge config from azx.json, environment, and flags (flags win). */
export async function resolveConfig(
  flags: CliFlags,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
  const file = await readAzxJson(cwd);
  return {
    portalUrl: flags.portalUrl ?? env.AZX_PORTAL_URL ?? file.portalUrl ?? DEFAULT_PORTAL_URL,
    token: flags.token ?? env.AZX_TOKEN,
    slug: flags.slug ?? file.slug,
    dir: flags.dir ?? file.dir ?? DEFAULT_DIR,
    bundle: flags.bundle,
  };
}
