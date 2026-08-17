import { strFromU8, unzipSync, zipSync } from "fflate";
import type { BundleEntry } from "@azx-pbc/shared/bundlePlan";

/**
 * The one fflate-aware module (ADR-0038). Reads an uploaded zip or a dropped
 * folder into the planner's `{ path, bytes }` input, and — once the planner has
 * decided a layout — rebuilds the canonical archive the API expects.
 *
 * Two safety rules shape the API:
 *
 *  - **List before inflating.** A zip's central directory yields every entry's
 *    name and uncompressed size without decompressing a byte (fflate's `filter`
 *    returning `false`), so a `node_modules` upload is measured and refused
 *    before it can OOM the tab.
 *  - **Inflate only what ships.** The rebuild decompresses exactly the files the
 *    plan keeps, never the dropped ones.
 *
 * v1 runs synchronously on the main thread (ADR-0038 plan): correct and simple
 * at build-output sizes. A Web Worker is a later move if a large bundle janks.
 */

const HTML_RE = /\.html?$/i;

/** Bundle config filenames whose `dir` names the build directory (helix CLI). */
function isConfigName(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === "helix.json" || base === "azx.json";
}

/** A path is small text we pre-read at load time (html for the ref lint, config for `dir`). */
function isPreReadText(path: string): boolean {
  return HTML_RE.test(path) || isConfigName(path);
}

/** A bundle loaded from disk, ready to plan against and then rebuild. */
export interface LoadedBundle {
  /** Regular-file entries (directories excluded) for `planBundle`. */
  entries: BundleEntry[];
  /** Total uncompressed bytes across all entries (the size-guard input). */
  totalBytes: number;
  /** Decoded text of every HTML file, for the planner's reference lint. Sync. */
  htmlText: (path: string) => string | undefined;
  /** The `dir` declared in an in-bundle helix.json/azx.json, if any. */
  declaredDir?: string;
  /** Inflate/read exactly these archive paths, keyed by path. */
  materialize: (paths: string[]) => Promise<Map<string, Uint8Array>>;
}

/** Pull the build `dir` out of a config file's text, tolerating malformed JSON. */
function declaredDirFrom(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const dir = (JSON.parse(text) as { dir?: unknown }).dir;
    return typeof dir === "string" && dir.trim() !== "" ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Thrown when an upload is too large to process; carries a user-facing message. */
export class BundleTooLargeError extends Error {}

/**
 * Refuse an upload whose uncompressed total exceeds the deployment's bundle cap
 * before any inflation happens. `maxBundleBytes` comes from `GET /api/v1/config`.
 */
function guardSize(totalBytes: number, maxBundleBytes: number | null): void {
  if (maxBundleBytes !== null && totalBytes > maxBundleBytes) {
    const mb = Math.ceil(maxBundleBytes / (1024 * 1024));
    throw new BundleTooLargeError(
      `This upload is larger than the ${mb} MB deploy limit once unpacked. ` +
        `Make sure you're selecting your build output (e.g. dist/), not the whole project.`,
    );
  }
}

/* --------------------------------------------------------------------- zip */

/** Load a `.zip` File: list its central directory, then hold it for selective inflate. */
export async function loadZip(file: File, maxBundleBytes: number | null): Promise<LoadedBundle> {
  const data = new Uint8Array(await file.arrayBuffer());

  // Enumerate names + uncompressed sizes without inflating anything.
  const entries: BundleEntry[] = [];
  unzipSync(data, {
    filter: (f) => {
      if (!f.name.endsWith("/")) entries.push({ path: f.name, bytes: f.originalSize });
      return false;
    },
  });
  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
  guardSize(totalBytes, maxBundleBytes);

  // Inflate just the small text files (HTML for the ref lint, config for `dir`).
  const textByPath = new Map<string, string>();
  const textNames = new Set(entries.filter((e) => isPreReadText(e.path)).map((e) => e.path));
  if (textNames.size > 0) {
    const inflated = unzipSync(data, { filter: (f) => textNames.has(f.name) });
    for (const [name, bytes] of Object.entries(inflated)) textByPath.set(name, strFromU8(bytes));
  }
  const config = entries.find((e) => isConfigName(e.path));

  return {
    entries,
    totalBytes,
    htmlText: (path) => (HTML_RE.test(path) ? textByPath.get(path) : undefined),
    declaredDir: declaredDirFrom(config && textByPath.get(config.path)),
    materialize: (paths) => {
      const want = new Set(paths);
      const inflated = unzipSync(data, { filter: (f) => want.has(f.name) });
      return Promise.resolve(new Map(Object.entries(inflated)));
    },
  };
}

/* ------------------------------------------------------------------ folder */

/**
 * Load a dropped folder (or a `webkitdirectory` selection). The browser prefixes
 * every path with the selected folder's own name; when all files share that one
 * top segment we strip it, so "drop your `dist/` folder" means its *contents*
 * are the bundle — the common, correct action needs no re-rooting.
 */
export async function loadFolder(
  files: File[],
  maxBundleBytes: number | null,
): Promise<LoadedBundle> {
  const named = files.map((file) => ({ file, path: normalizeFolderPath(file) }));
  const prefix = commonTopSegment(named.map((n) => n.path));
  const rooted = named.map((n) => ({
    file: n.file,
    path: prefix ? n.path.slice(prefix.length) : n.path,
  }));

  const entries: BundleEntry[] = rooted.map((r) => ({ path: r.path, bytes: r.file.size }));
  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
  guardSize(totalBytes, maxBundleBytes);

  const byPath = new Map(rooted.map((r) => [r.path, r.file]));

  // Pre-read small text files (HTML for the ref lint, config for `dir`).
  const textByPath = new Map<string, string>();
  await Promise.all(
    rooted
      .filter((r) => isPreReadText(r.path))
      .map(async (r) => textByPath.set(r.path, await r.file.text())),
  );
  const config = rooted.find((r) => isConfigName(r.path));

  return {
    entries,
    totalBytes,
    htmlText: (path) => (HTML_RE.test(path) ? textByPath.get(path) : undefined),
    declaredDir: declaredDirFrom(config && textByPath.get(config.path)),
    materialize: async (paths) => {
      const out = new Map<string, Uint8Array>();
      await Promise.all(
        paths.map(async (p) => {
          const file = byPath.get(p);
          if (file) out.set(p, new Uint8Array(await file.arrayBuffer()));
        }),
      );
      return out;
    },
  };
}

/** react-dropzone sets `.path`; the directory picker sets `.webkitRelativePath`. */
function normalizeFolderPath(file: File): string {
  const raw = (file as File & { path?: string }).path ?? file.webkitRelativePath ?? file.name;
  return raw.replace(/^\.?\//, ""); // strip a leading "/" or "./"
}

/** The single top-level directory shared by every path (with its slash), or "". */
function commonTopSegment(paths: string[]): string {
  if (paths.length === 0) return "";
  const first = paths[0]!.split("/");
  if (first.length < 2) return ""; // a flat file — nothing to strip
  const top = `${first[0]}/`;
  return paths.every((p) => p.startsWith(top)) ? top : "";
}

/* ------------------------------------------------------------------- build */

/**
 * Build the canonical zip from a plan: inflate/read only the kept files, write
 * each at its `to` path. Returns a File the existing upload path can post as-is.
 */
export async function buildCanonicalZip(
  loaded: LoadedBundle,
  plan: { files: { from: string; to: string }[] },
): Promise<File> {
  const bytes = await loaded.materialize(plan.files.map((f) => f.from));
  const out: Record<string, Uint8Array> = {};
  for (const f of plan.files) {
    const data = bytes.get(f.from);
    if (data) out[f.to] = data;
  }
  const zipped = zipSync(out, { level: 4 });
  return new File([zipped], "bundle.zip", { type: "application/zip" });
}
