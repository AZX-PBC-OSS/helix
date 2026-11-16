/**
 * The upload allowlist lives in `@azx-pbc/shared/mime` so the SPA's bundle
 * planner and this enforcement path read one list. Enforcement stays here:
 * `validate.ts` rejects any entry `contentTypeFor` doesn't map.
 */
export { contentTypeFor } from "@azx-pbc/shared/mime";

/** File extensions we scan for the CSP courtesy lint (architecture §4.4). */
const LINTABLE_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs"]);

function extname(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/** Whether a path's content should be scanned by the CSP lint. */
export function isLintable(path: string): boolean {
  return LINTABLE_EXTENSIONS.has(extname(path));
}
