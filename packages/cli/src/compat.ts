import type { PortalClient } from "./client.js";

/** The command that always runs the newest CLI; what every compatibility hint tells the user to use. */
export const NPX_LATEST = "npx -y @azx-pbc/helix-cli@latest";

/** Parse `major.minor.patch`, ignoring any prerelease or build suffix; null if it isn't one. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `version` is strictly older than `floor`. False when either can't be parsed. */
export function isOlderThan(version: string, floor: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/**
 * Warn on stderr when this CLI is older than the portal's stated floor
 * (`cli.minVersion` on `GET /api/v1/config`). Never throws: an unreachable
 * portal, an older portal with no floor, or an unstamped dev build all skip the
 * check, and the command itself reports any real connection error.
 */
export async function warnIfCliTooOld(
  client: PortalClient,
  cliVersion: string,
  warn: (msg: string) => void = (msg) => console.error(msg),
): Promise<void> {
  try {
    const floor = (await client.getDeploymentConfig()).cli?.minVersion;
    if (floor && isOlderThan(cliVersion, floor)) {
      warn(
        `warning: this portal needs helix-cli ${floor} or newer (you have ${cliVersion}). ` +
          `Run \`${NPX_LATEST} …\`, or update your global install.`,
      );
    }
  } catch {
    // The check is advisory; the command reports connection problems itself.
  }
}
