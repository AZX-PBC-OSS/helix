import { EntraDirectory, type GetGraphToken } from "./entra.js";
import { DEV_FIXTURE_GROUPS, StaticDirectory } from "./static.js";
import { UnavailableDirectory, type DirectoryProvider } from "./provider.js";

export {
  DirectoryError,
  GRAPH_GROUP_PERMISSION,
  MAX_SEARCH_RESULTS,
  MIN_SEARCH_LENGTH,
  UnavailableDirectory,
} from "./provider.js";
export type {
  DirectoryOutcome,
  DirectoryProvider,
  DirectoryUnavailableReason,
  GroupName,
  GroupSummary,
} from "./provider.js";
export { EntraDirectory, GRAPH_SCOPE } from "./entra.js";
export type { EntraDirectoryOptions, GetGraphToken } from "./entra.js";
export { DEV_FIXTURE_GROUPS, StaticDirectory } from "./static.js";

export interface DirectoryConfig {
  /** Graph token source. When present, use the real directory (prod). */
  getToken?: GetGraphToken;
  /** Fixture groups for the dev/CI provider. Defaults to {@link DEV_FIXTURE_GROUPS}. */
  fixtures?: typeof DEV_FIXTURE_GROUPS;
  /**
   * Whether a fixture-backed directory is permissible. The portal passes
   * `false` in production — see `apps/portal/src/directory/custody.ts`.
   */
  allowFixtures?: boolean;
}

/**
 * Pick the directory backend from config, mirroring `createSecretStore`.
 *
 * Precedence is deliberate and matches the custody seam's: a real token source
 * **always wins**, and the fixture backend is only reachable when explicitly
 * permitted. The inversion this guards against is a production portal that still
 * carries a dev flag quietly answering group searches out of a hardcoded list —
 * which would not error, would not log, and would show an operator a picker full
 * of groups that do not exist in their tenant.
 *
 * Config in, not `process.env`: env reading is the app's job (the portal does it
 * in `directory/custody.ts`, testably, against an injected env).
 */
export function createDirectory(config: DirectoryConfig): DirectoryProvider {
  if (config.getToken) {
    return new EntraDirectory({ getToken: config.getToken });
  }
  if (config.allowFixtures) {
    return new StaticDirectory(config.fixtures ?? DEV_FIXTURE_GROUPS);
  }
  return new UnavailableDirectory(
    "this deployment has no Microsoft Graph credential configured, so directory " +
      "search is unavailable; group ids can still be entered directly",
  );
}
