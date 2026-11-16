/**
 * The bundle file-type allowlist: extension → Content-Type.
 *
 * A bundle may only contain these types (architecture §5: "static files only").
 * It is deny-by-default: anything not listed (executables, shell scripts,
 * archives, …) is rejected at deploy time. The portal enforces it on upload
 * (`apps/portal/src/deploy/validate.ts`) and stores the mapped type on the blob,
 * which is the Content-Type the edge serves back. The SPA's bundle planner reads
 * the same map to decide what to drop as unserveable, so the two cannot drift.
 *
 * Every entry must be inert in a browser that honours `nosniff`. Only
 * `text/html` is treated as a document the edge injects into.
 *
 * Browser-safe (no `node:*`) because the SPA imports it via the planner.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  // Documents, scripts and data
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  // Images
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  // Fonts
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  // Video. `.ts` (MPEG-TS) is left out: the planner reads it as TypeScript source.
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  // Audio
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".weba": "audio/webm",
  // Captions and subtitles for <track>, which only reads WebVTT.
  ".vtt": "text/vtt; charset=utf-8",
};

/** Lowercased extensions (with the leading dot) that a bundle may contain. */
export const SERVEABLE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(CONTENT_TYPES));

function extname(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/** The Content-Type for a path, or undefined if its extension isn't allowed. */
export function contentTypeFor(path: string): string | undefined {
  const ext = extname(path);
  return Object.hasOwn(CONTENT_TYPES, ext) ? CONTENT_TYPES[ext] : undefined;
}
