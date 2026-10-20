import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The production image packaging contracts, pinned statically. There is no
 * container runtime in the environment the suite runs in, so the artifact
 * cannot be built here (CI's image lane builds and checks the built
 * artifact); what CAN fail silently before any build is the wiring between
 * the files the image is made of, and that is what these pins hold:
 *
 * - The `start` script is the image CMD's target — it must exist, and it
 *   must run the server through the tsx LOADER (`node --import tsx`), not
 *   the tsx CLI, whose own SIGTERM handler would defeat the graceful
 *   shutdown drain (packages/shared/src/lifecycle.ts). Pinned by identity
 *   with the sibling services' start scripts, so the convention cannot
 *   drift on one service alone.
 * - The Dockerfile agrees with the package it packages: the CMD is the
 *   start script's exact command run directly (node as the container's init
 *   process, so the runtime's SIGTERM reaches the service's own drain); the
 *   install filter and the package name are one name; the listening
 *   port, the dev fallback and EXPOSE are one port; the base image matches
 *   the sibling services and the prepared pnpm matches the root
 *   `packageManager`.
 * - `build-images.sh` — the local image-build entry point — builds the jobs
 *   image by default and maps the name to this Dockerfile and repo.
 * - The build context cannot carry credentials or test/synthetic code into
 *   the image: the root `.dockerignore` excludes the env files and the
 *   tests, and the Dockerfile bakes in no credential-shaped ENV/ARG.
 * - The runtime dependency closure is closed: the image installs only
 *   `--filter @azx-pbc/jobs...`, so every non-relative import in the
 *   sources the runtime loads — the package's own production sources and
 *   every shipped workspace package's (loaded as raw TS) — must resolve
 *   inside that closure or the image crashes at boot while the full dev
 *   workspace typechecks and tests green.
 * - The four app images build from one base image — the runtime base (and
 *   with it the platform's Node 24 floor) is a shared deployment decision,
 *   pinned across the siblings rather than on the jobs image alone.
 */

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(PACKAGE_DIR, "../..");

function readRepo(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

interface PkgJson {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readPackage(relativePath: string): PkgJson {
  return JSON.parse(readRepo(relativePath)) as PkgJson;
}

function lines(text: string, pattern: RegExp): string[] {
  return text.split("\n").filter((line) => pattern.test(line));
}

describe("the production start script (the image CMD's target)", () => {
  const START_SCRIPT = "node --import tsx src/server.ts";

  it("runs the server through the tsx loader, like every sibling service", () => {
    expect(readPackage("apps/jobs/package.json").scripts?.start).toBe(START_SCRIPT);
    // Identity with the siblings is the pin: the loader-vs-CLI distinction is
    // load-bearing (the CLI exits 143 on SIGTERM and defeats the drain), and
    // a well-meant "cleanup" that flips one service to the CLI form must go
    // red here rather than surface as a shutdown that stops draining.
    expect(readPackage("apps/edge/package.json").scripts?.start).toBe(START_SCRIPT);
    expect(readPackage("apps/egress/package.json").scripts?.start).toBe(START_SCRIPT);
    expect(readPackage("apps/portal/package.json").scripts?.start).toBe(START_SCRIPT);
  });

  it("keeps db:migrate the separately executed migration path the image documents", () => {
    // The image bakes in no migration identity and the Dockerfile header
    // names this command as the migrations' only path (design §8): the
    // runtime image never migrates, so the separately executed
    // `pnpm --filter @azx-pbc/jobs db:migrate` is the contract's other half.
    // A rename of the script or a loss of its target file would break that
    // documented operator path with the start-script pin still green.
    const scripts = readPackage("apps/jobs/package.json").scripts ?? {};
    expect(scripts["db:migrate"]).toBe("node --import tsx src/migrate.ts");
    expect(existsSync(path.join(PACKAGE_DIR, "src", "migrate.ts"))).toBe(true);
  });
});

describe("the jobs Dockerfile agrees with the package it packages", () => {
  const dockerfile = readRepo("apps/jobs/Dockerfile");
  const jobs = readPackage("apps/jobs/package.json");

  it("runs the service directly as the container's init process", () => {
    // The CMD is the start script's exact command, run directly: node is the
    // container's pid 1, so the runtime's SIGTERM reaches the service's own
    // signal handling and the graceful-shutdown drain runs. A `pnpm … start`
    // wrapper would be pid 1 instead, and pnpm 11 does not forward SIGTERM to
    // its script (observed: the grandchild keeps serving after the signal) —
    // the drain would never run and the runtime would SIGKILL the service.
    const cmdLine = lines(dockerfile, /^CMD /).at(-1);
    expect(cmdLine, "the Dockerfile declares exactly one runtime CMD").toBeDefined();
    const cmd = JSON.parse((cmdLine as string).replace(/^CMD /, "")) as string[];
    expect(cmd).toEqual(jobs.scripts?.start?.split(" "));

    // Docker composes ENTRYPOINT + CMD into one argv, so an ENTRYPOINT line
    // would slip a wrapper between pid 1 and node while this CMD pin stays
    // green — `ENTRYPOINT ["pnpm", "exec"]` restores the SIGTERM-swallowing
    // shape, still booting and serving. The CMD is the container's whole
    // command; no entrypoint may precede it.
    expect(lines(dockerfile, /^ENTRYPOINT /), "the Dockerfile declares an ENTRYPOINT").toEqual([]);

    const workdir = lines(dockerfile, /^WORKDIR /).at(-1);
    expect(workdir).toBe("WORKDIR /app/apps/jobs");
  });

  it("installs exactly the package's dependency closure, from the frozen lockfile", () => {
    const install = lines(dockerfile, /^RUN pnpm install /).at(-1);
    expect(install).toBe(`RUN pnpm install --frozen-lockfile --filter ${jobs.name}...`);
  });

  it("runs as the non-root runtime user", () => {
    // The runtime stage's USER is what the container starts as — an image
    // without it runs its service as root.
    expect(lines(dockerfile, /^USER /)).toEqual(["USER node"]);
  });

  it("exposes the port the service actually resolves by default", () => {
    const exposed = lines(dockerfile, /^EXPOSE /)
      .at(-1)
      ?.replace(/^EXPOSE /, "");
    const devFallback = jobs.scripts?.dev?.match(/JOBS_PORT:-(\d+)/)?.[1];
    expect(exposed).toBeDefined();
    expect(exposed).toBe(devFallback);
  });

  it("copies the built tree to the path the WORKDIR and CMD resolve against", () => {
    // The CMD's relative `src/server.ts` resolves under the runtime stage's
    // WORKDIR, which exists only if the runtime stage copied the tree the
    // build stage prepared to the same root — the COPY chain is the wiring
    // between the two stages, and a drifted source or destination is a boot
    // crash ("Cannot find module") with every other pin green. The build
    // stage also must copy the context at the repo root the build command
    // hands it (the lockfile the frozen install reads rides in that copy).
    expect(lines(dockerfile, /^COPY \. \.$/)).toEqual(["COPY . ."]);
    expect(lines(dockerfile, /^COPY --from=build \/app \/app$/)).toEqual([
      "COPY --from=build /app /app",
    ]);
  });

  it("bakes in no credential-shaped configuration", () => {
    // The service's credentials arrive at run time; nothing secret may have a
    // build-time home. The ENV allowlist is the image's complete set, and no
    // ARG exists at all.
    const envKeys = dockerfile
      .split("\n")
      .map((line) => line.match(/^ENV ([A-Z_]+)=/)?.[1])
      .filter((key) => key !== undefined);
    expect(envKeys).toEqual(["PNPM_HOME", "PATH", "NODE_ENV"]);
    expect(lines(dockerfile, /^ARG /)).toEqual([]);
  });

  it("uses the sibling services' base image and the root packageManager's pnpm", () => {
    // Every FROM is either the sibling base image or a reference to the
    // `base` stage built FROM it — never a different base image.
    const froms = dockerfile
      .split("\n")
      .map((line) => line.match(/^FROM (\S+)/)?.[1])
      .filter((image) => image !== undefined);
    expect(froms.length).toBeGreaterThan(0);
    expect(new Set(froms)).toEqual(new Set(["node:24-bookworm-slim", "base"]));

    const prepared = dockerfile.match(/corepack prepare pnpm@(\d+\.\d+\.\d+) --activate/)?.[1];
    const packageManager = (JSON.parse(readRepo("package.json")) as { packageManager: string })
      .packageManager;
    expect(prepared).toBe(packageManager.replace(/^pnpm@/, ""));
  });
});

describe("the Dockerfile is written in the form the pins above can parse", () => {
  const dockerfile = readRepo("apps/jobs/Dockerfile");

  it("spells every parsed instruction in the canonical uppercase", () => {
    // The pins regex the conventional uppercase spellings, but the Dockerfile
    // grammar is case-insensitive: any other casing of a parsed instruction
    // (`cmd`, `Entrypoint`, `rUn pnpm install`) becomes the image's effective
    // instruction while the pins above (CMD identity, ENV allowlist, USER,
    // EXPOSE, the install filter) stayed green. A line whose first token
    // names one of the parsed instructions in any casing but the canonical
    // uppercase is that evasion, and goes red here.
    const parsed = ["FROM", "ENV", "ARG", "CMD", "USER", "EXPOSE", "WORKDIR", "ENTRYPOINT", "RUN"];
    const evasions = dockerfile.split("\n").filter((line) => {
      const token = line.match(/^\S+/)?.[0] ?? "";
      return parsed.includes(token.toUpperCase()) && !parsed.some((p) => line.startsWith(`${p} `));
    });
    expect(evasions).toEqual([]);
  });

  it("writes every ENV line as one uppercase-key assignment, the only form the allowlist pin sees", () => {
    // The credential allowlist pin captures the key with `^ENV ([A-Z_]+)=`
    // and compares the captured set. Three legal spellings evade that
    // capture and would bake a key in invisibly: a digit in the key
    // (`ENV KEY2=`), the legacy space form (`ENV KEY VALUE`), and several
    // assignments on one line (`ENV A=B C=D`). Every ENV line must be the
    // single canonical assignment form, whose key the allowlist pin always
    // captures.
    const evasions = dockerfile
      .split("\n")
      .filter((line) => /^ENV\s/.test(line) && !/^ENV [A-Z_]+=("[^"]*"|\S*)$/.test(line));
    expect(evasions).toEqual([]);
  });
});

describe("the four app images build from one base image", () => {
  /** The image reference of the first FROM line — the root of the stage graph. */
  function firstFromImage(app: string): string | undefined {
    return readRepo(`apps/${app}/Dockerfile`)
      .split("\n")
      .find((line) => line.startsWith("FROM "))
      ?.replace(/^FROM (\S+).*/, "$1");
  }

  it("every sibling builds from the same base the jobs image pins", () => {
    const jobsBase = firstFromImage("jobs");
    expect(jobsBase).toBe("node:24-bookworm-slim");
    for (const app of ["edge", "portal", "egress"]) {
      expect(firstFromImage(app), `${app}'s Dockerfile builds from a different base image`).toBe(
        jobsBase,
      );
    }
  });
});

describe("the local image-build entry point builds the jobs image", () => {
  const script = readRepo("build-images.sh");

  it("maps the jobs app to this Dockerfile and the helix-jobs repo", () => {
    expect(script).toMatch(/jobs\)\s+echo "apps\/jobs\/Dockerfile\|helix-jobs" ;;/);
  });

  it("builds all four app images when no app is named", () => {
    expect(script).toMatch(/APPS=\(edge portal egress jobs\)/);
  });

  it("names jobs everywhere the other apps are named", () => {
    expect(script).toMatch(/edge\|portal\|egress\|jobs/); // the "just one" usage line
    expect(script).toMatch(/expected edge\|portal\|egress\|jobs/); // the unknown-app refusal
    expect(script).toMatch(/az acr build -r helixprodacr -t helix-jobs:\$TAG/);
  });
});

describe("CI parity for the local entry point", () => {
  /** CI's images matrix, the enforcement the skip banner promises. Fails when the file cannot be read as a matrix. */
  function ciImagesMatrix(): string[] {
    const matrix = readRepo(".github/workflows/ci.yml").match(/app:\s*\[([^\]]*)\]/)?.[1];
    expect(
      matrix,
      "CI's images matrix cannot be parsed — fix this extraction; CI parity is unverified until it reads",
    ).toBeDefined();
    const apps = (matrix as string).split(",").map((app) => app.trim());
    expect(
      apps.length,
      "CI's images matrix parsed to nothing — fix this extraction",
    ).toBeGreaterThan(0);
    return apps;
  }

  it("CI's images matrix does not yet build the jobs image — when it does, un-skip the parity test below and delete this guard", () => {
    // The skipped parity test below is the property; this guard is its only
    // trigger. Nothing else points at the un-skip moment — no comment can be
    // trusted to (nothing reads one), so the reminder lives here, in a test
    // that cannot stay green past the day it matters.
    expect(ciImagesMatrix()).not.toContain("jobs");
  });

  // Skipped because the property is false on today's matrix (watched red by
  // hand: the local entry point builds jobs, the matrix does not). The
  // un-skip instruction is the guard's own failing test name above — a skip
  // with no visible trigger is the shape that matures silently, so the guard
  // is what makes this one arm itself.
  it.skip("builds every default app in CI's images matrix", () => {
    const local = readRepo("build-images.sh").match(/APPS=\(([^)]*)\)/)?.[1];
    expect(
      local,
      "the local entry point's app list cannot be parsed — fix this extraction",
    ).toBeDefined();
    const localApps = (local as string).split(/\s+/);
    expect(
      localApps.length,
      "the local app list parsed to nothing — fix this extraction",
    ).toBeGreaterThan(0);
    const missing = localApps.filter((app) => !ciImagesMatrix().includes(app));
    expect(missing, "the local entry point builds images CI never checks").toEqual([]);
  });
});

describe("the build context cannot carry credentials or test code into the image", () => {
  const dockerignore = readRepo(".dockerignore");

  it("excludes the env files and the tests", () => {
    const patterns = dockerignore.split("\n").map((line) => line.trim());
    // Every image builds from this one context, so these patterns are what
    // keep the runtime image free of credential files (`.env`, and every
    // `.env.<anything>` — the developer-local override files) and of the
    // test/synthetic-fixture code (which production never registers).
    expect(patterns).toContain("**/.env");
    expect(patterns).toContain("**/.env.*");
    expect(patterns).toContain("**/*.test.ts");
  });

  it("never negates the exclusions back in", () => {
    // The pin above only checks that the exclusions are written; a `!`
    // exception line after them re-includes what they removed, and a
    // credential- or test-shaped negation would bake that content back into
    // every image with the presence pin still green. Only security-shaped
    // negations are flagged — an unrelated exception (`!docs/**`) stays legal.
    const negations = dockerignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!") && /\.env|\.test\.|secret/i.test(line));
    expect(negations).toEqual([]);
  });
});

describe("the runtime dependency closure is closed", () => {
  /**
   * The image installs only the jobs package's dependency closure, while the
   * dev workspace typechecks and tests against the full install — so an
   * import outside that closure is a boot crash the image alone shows. The
   * sources the runtime can load are jobs' own production sources plus every
   * workspace package the closure ships (`shared` and `telemetry`, loaded as
   * raw TS): each of their non-relative imports must be a declared dependency
   * (transitively through the closure), and each relative import must stay
   * inside the package that ships it.
   */

  /** Every workspace package by name — the closure walk's only extra nodes. */
  const workspacePackages = new Map<string, string>();
  for (const base of ["packages", "apps"]) {
    for (const entry of readdirSync(path.join(REPO_ROOT, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const pkg = readPackage(path.join(base, entry.name, "package.json"));
        workspacePackages.set(pkg.name, path.posix.join(base, entry.name));
      } catch {
        // A directory without a readable package.json is not a workspace package.
      }
    }
  }

  const jobs = readPackage("apps/jobs/package.json");

  /** The dependency closure the image installs: jobs' deps, then the workspace deps' own dependencies. */
  function runtimeClosure(): Set<string> {
    const allowed = new Set<string>();
    const queue = Object.keys(jobs.dependencies ?? {});
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (allowed.has(name)) continue;
      allowed.add(name);
      const dir = workspacePackages.get(name);
      if (dir === undefined) continue; // a registry package — nothing further to walk
      const pkg = readPackage(path.join(dir, "package.json"));
      queue.push(...Object.keys(pkg.dependencies ?? {}));
    }
    return allowed;
  }

  /** The package roots whose sources the image loads: jobs itself, then every workspace package the closure ships. */
  function shippedPackageRoots(): string[] {
    const roots = ["apps/jobs"];
    for (const name of runtimeClosure()) {
      const dir = workspacePackages.get(name);
      if (dir !== undefined) roots.push(dir);
    }
    return roots;
  }

  /** The shipped packages' production sources — everything the runtime can load, never the tests or their helpers. */
  function productionSources(): { file: string; root: string }[] {
    const roots = shippedPackageRoots();
    const found: { file: string; root: string }[] = [];
    const walk = (root: string, relDir: string): void => {
      for (const entry of readdirSync(path.join(REPO_ROOT, relDir), { withFileTypes: true })) {
        const rel = path.posix.join(relDir, entry.name);
        if (entry.isDirectory()) walk(root, rel);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
          found.push({ file: rel, root });
      }
    };
    for (const root of roots) {
      walk(root, `${root}/src`);
      // The jobs image runs a SECOND loadable entry — the azure migration job's
      // `node --import tsx scripts/migrate-azure.ts` (jobs-migrate-job.bicep) —
      // so its scripts/ sources are runtime surface the closure must cover too.
      if (root === "apps/jobs") walk(root, "apps/jobs/scripts");
    }
    // src/test/ is test infrastructure — imported by the *.test.ts files the
    // image excludes — so it is not production surface.
    return found.filter(({ file }) => !roots.some((root) => file.startsWith(`${root}/src/test/`)));
  }

  /** Every import specifier in one source file, in the ESM forms the codebase writes. */
  function importSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    const patterns = [
      /import\s[^'"()]*?from\s*["']([^"']+)["']/g,
      /export\s[^'"()]*?from\s*["']([^"']+)["']/g,
      /import\s+["']([^"']+)["']/g,
      /import\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        specifiers.push(match[1] as string);
      }
    }
    return specifiers;
  }

  it("every production import resolves inside the image's installed closure", () => {
    const allowed = runtimeClosure();
    const files = productionSources();
    expect(files.length).toBeGreaterThan(0); // the walk found the packages it pins
    // The scan covers the shipped workspace packages too — an empty scan over
    // them would pin nothing.
    expect(
      files.filter(({ file }) => file.startsWith("packages/")).length,
      "the shipped workspace packages' production sources are scanned",
    ).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const { file, root } of files) {
      // The extraction runs over the comment-stripped view — the same view
      // the non-literal-dynamic-import guard scans — because a comment
      // inside `import(...)`'s parentheses (the chunk-name idiom) leaves the
      // raw text without an adjacent quote, hiding a compliant literal from
      // a raw read. The strip-then-extract composition has one home
      // (`specifiersOf` below); the pin and the fixtures drive the same one.
      for (const specifier of specifiersOf(readFileSync(path.join(REPO_ROOT, file), "utf8"))) {
        if (specifier.startsWith(".")) {
          const resolved = path.normalize(path.join(path.dirname(file), specifier));
          if (!resolved.startsWith(`${root}/`)) {
            problems.push(`${file}: ${specifier} escapes the package that ships it (${resolved})`);
          }
          continue;
        }
        const isBuiltin = specifier.startsWith("node:") || builtinModules.includes(specifier);
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : (specifier.split("/")[0] as string);
        if (!isBuiltin && !allowed.has(name)) {
          problems.push(`${file}: "${specifier}" is outside the runtime dependency closure`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  /** The source with comments removed — a quoted `//` or a prose `import(` must not read as code. */
  function withoutComments(source: string): string {
    let out = "";
    let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
    for (let i = 0; i < source.length; ) {
      const ch = source[i] as string;
      const next = source[i + 1];
      if (mode === "code") {
        if (ch === "/" && next === "/") {
          mode = "line";
          i += 2;
        } else if (ch === "/" && next === "*") {
          mode = "block";
          i += 2;
        } else {
          if (ch === "'") mode = "single";
          else if (ch === '"') mode = "double";
          else if (ch === "`") mode = "template";
          out += ch;
          i += 1;
        }
        continue;
      }
      if (mode === "line") {
        if (ch === "\n") {
          mode = "code";
          out += ch;
        }
        i += 1;
        continue;
      }
      if (mode === "block") {
        if (ch === "*" && next === "/") {
          mode = "code";
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      // Inside a string literal: escapes and the closing quote ride through.
      if (ch === "\\") {
        out += ch + (next ?? "");
        i += 2;
        continue;
      }
      if (
        (mode === "single" && ch === "'") ||
        (mode === "double" && ch === '"') ||
        (mode === "template" && ch === "`")
      ) {
        mode = "code";
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  /**
   * THE one extraction composition — strip comments, then extract — and the
   * only view the closure pin consumes. The composition is its own home
   * because the silent regression this file guards against is exactly a
   * view swap at this seam (a pin reading the raw view misses a specifier
   * hidden behind a comment inside the parens). What the fixtures can and
   * cannot see about it: a regression INSIDE (dropping the strip) goes red
   * in the composition leg below; a rewrite of the pin that bypasses this
   * home and re-inlines the two calls changes no function's behavior, so no
   * fixture can catch it — that is a diff a review reads, stated here so
   * nobody believes the fixtures cover more than they do.
   */
  function specifiersOf(source: string): string[] {
    return importSpecifiers(withoutComments(source));
  }

  it("loads no module through a non-literal dynamic specifier", () => {
    // The closure pin's specifier patterns can only see literals; a dynamic
    // import built from a variable, or spelled as a template literal, rides
    // outside the closure with every pin green — the image alone shows it, at
    // boot. An interpolated template (`import(\`./${name}.js\`)`) cannot be
    // resolved at all, and a static one (`import(\`vite\`)`) is invisible to
    // the closure pin's quoted-literal patterns. Every dynamic import in the
    // shipped sources must therefore present a single- or double-quoted
    // literal specifier — anything else after `import(` goes red here.
    const problems: string[] = [];
    for (const { file } of productionSources()) {
      const source = withoutComments(readFileSync(path.join(REPO_ROOT, file), "utf8"));
      for (const match of source.matchAll(/(?:^|[^\w.$])import\s*\(\s*([^"'\s)])/g)) {
        problems.push(
          `${file}: dynamic import with a non-literal specifier (${match[1] as string})`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  describe("the extraction machinery, over the forms the sources can take", () => {
    // The live tree carries no specimen for most of the machinery's arms —
    // no dynamic import of any kind in the shipped sources today — so over
    // the real files alone, a regression in the extractor or the stripper is
    // invisible until the day a real specimen arrives and silently isn't
    // checked. These fixtures pin the machinery's behavior over synthetic
    // source strings instead: every arm it must serve, red on regression.
    it("extracts every literal form the closure pin must see", () => {
      expect(importSpecifiers(`import { a } from "@azx-pbc/shared";`)).toEqual(["@azx-pbc/shared"]);
      expect(importSpecifiers(`import { a } from '@azx-pbc/shared';`)).toEqual(["@azx-pbc/shared"]);
      expect(importSpecifiers(`import "@azx-pbc/shared";`)).toEqual(["@azx-pbc/shared"]);
      expect(importSpecifiers(`import {\n  a,\n  b,\n} from "@azx-pbc/shared";`)).toEqual([
        "@azx-pbc/shared",
      ]);
      expect(importSpecifiers(`export { a } from "./x.js";`)).toEqual(["./x.js"]);
      expect(importSpecifiers(`const x = await import("@azx-pbc/shared");`)).toEqual([
        "@azx-pbc/shared",
      ]);
    });

    it("sees a literal through the chunk-name idiom only in the stripped view", () => {
      // `import(/* webpackChunkName: "v" */ "vite")`: the comment between
      // `import(` and the literal leaves the raw text with no adjacent
      // quote, so the raw extraction misses the specifier entirely. The
      // stripped view removes the comment at code level and sees it; the
      // strip-then-extract composition the pin consumes is pinned in its
      // own leg below.
      const idiomatic = `import(/* webpackChunkName: "v" */ "@azx-pbc/shared");`;
      expect(importSpecifiers(idiomatic)).toEqual([]);
      expect(importSpecifiers(withoutComments(idiomatic))).toEqual(["@azx-pbc/shared"]);
    });

    it("never reads prose or a template as a specifier, the forms the guard exists for", () => {
      // The prose case the live tree actually carries: a doc comment reading
      // `import (the keep-in-sync convention…`. Raw, the guard's own pattern
      // reads it as a non-literal dynamic import and the file would go red —
      // the stripper removes the comment first, and neither the extractor
      // nor the guard sees anything but the real code.
      const prose = `// import (the keep-in-sync convention) — see docs\nimport { a } from "zod";`;
      expect(withoutComments(prose)).toBe(`\nimport { a } from "zod";`);
      expect(importSpecifiers(withoutComments(prose))).toEqual(["zod"]);
      // A dynamic import built from a variable, or spelled as a template
      // literal, is invisible to the extractor's literal patterns — exactly
      // the blindness the non-literal guard above exists to cover: both
      // forms are flagged there, never silently unchecked.
      expect(importSpecifiers(`const name = "vite"; import(name);`)).toEqual([]);
      expect(importSpecifiers("import(`vite`);")).toEqual([]);
    });

    it("the composition the closure pin runs — strip then extract, one home — behaves on the idioms", () => {
      // The per-function pins above are necessary, not sufficient: the view
      // swap this file guards against lived in the composition (the pin
      // reading the raw view), never in a function alone. The composition
      // has one home (`specifiersOf`); the pin and this fixture drive the
      // same function, so a regression inside it — dropping the strip —
      // goes red here. (A rewrite that bypasses the home re-inlines calls
      // whose behavior is unchanged — nothing functional can observe that;
      // it is a diff a review reads, per the helper's own docblock.)
      const idiomatic = `import(/* webpackChunkName: "v" */ "@azx-pbc/shared");`;
      expect(specifiersOf(idiomatic)).toEqual(["@azx-pbc/shared"]);
      const prose = `// import (the keep-in-sync convention) — see docs\nimport { a } from "zod";`;
      expect(specifiersOf(prose)).toEqual(["zod"]);
      expect(specifiersOf(`import "@azx-pbc/shared";`)).toEqual(["@azx-pbc/shared"]);
    });
  });
});
