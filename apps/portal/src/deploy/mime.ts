/**
 * The static-files-only allowlist. Extension → Content-Type. A bundle may only
 * contain these types (architecture §5: "static files only"). The map is also
 * the source of the blob Content-Type we serve back from the edge (M2).
 *
 * This is deliberately deny-by-default: anything not listed (executables,
 * shell scripts, archives, …) is rejected at deploy time.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

/** File extensions we scan for the CSP courtesy lint (architecture §4.4). */
const LINTABLE_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs"]);

function extname(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/** The Content-Type for a path, or undefined if its extension isn't allowed. */
export function contentTypeFor(path: string): string | undefined {
  return CONTENT_TYPES[extname(path)];
}

/** Whether a path's content should be scanned by the CSP lint. */
export function isLintable(path: string): boolean {
  return LINTABLE_EXTENSIONS.has(extname(path));
}
