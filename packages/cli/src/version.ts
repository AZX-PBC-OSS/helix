/**
 * The CLI's own version, stamped into the bundle by `scripts/build.mjs`. Running
 * from source (`pnpm helix`) has no stamp and reports `latest` instead.
 */
declare const __HELIX_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __HELIX_CLI_VERSION__ === "string" ? __HELIX_CLI_VERSION__ : "latest";
