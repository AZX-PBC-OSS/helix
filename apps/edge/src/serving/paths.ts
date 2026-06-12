/**
 * Request-path normalization for asset serving. The output is composed into a
 * blob key under the version's prefix, so this is the traversal defense —
 * deny-by-default, defense in depth, in this order:
 *
 *  1. raw-string rejects (backslashes, encoded backslash/NUL) before decoding
 *  2. strict percent-decoding (malformed → reject)
 *  3. post-decode rejects: backslash, NUL/control chars, and any remaining
 *     `%` (kills double-encoding; costs us files literally named with `%` —
 *     accepted trade-off)
 *  4. segment rejects: `.` and `..`
 *
 * Returns the normalized `/`-prefixed path, or null = reject (callers answer
 * 404 without saying why).
 */
const RAW_REJECT = /\\|%5c|%00/i;
// eslint-disable-next-line no-control-regex
const DECODED_REJECT = /[\\%\x00-\x1f\x7f]/;

export function normalizeRequestPath(rawUrl: string): string | null {
  // Strip query/fragment; only the path addresses an asset.
  const cut = rawUrl.search(/[?#]/);
  const rawPath = cut === -1 ? rawUrl : rawUrl.slice(0, cut);

  if (!rawPath.startsWith("/")) return null;
  if (RAW_REJECT.test(rawPath)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (DECODED_REJECT.test(decoded)) return null;

  const segments = decoded.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;

  return `/${segments.join("/")}`;
}
