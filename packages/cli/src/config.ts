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

interface HelixConfigFile {
  slug?: string;
  portalUrl?: string;
  dir?: string;
}

/**
 * Config filenames in precedence order. `azx.json` is the pre-rename name,
 * still read so an app directory that predates the rename keeps deploying;
 * `helix.json` wins when both are present.
 */
const CONFIG_FILENAMES = ["helix.json", "azx.json"] as const;

async function readConfigFile(cwd: string): Promise<HelixConfigFile> {
  for (const name of CONFIG_FILENAMES) {
    try {
      return JSON.parse(await readFile(path.join(cwd, name), "utf8")) as HelixConfigFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return {};
}

/** Merge config from helix.json, environment, and flags (flags win). */
export async function resolveConfig(
  flags: CliFlags,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
  const file = await readConfigFile(cwd);
  // AZX_* are the pre-rename names, still read as a fallback so existing
  // shells and CI env blocks keep working; HELIX_* wins when both are set.
  return {
    portalUrl:
      flags.portalUrl ??
      env.HELIX_PORTAL_URL ??
      env.AZX_PORTAL_URL ??
      file.portalUrl ??
      DEFAULT_PORTAL_URL,
    token: flags.token ?? env.HELIX_TOKEN ?? env.AZX_TOKEN,
    slug: flags.slug ?? file.slug,
    dir: flags.dir ?? file.dir ?? DEFAULT_DIR,
    bundle: flags.bundle,
  };
}
