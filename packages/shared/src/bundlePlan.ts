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
 * Root detection is a set of **weighted signals**, not a chain of conditions
 * (ADR-0038 decision 3): each heuristic scores a candidate root and explains
 * itself in a `because` string, which is the same text the SPA's confirm step
 * renders. Scoring runs in a single linear pass over the files (ADR-0038 #1) —
 * per-root aggregates accumulated by ancestor directory — so a huge archive
 * can't turn detection quadratic.
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

export type DropReason = "junk" | "outside-root" | "unsupported-type" | "secret" | "unsafe-path";

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

/** Matches `.html` and `.htm`, case-insensitively — the lint and the offline gate rely on it. */
const HTML_RE = /\.html?$/i;

/**
 * A path that could escape the bundle root or name a non-relative location —
 * mirrors the server's `normalizeEntryPath` (`apps/portal/src/deploy/validate.ts`).
 * Such an entry must never reach the rebuilt zip: the SPA would otherwise construct
 * a zip-slip archive the server then rejects, having promised a clean deploy.
 */
function isUnsafePath(p: string): boolean {
  if (p.includes("\0") || p.includes("\\")) return true; // null byte / windows sep
  if (p.startsWith("/")) return true; // absolute
  if (/^[a-zA-Z]:/.test(p)) return true; // drive letter
  return p.split("/").some((seg) => seg === ".."); // traversal
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

/* -------------------------------------------------------------- the planner */

const DECLARED_DIR_BONUS = 100;
/** Two candidates within this margin of the top score are a genuine toss-up. */
const AMBIGUITY_MARGIN = 12;
/** Only the top-scoring candidates get the (costlier) reference lint. */
const REF_LINT_CANDIDATES = 8;

/** Per-root aggregates, accumulated in one linear pass over the kept files. */
interface RootAgg {
  count: number;
  serveable: number;
  hashed: boolean;
  sourceExt: boolean;
  /** A `package.json`/config sits *directly* here. */
  projectArtifact: boolean;
  /** An `index.html` sits *directly* here. */
  hasIndex: boolean;
}

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
    } else if (isUnsafePath(entry.path)) {
      // Traversal / absolute paths never reach the rebuilt bundle (ADR-0038 #7).
      drops.push({ path: entry.path, reason: "unsafe-path" });
    } else {
      kept.push(entry);
    }
  }

  if (kept.length === 0) {
    problems.push({ kind: "no-index" });
    return { outcome: "unsalvageable", root: "", files: [], drops, candidates: [], problems };
  }

  const declaredRoot = resolveDeclaredRoot(kept, ctx.declaredDir);
  // Roots with a *direct* index.html, so we can both find serveable roots and
  // refuse to re-root *into* a subdirectory that would drop a site above it.
  const rootsWithIndex = new Set(
    kept
      .filter((e) => basename(e.path) === "index.html")
      .map((e) => e.path.slice(0, e.path.length - "index.html".length)),
  );
  const candidates = rankCandidates(kept, declaredRoot, htmlText);

  // An explicit user choice (the confirm step's "use this folder") wins outright.
  if (ctx.forceRoot !== undefined) {
    return planForcedRoot(
      kept,
      ctx.forceRoot,
      ctx.offlineScope,
      candidates,
      drops,
      problems,
      htmlText,
    );
  }

  // Offline apps pin (or nest under) their granted scope rather than obeying the
  // signal table (ADR-0038 §11) — handled before the generic path.
  if (ctx.offlineScope) {
    return planOffline(kept, ctx.offlineScope, candidates, drops, problems, htmlText);
  }

  // A candidate that sits *below* a root which already has an index.html is not a
  // re-root target — choosing it would silently drop that ancestor's index and
  // everything beside it (ADR-0038 #6). The declared build dir is always allowed.
  const disqualified = (root: string): boolean => {
    if (root === declaredRoot) return false;
    for (const withIndex of rootsWithIndex) {
      if (withIndex !== root && root.startsWith(withIndex)) return true;
    }
    return false;
  };
  const viable = candidates.filter((c) => !disqualified(c.root));

  const best = viable[0];
  if (!best || !rootsWithIndex.has(best.root)) {
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

  // A genuine toss-up needs the runner-up to be a *disjoint* subtree — a plain
  // multi-page site (root index + `about/`) is not ambiguous, it's canonical.
  const second = viable[1];
  if (
    second &&
    best.score - second.score < AMBIGUITY_MARGIN &&
    isDisjoint(best.root, second.root)
  ) {
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

/** Whether two roots are unrelated subtrees (neither is an ancestor of the other). */
function isDisjoint(a: string, b: string): boolean {
  return !a.startsWith(b) && !b.startsWith(a);
}

/**
 * The confirm step's "use this folder instead" (ADR-0038 #5/#8). The user's root
 * wins, but it must still hold a servable index; and for an offline app the chosen
 * build nests under the granted scope rather than un-nesting it.
 */
function planForcedRoot(
  kept: BundleEntry[],
  root: string,
  offlineScope: string | undefined,
  candidates: ScoredCandidate[],
  drops: { path: string; reason: DropReason }[],
  problems: Problem[],
  htmlText?: (path: string) => string | undefined,
): BundlePlan {
  const { files, extraDrops } = split(kept, root, htmlText, problems);
  const allDrops = [...drops, ...extraDrops];

  if (!hasIndex(kept, root)) {
    problems.push({ kind: "no-index" });
    return { outcome: "unsalvageable", root, files, drops: allDrops, candidates, problems };
  }

  if (offlineScope) {
    const scopeDir = offlineScope.replace(/^\//, "");
    const nested = files.map((f) =>
      f.to.startsWith(scopeDir) ? f : { ...f, to: `${scopeDir}${f.to}` },
    );
    return { outcome: "nested", root, files: nested, drops: allDrops, candidates, problems };
  }

  const outcome: Outcome = root === "" && allDrops.length === 0 ? "canonical" : "rerooted";
  return { outcome, root, files, drops: allDrops, candidates, problems };
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

/**
 * Build and score every candidate root, best-first — **linear** in the number of
 * files (ADR-0038 #1). One pass accumulates per-root aggregates keyed by each
 * file's ancestor directories; scoring reads the counters. The reference lint,
 * the one candidate-relative signal, runs only on the top few candidates.
 */
function rankCandidates(
  kept: BundleEntry[],
  declaredRoot: string | undefined,
  htmlText?: (path: string) => string | undefined,
): ScoredCandidate[] {
  const agg = new Map<string, RootAgg>();
  const at = (root: string): RootAgg => {
    let a = agg.get(root);
    if (!a) {
      a = {
        count: 0,
        serveable: 0,
        hashed: false,
        sourceExt: false,
        projectArtifact: false,
        hasIndex: false,
      };
      agg.set(root, a);
    }
    return a;
  };
  at(""); // the archive root is always a candidate

  const tops = new Set<string>();
  for (const e of kept) {
    const base = basename(e.path);
    const ext = extname(e.path);
    const serveable = SERVEABLE_EXTENSIONS.has(ext);
    const hashed = looksHashed(base);
    const source = SOURCE_EXTENSIONS.has(ext);
    const top = segments(e.path)[0];
    if (top && e.path.includes("/")) tops.add(top);

    // Breadth signals apply to every ancestor root (incl. the archive root).
    for (const root of ["", ...ancestorDirs(e.path)]) {
      const a = at(root);
      a.count++;
      if (serveable) a.serveable++;
      if (hashed) a.hashed = true;
      if (source) a.sourceExt = true;
    }
    // Direct-child signals apply only to the file's immediate parent.
    const parent = e.path.includes("/") ? `${dirname(e.path)}/` : "";
    const p = at(parent);
    if (base === "index.html") p.hasIndex = true;
    if (isProjectArtifact(base)) p.projectArtifact = true;
  }

  const scored: ScoredCandidate[] = [];
  for (const [root, a] of agg) {
    if (a.count === 0) continue;
    let score = 0;
    const because: string[] = [];
    if (a.hasIndex) {
      score += 40;
      because.push("has an index.html at its root");
    }
    const last = segments(root).at(-1);
    if (last && BUILD_DIR_NAMES.has(last)) {
      score += 30;
      because.push(`is a conventional build directory (\`${last}/\`)`);
    }
    if (root !== "" && tops.size === 1 && segments(root).length === 1) {
      score += 20;
      because.push("is the archive's only top-level folder");
    }
    if (a.hashed) {
      score += 15;
      because.push("contains content-hashed build assets");
    }
    if (a.projectArtifact) {
      score -= 50;
      because.push("holds project files (package.json/config) — looks like a source root");
    }
    if (a.sourceExt) {
      score -= 15;
      because.push("contains source files that a build would have compiled away");
    }
    const share = a.serveable / a.count;
    score += Math.round(share * 10);
    because.push(`${Math.round(share * 100)}% of its files are serveable`);
    if (declaredRoot !== undefined && root === declaredRoot) {
      score += DECLARED_DIR_BONUS;
      because.unshift("named as the build directory in helix.json");
    }
    scored.push({ root, score, because });
  }
  scored.sort((a, b) => b.score - a.score);

  // Reference lint (candidate-relative, so not part of the aggregate pass): apply
  // the penalty to only the strongest candidates, then re-sort. Bounded by
  // REF_LINT_CANDIDATES × (files + html·refs).
  if (htmlText) {
    const htmlEntries = kept.filter((e) => HTML_RE.test(e.path));
    for (const cand of scored.slice(0, REF_LINT_CANDIDATES)) {
      const present = new Set(
        kept
          .filter((e) => e.path.startsWith(cand.root) && e.path.length > cand.root.length)
          .map((e) => e.path.slice(cand.root.length)),
      );
      let broken = 0;
      for (const h of htmlEntries) {
        if (!(h.path.startsWith(cand.root) && h.path.length > cand.root.length)) continue;
        broken += missingRefCount(h.path.slice(cand.root.length), present, htmlText(h.path));
      }
      if (broken > 0) {
        cand.score -= 25;
        cand.because.push(`references ${broken} file(s) it doesn't contain`);
      }
    }
    scored.sort((a, b) => b.score - a.score);
  }
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
    const present = new Set(rootFiles.map((f) => f.rel));
    for (const f of rootFiles.filter((f) => HTML_RE.test(f.rel))) {
      for (const ref of missingRefs(f.rel, present, htmlText(f.path))) {
        problems.push({ kind: "missing-reference", file: f.rel, ref });
      }
    }
  }
  return { files, extraDrops };
}

/**
 * Local references in an HTML file (given as `relFile` within a candidate root)
 * that don't resolve to a member of `present` (the candidate's root-relative
 * file set). Shallow regex, same posture as the CSP lint — not a parser.
 */
function missingRefs(relFile: string, present: Set<string>, text: string | undefined): string[] {
  if (text === undefined) return [];
  const misses: string[] = [];
  const seen = new Set<string>();
  for (const re of [HTML_REF_RE, CSS_URL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const ref = m[1]!;
      if (!isLocalRef(ref) || seen.has(ref)) continue;
      seen.add(ref);
      if (!present.has(resolveRef(relFile, ref))) misses.push(ref);
    }
  }
  return misses;
}

/** Count of an HTML file's local references that resolve to nothing in `present`. */
function missingRefCount(relFile: string, present: Set<string>, text: string | undefined): number {
  return missingRefs(relFile, present, text).length;
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
  for (const e of kept.filter((f) => HTML_RE.test(f.path))) {
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
