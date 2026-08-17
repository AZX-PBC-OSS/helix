/**
 * The bundle-layout planner (ADR-0038).
 *
 * A **pure** function over a flat list of `{ path, bytes }` entries that decides
 * what an uploaded archive *should* have contained: which directory is the real
 * build root, what to drop (macOS junk, source, secrets), and whether the result
 * is trustworthy enough to ship without asking the user. It computes a plan; it
 * performs no I/O and reads no file bytes, so it runs identically in the browser
 * SPA (which re-zips against the plan), in the portal (which turns it into a
 * human error message on the failure path), and in tests.
 *
 * Deliberately **browser-safe**: no `Buffer`, no `node:*`. It is reachable via
 * the `@azx-pbc/shared/bundlePlan` subpath and is *not* re-exported from the
 * package barrel (which the SPA imports) only to keep the barrel's surface
 * honest — this module has no node dependency and could be.
 *
 * Root detection is a **weighted signal table**, not a chain of conditions
 * (ADR-0038 decision 3): every heuristic is one row that scores a candidate and
 * explains itself in a `because` string, which is the same text the SPA's
 * confirm step renders. Adding a newly-observed bad shape means adding a row.
 */

/**
 * Planner revision, stamped into the deploy report (ADR-0038). Bump when the
 * scoring or outcomes change materially, so an old stored report stays readable.
 */
export const PLANNER_VERSION = 1;

/** One regular file in an uploaded archive. Directories are implied by paths. */
export interface BundleEntry {
  /** Posix, archive-relative, no leading slash. */
  path: string;
  /** Uncompressed size in bytes (declared sizes are fine — used only for display). */
  bytes: number;
}

/** What the planner knows about the target app, beyond the archive itself. */
export interface PlanContext {
  /**
   * The `dir` value from a `helix.json` / `azx.json` the uploader read, if any.
   * Resolved against the config file's own location (which the planner finds in
   * the entry list), so `"dist"` beside `foo/helix.json` means `foo/dist/`.
   */
  declaredDir?: string;
  /**
   * The app's granted offline service-worker scope (e.g. `"/app/"`), from its
   * manifest. When set, the build legitimately nests under it and the planner
   * pins the root there rather than stripping it (ADR-0035, ADR-0038 §11).
   */
  offlineScope?: string;
  /**
   * Override root detection with a caller-chosen candidate (the confirm step's
   * "use this folder instead"). Bypasses scoring and the offline path — the user
   * has spoken. Files under it are kept, everything else dropped.
   */
  forceRoot?: string;
}

export type DropReason = "junk" | "outside-root" | "unsupported-type" | "secret";

export type Outcome = "canonical" | "rerooted" | "nested" | "ambiguous" | "unsalvageable";

export type Problem =
  | { kind: "missing-reference"; file: string; ref: string }
  | { kind: "secret-dropped"; path: string }
  | { kind: "no-index" }
  | { kind: "scope-mismatch"; scope: string };

/** A candidate root and why it scored the way it did (best-first in the plan). */
export interface ScoredCandidate {
  /** Archive-relative prefix ending in `/`, or `""` for the archive root. */
  root: string;
  score: number;
  /** User-facing justifications, one per signal that had an opinion. */
  because: string[];
}

export interface PlannedFile {
  /** Original archive path. */
  from: string;
  /** Canonical bundle-relative path the upload should carry. */
  to: string;
  bytes: number;
}

export interface BundlePlan {
  outcome: Outcome;
  /** The chosen root (`""` = archive root). */
  root: string;
  /** Files to keep, already mapped to their canonical `to` path. */
  files: PlannedFile[];
  drops: { path: string; reason: DropReason }[];
  /** Ranked candidate roots, best first — the confirm step's alternatives. */
  candidates: ScoredCandidate[];
  problems: Problem[];
}

/* ------------------------------------------------------------------ paths */

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/** Every directory prefix of a file path, each ending in `/`. `a/b/c.js` → `a/`, `a/b/`. */
function ancestorDirs(path: string): string[] {
  const parts = segments(dirname(path));
  const dirs: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc += `${part}/`;
    dirs.push(acc);
  }
  return dirs;
}

/* ------------------------------------------------------------------ junk */

/**
 * Metadata and workspace debris that is never app content and is dropped before
 * anything is scored or counted (ADR-0038 decision 5). `.env*` is dropped too,
 * but reported separately as a secret so the UI can shout about it.
 */
function junkReason(path: string): DropReason | null {
  const base = basename(path);
  const segs = segments(path);
  if (segs.includes("__MACOSX")) return "junk";
  if (segs.includes("node_modules")) return "junk";
  if (segs.includes(".git")) return "junk";
  if (base.startsWith("._")) return "junk"; // AppleDouble sidecar
  if (base === ".DS_Store" || base === "Thumbs.db" || base === "desktop.ini") return "junk";
  if (base === ".env" || base.startsWith(".env.")) return "secret";
  return null;
}

/* -------------------------------------------------------------- allowlists */

/**
 * Extensions the edge will serve. Mirrors the keys of the server's mime
 * allowlist (`apps/portal/src/deploy/mime.ts`) — the deny-by-default enforcement
 * list stays there; this copy only decides what the planner drops as
 * unserveable so the preview matches what the server would accept. If the two
 * drift, the SPA can promise a deploy the server rejects; folding mime.ts into
 * this package is the durable fix (ADR-0038 consequences) and is deferred.
 */
const SERVEABLE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".txt",
  ".xml",
  ".webmanifest",
  ".wasm",
  ".pdf",
]);

/** Directory names that conventionally hold a static build's output. */
const BUILD_DIR_NAMES = new Set(["dist", "build", "out", "public", "_site", "www"]);

/** Extensions that only appear in a *source* tree, never a built static bundle. */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".jsx",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
]);

/** Filenames that mark a project/source root rather than a build output. */
const PROJECT_ARTIFACT_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
]);

function isProjectArtifact(name: string): boolean {
  return (
    PROJECT_ARTIFACT_NAMES.has(name) ||
    /^vite\.config\.|^webpack\.config\.|^rollup\.config\./.test(name)
  );
}

/** A build tool's content-hashed asset name, e.g. `index-4f3a1b2c.js`. */
function looksHashed(name: string): boolean {
  return /[.-][0-9a-f]{8,}\.(js|css)$/i.test(name);
}

/* --------------------------------------------------------- reference lint */

const HTML_REF_RE = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

/** Whether a referenced URL points inside the bundle (vs. external / data / anchor). */
function isLocalRef(ref: string): boolean {
  if (ref === "" || ref.startsWith("#") || ref.startsWith("?")) return false;
  if (ref.startsWith("data:") || ref.startsWith("mailto:") || ref.startsWith("tel:")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false; // has a scheme → external
  if (ref.startsWith("//")) return false; // protocol-relative → external
  return true;
}

/** Resolve a local ref against the file that contains it, returning a bundle-relative path. */
function resolveRef(fromFile: string, ref: string): string {
  const clean = ref.split("#")[0]!.split("?")[0]!;
  if (clean.startsWith("/")) return clean.slice(1); // root-absolute → from bundle root
  const base = segments(dirname(fromFile));
  for (const part of clean.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

/* ----------------------------------------------------------- signal table */

interface Candidate {
  root: string;
  /** Non-junk files under this root, mapped to their root-relative names. */
  files: { path: string; rel: string; bytes: number }[];
}

interface Signal {
  id: string;
  evaluate: (c: Candidate, all: BundleEntry[]) => { delta: number; because: string } | null;
}

const SIGNALS: Signal[] = [
  {
    id: "hasIndexHtml",
    evaluate: (c) =>
      c.files.some((f) => f.rel === "index.html")
        ? { delta: 40, because: "has an index.html at its root" }
        : null,
  },
  {
    id: "buildDirName",
    evaluate: (c) => {
      const last = segments(c.root).at(-1);
      return last && BUILD_DIR_NAMES.has(last)
        ? { delta: 30, because: `is a conventional build directory (\`${last}/\`)` }
        : null;
    },
  },
  {
    id: "singleWrapper",
    evaluate: (c, all) => {
      if (c.root === "") return null;
      const tops = new Set(all.map((e) => segments(e.path)[0]).filter(Boolean));
      const rootTop = segments(c.root)[0];
      return tops.size === 1 && segments(c.root).length === 1 && rootTop
        ? { delta: 20, because: "is the archive's only top-level folder" }
        : null;
    },
  },
  {
    id: "hashedAssets",
    evaluate: (c) =>
      c.files.some((f) => looksHashed(basename(f.rel)))
        ? { delta: 15, because: "contains content-hashed build assets" }
        : null,
  },
  {
    id: "projectArtifacts",
    evaluate: (c) =>
      c.files.some((f) => !f.rel.includes("/") && isProjectArtifact(f.rel))
        ? {
            delta: -50,
            because: "holds project files (package.json/config) — looks like a source root",
          }
        : null,
  },
  {
    id: "sourceExtensions",
    evaluate: (c) =>
      c.files.some((f) => SOURCE_EXTENSIONS.has(extname(f.rel)))
        ? { delta: -15, because: "contains source files that a build would have compiled away" }
        : null,
  },
  {
    id: "serveableShare",
    evaluate: (c) => {
      if (c.files.length === 0) return null;
      const serveable = c.files.filter((f) => SERVEABLE_EXTENSIONS.has(extname(f.rel))).length;
      const share = serveable / c.files.length;
      return {
        delta: Math.round(share * 10),
        because: `${Math.round(share * 100)}% of its files are serveable`,
      };
    },
  },
];

/* -------------------------------------------------------------- the planner */

const DECLARED_DIR_BONUS = 100;
/** Two candidates within this margin of the top score are a genuine toss-up. */
const AMBIGUITY_MARGIN = 12;

/**
 * Plan the canonical layout of an uploaded archive. Pure: same input, same plan.
 *
 * `htmlText` is an optional lookup from a bundle path to that file's decoded
 * text, used only for the reference-resolution lint (the SPA has the bytes; the
 * server's failure-path diagnosis does not and passes nothing). Absent it, the
 * ref lint simply contributes no signal.
 */
export function planBundle(
  entries: BundleEntry[],
  ctx: PlanContext = {},
  htmlText?: (path: string) => string | undefined,
): BundlePlan {
  const drops: { path: string; reason: DropReason }[] = [];
  const problems: Problem[] = [];
  const kept: BundleEntry[] = [];

  for (const entry of entries) {
    const junk = junkReason(entry.path);
    if (junk === "secret") {
      drops.push({ path: entry.path, reason: "secret" });
      problems.push({ kind: "secret-dropped", path: entry.path });
    } else if (junk) {
      drops.push({ path: entry.path, reason: junk });
    } else {
      kept.push(entry);
    }
  }

  if (kept.length === 0) {
    problems.push({ kind: "no-index" });
    return { outcome: "unsalvageable", root: "", files: [], drops, candidates: [], problems };
  }

  const declaredRoot = resolveDeclaredRoot(kept, ctx.declaredDir);
  const candidates = rankCandidates(kept, declaredRoot, htmlText);

  // An explicit user choice (the confirm step's "use this folder") wins outright.
  if (ctx.forceRoot !== undefined) {
    const { files, extraDrops } = split(kept, ctx.forceRoot, htmlText, problems);
    if (!hasIndex(kept, ctx.forceRoot)) problems.push({ kind: "no-index" });
    const allDrops = [...drops, ...extraDrops];
    const outcome: Outcome =
      ctx.forceRoot === "" && allDrops.length === 0 ? "canonical" : "rerooted";
    return { outcome, root: ctx.forceRoot, files, drops: allDrops, candidates, problems };
  }

  // Offline apps pin (or nest under) their granted scope rather than obeying the
  // signal table (ADR-0038 §11) — handled before the generic path.
  if (ctx.offlineScope) {
    return planOffline(kept, ctx.offlineScope, candidates, drops, problems, htmlText);
  }

  const best = candidates[0];
  if (!best || !hasIndex(kept, best.root)) {
    problems.push({ kind: "no-index" });
    return {
      outcome: "unsalvageable",
      root: best?.root ?? "",
      files: [],
      drops,
      candidates,
      problems,
    };
  }

  const second = candidates[1];
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    // A real toss-up: keep the best root's files so an upload-as-is is still
    // possible, but flag it so the SPA asks the user to choose.
    const { files, extraDrops } = split(kept, best.root, htmlText, problems);
    return {
      outcome: "ambiguous",
      root: best.root,
      files,
      drops: [...drops, ...extraDrops],
      candidates,
      problems,
    };
  }

  const { files, extraDrops } = split(kept, best.root, htmlText, problems);
  const allDrops = [...drops, ...extraDrops];
  const outcome: Outcome = best.root === "" && allDrops.length === 0 ? "canonical" : "rerooted";
  return { outcome, root: best.root, files, drops: allDrops, candidates, problems };
}

/** Resolve `declaredDir` against the location of a config file in the archive. */
function resolveDeclaredRoot(
  kept: BundleEntry[],
  declaredDir: string | undefined,
): string | undefined {
  if (!declaredDir) return undefined;
  const config = kept.find((e) => {
    const b = basename(e.path);
    return b === "helix.json" || b === "azx.json";
  });
  if (!config) return undefined;
  const base = segments(dirname(config.path));
  for (const part of declaredDir.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.length ? `${base.join("/")}/` : "";
}

/** Whether an `index.html` sits directly at the given root. */
function hasIndex(kept: BundleEntry[], root: string): boolean {
  return kept.some((e) => e.path === `${root}index.html`);
}

/** Build and score every candidate root, best-first. */
function rankCandidates(
  kept: BundleEntry[],
  declaredRoot: string | undefined,
  htmlText?: (path: string) => string | undefined,
): ScoredCandidate[] {
  const roots = new Set<string>([""]);
  for (const e of kept) for (const d of ancestorDirs(e.path)) roots.add(d);

  const scored: ScoredCandidate[] = [];
  for (const root of roots) {
    const files = kept
      .filter((e) => e.path.startsWith(root) && e.path.length > root.length)
      .map((e) => ({ path: e.path, rel: e.path.slice(root.length), bytes: e.bytes }))
      // Only files *directly or nested* under root, but not those re-nested in a
      // deeper candidate we also consider — every file belongs to every ancestor
      // root, which is what lets a parent score on breadth and a child on focus.
      .filter((f) => f.rel !== "");
    if (files.length === 0) continue;
    const candidate: Candidate = { root, files };
    let score = 0;
    const because: string[] = [];
    for (const signal of SIGNALS) {
      const hit = signal.evaluate(candidate, kept);
      if (hit) {
        score += hit.delta;
        because.push(hit.because);
      }
    }
    if (declaredRoot !== undefined && root === declaredRoot) {
      score += DECLARED_DIR_BONUS;
      because.unshift("named as the build directory in helix.json");
    }
    // The reference lint needs file text; fold it in when available.
    if (htmlText) {
      const refMiss = candidate.files
        .filter((f) => f.rel.endsWith(".html"))
        .flatMap((f) => scanMissingRefs(f, candidate, htmlText));
      if (refMiss.length > 0) {
        score -= 25;
        because.push(`references ${refMiss.length} file(s) it doesn't contain`);
      }
    }
    scored.push({ root, score, because });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Partition kept files into those under `root` (mapped to `to`) and the rest (dropped). */
function split(
  kept: BundleEntry[],
  root: string,
  htmlText: ((path: string) => string | undefined) | undefined,
  problems: Problem[],
): { files: PlannedFile[]; extraDrops: { path: string; reason: DropReason }[] } {
  const files: PlannedFile[] = [];
  const extraDrops: { path: string; reason: DropReason }[] = [];
  const rootFiles: { path: string; rel: string; bytes: number }[] = [];

  for (const e of kept) {
    if (!(e.path.startsWith(root) && e.path.length > root.length)) {
      extraDrops.push({ path: e.path, reason: "outside-root" });
      continue;
    }
    const rel = e.path.slice(root.length);
    if (!SERVEABLE_EXTENSIONS.has(extname(rel))) {
      extraDrops.push({ path: e.path, reason: "unsupported-type" });
      continue;
    }
    rootFiles.push({ path: e.path, rel, bytes: e.bytes });
  }

  for (const f of rootFiles) files.push({ from: f.path, to: f.rel, bytes: f.bytes });

  // Surface broken references within the chosen root as warnings.
  if (htmlText) {
    const candidate: Candidate = { root, files: rootFiles };
    for (const f of rootFiles.filter((f) => f.rel.endsWith(".html"))) {
      for (const miss of scanMissingRefs(f, candidate, htmlText)) {
        problems.push({ kind: "missing-reference", file: f.rel, ref: miss.ref });
      }
    }
  }
  return { files, extraDrops };
}

/** Local references in `file` that don't resolve to a sibling in the candidate. */
function scanMissingRefs(
  file: { path: string; rel: string },
  c: Candidate,
  htmlText: (path: string) => string | undefined,
): { ref: string }[] {
  const text = htmlText(file.path);
  if (text === undefined) return [];
  const present = new Set(c.files.map((f) => f.rel));
  const misses: { ref: string }[] = [];
  const seen = new Set<string>();
  for (const re of [HTML_REF_RE, CSS_URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const ref = m[1]!;
      if (!isLocalRef(ref) || seen.has(ref)) continue;
      seen.add(ref);
      const resolved = resolveRef(file.rel, ref);
      if (!present.has(resolved)) misses.push({ ref });
    }
  }
  return misses;
}

/**
 * Offline apps (ADR-0035, ADR-0038 §11). The build legitimately nests under the
 * granted `scope`, so the planner **pins** the root there instead of stripping
 * it. When the upload doesn't match — a root-level build with nothing at the
 * scope — it offers to nest, but only when that is provably safe.
 */
function planOffline(
  kept: BundleEntry[],
  scope: string,
  candidates: ScoredCandidate[],
  drops: { path: string; reason: DropReason }[],
  problems: Problem[],
  htmlText?: (path: string) => string | undefined,
): BundlePlan {
  const scopeDir = scope.replace(/^\//, ""); // "/app/" → "app/"

  // Find the root R such that `R + scopeDir + index.html` exists: that root is
  // correct as-is (the scope directory is part of what's served).
  const pinned = ["", ...candidates.map((c) => c.root)].find((root) =>
    kept.some((e) => e.path === `${root}${scopeDir}index.html`),
  );
  if (pinned !== undefined) {
    const { files, extraDrops } = split(kept, pinned, htmlText, problems);
    const allDrops = [...drops, ...extraDrops];
    const outcome: Outcome = pinned === "" && allDrops.length === 0 ? "canonical" : "rerooted";
    return { outcome, root: pinned, files, drops: allDrops, candidates, problems };
  }

  // No scope directory anywhere. Can we nest a root-level build under it? Only if
  // nothing already occupies the scope and every reference is relative (a
  // root-absolute ref would break once the document moves under the prefix).
  const rootHasIndex = hasIndex(kept, "");
  const anythingAtScope = kept.some((e) => e.path.startsWith(scopeDir));
  const rootAbsoluteRefs = htmlText ? hasRootAbsoluteRefs(kept, htmlText) : false;

  if (rootHasIndex && !anythingAtScope && !rootAbsoluteRefs) {
    const { files, extraDrops } = split(kept, "", htmlText, problems);
    const nested = files.map((f) => ({ ...f, to: `${scopeDir}${f.to}` }));
    return {
      outcome: "nested",
      root: "",
      files: nested,
      drops: [...drops, ...extraDrops],
      candidates,
      problems,
    };
  }

  problems.push({ kind: "scope-mismatch", scope });
  const { files, extraDrops } = split(kept, "", htmlText, problems);
  return {
    outcome: "ambiguous",
    root: "",
    files,
    drops: [...drops, ...extraDrops],
    candidates,
    problems,
  };
}

/** Whether any html file references a root-absolute local path (`/assets/…`). */
function hasRootAbsoluteRefs(
  kept: BundleEntry[],
  htmlText: (path: string) => string | undefined,
): boolean {
  for (const e of kept.filter((f) => f.path.endsWith(".html"))) {
    const text = htmlText(e.path);
    if (text === undefined) continue;
    for (const re of [HTML_REF_RE, CSS_URL_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const ref = m[1]!;
        if (isLocalRef(ref) && ref.startsWith("/")) return true;
      }
    }
  }
  return false;
}
