/**
 * Bundle validation limits (architecture §5: size/type sanity checks).
 *
 * The two capacity caps — per-file and whole-bundle — are env-overridable, so a
 * deployment can be retuned without a code change. The rest are security guards
 * with no operational reason to move, and stay constants.
 *
 * Resolvers take an injectable `env` and are read per call, not frozen at boot —
 * same shape as `deployment.ts`. That also lets a test set a small cap instead
 * of generating tens of megabytes of incompressible data to trip the real one.
 */

const MB = 1024 * 1024;

/** Default max uncompressed bytes for any single file. */
export const DEFAULT_MAX_FILE_BYTES = 50 * MB;

/** Default max total uncompressed bytes across the whole bundle. */
export const DEFAULT_MAX_TOTAL_BYTES = 250 * MB;

/** Max number of files in a bundle. */
export const MAX_ENTRIES = 5_000;

/**
 * Max uncompressed:compressed ratio for any file. Above this we treat the
 * entry as a decompression bomb and reject the bundle.
 */
export const MAX_COMPRESSION_RATIO = 200;

/** Max bytes of a lintable file we buffer for the CSP courtesy lint. */
export const MAX_LINT_BYTES = 512 * 1024;

/**
 * Parse a megabyte-valued override. Unset falls back to the default; a value
 * that is present but unusable throws rather than silently reverting — these
 * caps are a security control, and a typo that quietly restores the default is
 * worse than a boot failure. Same posture as `resolveAppPublicBase`.
 */
function resolveMegabytes(name: string, raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const mb = Number(trimmed);
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new Error(
      `${name} must be a positive number of megabytes (e.g. "50"); got ${JSON.stringify(trimmed)}`,
    );
  }
  return Math.floor(mb * MB);
}

/** Max uncompressed bytes for any single file (`DEPLOY_MAX_FILE_MB`). */
export function resolveMaxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMegabytes("DEPLOY_MAX_FILE_MB", env.DEPLOY_MAX_FILE_MB, DEFAULT_MAX_FILE_BYTES);
}

/**
 * Max total uncompressed bytes across a bundle (`DEPLOY_MAX_BUNDLE_MB`). Also
 * caps the *compressed* multipart upload (app.ts), which is the number that
 * bounds temp-disk use on the portal replica — see `spoolUpload`.
 */
export function resolveMaxTotalBytes(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMegabytes(
    "DEPLOY_MAX_BUNDLE_MB",
    env.DEPLOY_MAX_BUNDLE_MB,
    DEFAULT_MAX_TOTAL_BYTES,
  );
}

/**
 * Boot-time half: `buildApp` calls this so a bad override is a startup error
 * rather than a surprise on the first deploy of the day.
 */
export function assertBundleLimits(env: NodeJS.ProcessEnv = process.env): void {
  resolveMaxFileBytes(env);
  resolveMaxTotalBytes(env);
}
