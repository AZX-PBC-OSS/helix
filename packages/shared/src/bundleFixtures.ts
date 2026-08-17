import type { BundleEntry } from "./bundlePlan.js";

/**
 * Malformed upload bundles, reconstructed from real ones users sent us
 * (ADR-0038). See `bundleFixtures.md` for the provenance of each and what makes
 * it interesting.
 *
 * Structure is faithful — entry order, directory records, junk sidecars, the
 * `src`/`dist` byte-for-byte duplication — while the content is stubbed down to
 * a few bytes. `canonical` is what the upload *should* have carried, so a test
 * can state the gap between what arrived and what was meant without re-deriving
 * it.
 *
 * This is a **node-only** module (its binary fixtures use `Buffer`), reached via
 * the `@azx-pbc/shared/bundleFixtures` subpath and never from the browser barrel.
 * It is shared so the planner's tests (in this package) and the portal's bundle
 * characterization tests read from one corpus.
 */

/**
 * A single zip entry, structurally compatible with the portal's `ZipFileSpec`
 * (`apps/portal/src/test/zip.ts`) so its `buildZipFile` accepts these directly.
 */
export interface BundleFixtureEntry {
  name: string;
  content?: Buffer | string;
  /** Directory record (some archivers emit these, some don't — a real difference). */
  directory?: boolean;
  /** When set, the entry is a symlink pointing here (for security tests). */
  symlinkTo?: string;
  mode?: number;
}

export interface MalformedBundle {
  /** Short label, used in test names. */
  label: string;
  /** Zip entries, in the order the original archive carried them. */
  entries: BundleFixtureEntry[];
  /** Bundle-relative paths a correct upload of the same app would have had. */
  canonical: string[];
}

/**
 * Project the fixture entries into the planner's `{ path, bytes }` input:
 * directory and symlink records drop out (the planner sees regular files only),
 * and `bytes` is the byte length of the stubbed content.
 */
export function toPlannerEntries(entries: BundleFixtureEntry[]): BundleEntry[] {
  return entries
    .filter((e) => !e.directory && e.symlinkTo === undefined)
    .map((e) => ({
      path: e.name,
      bytes:
        typeof e.content === "string" ? Buffer.byteLength(e.content) : (e.content?.length ?? 0),
    }));
}

/** A path → decoded-text lookup over a fixture, for the reference-resolution lint. */
export function fixtureText(entries: BundleFixtureEntry[]): (path: string) => string | undefined {
  const byPath = new Map<string, string>();
  for (const e of entries) {
    if (e.directory || e.symlinkTo !== undefined) continue;
    if (typeof e.content === "string") byPath.set(e.name, e.content);
  }
  return (path) => byPath.get(path);
}

/**
 * The first 8 bytes of an AppleDouble header, then padding. macOS writes one of
 * these under `__MACOSX/` beside every entry it archives; the real ones are a
 * couple hundred bytes of resource-fork metadata. Only the *path* identifies
 * them, so the payload is stubbed.
 */
const APPLE_DOUBLE = Buffer.concat([
  Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]),
  Buffer.alloc(24),
]);

const PAGE = [
  "<!doctype html>",
  '<meta charset="utf-8">',
  "<title>Example App</title>",
  '<link rel="stylesheet" href="./styles.css">',
  '<script src="./app.js"></script>',
  "",
].join("\n");

const STYLES = "body{margin:0;font-family:system-ui}\n";
const APP_JS = 'document.title = "Example App";\n';

/**
 * **Zipped the project root.** The whole app directory, macOS junk and all.
 *
 * Three things make it the interesting case: it carries a `helix.json` naming
 * its own build directory (an authoritative answer, three entries *after* the
 * junk entry that fails the deploy today); `src/` and `dist/` hold identical
 * bytes, because the "build" is a file copy, so no content signal separates
 * them; and the junk is interleaved from the second entry onward, so any
 * first-offending-entry error reports junk before it reports anything true.
 */
export const PROJECT_ROOT_MACOS: MalformedBundle = {
  label: "project root, zipped with macOS junk",
  entries: [
    { name: "helix-app/", directory: true },
    { name: "__MACOSX/._helix-app", content: APPLE_DOUBLE },
    { name: "helix-app/helix.json", content: '{"slug":"example-app","dir":"dist"}\n' },
    { name: "__MACOSX/helix-app/._helix.json", content: APPLE_DOUBLE },
    { name: "helix-app/dist/", directory: true },
    { name: "__MACOSX/helix-app/._dist", content: APPLE_DOUBLE },
    {
      name: "helix-app/package.json",
      content: '{"name":"example-app","private":true,"scripts":{"build":"node build.mjs"}}\n',
    },
    { name: "__MACOSX/helix-app/._package.json", content: APPLE_DOUBLE },
    {
      name: "helix-app/build.mjs",
      // The real one is exactly this: a copy, no bundler, no transform — which
      // is why src/ and dist/ below are byte-identical.
      content: "// build: copies src/{index.html,styles.css,app.js} into dist/\n",
    },
    { name: "__MACOSX/helix-app/._build.mjs", content: APPLE_DOUBLE },
    {
      name: "helix-app/manifest.json",
      content: JSON.stringify({
        app: "example-app",
        visibility: { mode: "internal" },
        capabilities: {
          llm: { models: ["claude-sonnet-5"], dollarsPerDay: 5 },
          data: { user: true, collections: [], sharedRead: [], sharedWrite: [] },
          mcp: [],
          externalOrigins: [],
        },
      }),
    },
    { name: "__MACOSX/helix-app/._manifest.json", content: APPLE_DOUBLE },
    { name: "helix-app/src/", directory: true },
    { name: "__MACOSX/helix-app/._src", content: APPLE_DOUBLE },
    { name: "helix-app/dist/index.html", content: PAGE },
    { name: "__MACOSX/helix-app/dist/._index.html", content: APPLE_DOUBLE },
    { name: "helix-app/dist/styles.css", content: STYLES },
    { name: "__MACOSX/helix-app/dist/._styles.css", content: APPLE_DOUBLE },
    { name: "helix-app/dist/app.js", content: APP_JS },
    { name: "__MACOSX/helix-app/dist/._app.js", content: APPLE_DOUBLE },
    { name: "helix-app/src/index.html", content: PAGE },
    { name: "__MACOSX/helix-app/src/._index.html", content: APPLE_DOUBLE },
    { name: "helix-app/src/styles.css", content: STYLES },
    { name: "__MACOSX/helix-app/src/._styles.css", content: APPLE_DOUBLE },
    { name: "helix-app/src/app.js", content: APP_JS },
    { name: "__MACOSX/helix-app/src/._app.js", content: APPLE_DOUBLE },
  ],
  canonical: ["index.html", "styles.css", "app.js"],
};

/** A 1x1 transparent PNG — a real image, so the fixture is not lying about its type. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function page(title: string, extraHead = ""): string {
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    extraHead,
    '<link rel="stylesheet" href="assets/styles.css">',
    '<nav><a href="index.html">Home</a> <a href="problem.html">Problem</a>' +
      ' <a href="prototype-to-production.html">Prototype</a>' +
      ' <a href="who-its-for.html">Who</a> <a href="workspace.html">Workspace</a></nav>',
    '<script src="assets/app.js"></script>',
  ]
    .filter((line) => line !== "")
    .join("\n")
    .concat("\n");
}

/**
 * **Zipped the folder itself.** One wrapper directory, a correct multi-page
 * static site inside it, no junk and no directory records.
 *
 * This is the *silent* failure: every extension is on the mime allowlist, so it
 * validates and deploys green, and then serves nothing at the bundle root. The
 * only signal is the one buried `index.html` advisory in the warning list.
 * Every reference in it is relative, so stripping the wrapper is safe — and its
 * wrapper name looks exactly like an app slug, which is the same shape a
 * correctly-nested offline bundle has (there, the directory must be *kept*).
 */
export const WRAPPER_DIR: MalformedBundle = {
  label: "build directory, zipped as a wrapper",
  entries: [
    {
      name: "marketing-site/index.html",
      // An allowlisted CDN origin, so the CSP lint stays silent on this bundle:
      // the "no index.html" advisory arrives with nothing beside it.
      content: page(
        "Marketing Site",
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">\n' +
          '<img src="assets/logo.png" alt="">',
      ),
    },
    { name: "marketing-site/problem.html", content: page("Problem") },
    { name: "marketing-site/prototype-to-production.html", content: page("Prototype") },
    { name: "marketing-site/who-its-for.html", content: page("Who it's for") },
    { name: "marketing-site/workspace.html", content: page("Workspace") },
    { name: "marketing-site/assets/app.js", content: 'console.log("marketing site");\n' },
    { name: "marketing-site/assets/logo.png", content: PNG_1PX },
    { name: "marketing-site/assets/styles.css", content: STYLES },
  ],
  canonical: [
    "index.html",
    "problem.html",
    "prototype-to-production.html",
    "who-its-for.html",
    "workspace.html",
    "assets/app.js",
    "assets/logo.png",
    "assets/styles.css",
  ],
};

/** Every fixture, for table-driven use. */
export const MALFORMED_BUNDLES: MalformedBundle[] = [PROJECT_ROOT_MACOS, WRAPPER_DIR];
