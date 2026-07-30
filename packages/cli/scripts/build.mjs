#!/usr/bin/env node
/**
 * Bundle the CLI to a single publishable `dist/helix.js`.
 *
 * Why bundle rather than `tsc --outDir`: `@azx-pbc/shared` is a private
 * `workspace:*` package whose `exports` point straight at `./src/index.ts`, and
 * every service consumes it as raw TS on purpose (see apps/edge/Dockerfile).
 * Publishing the CLI must not force a build+dist+d.ts onto `shared`, and it
 * must not ship a manifest depending on `@azx-pbc/shared@0.0.0` — a version
 * that exists in no registry. Inlining it here solves both: `shared` is a
 * devDependency of this package, and its code lands inside the bundle.
 *
 * The three real npm deps stay external so they install from the registry —
 * bundling archiver's transitive tree buys nothing and risks plenty.
 */
import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(pkgDir, "dist", "helix.js");

await rm(path.join(pkgDir, "dist"), { recursive: true, force: true });

await build({
  entryPoints: [path.join(pkgDir, "src", "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  // esbuild strips the source's own `#!/usr/bin/env -S tsx` shebang; the
  // published bin must run on plain node, with no tsx anywhere on PATH.
  banner: { js: "#!/usr/bin/env node" },
  external: ["archiver", "openid-client", "zod"],
  logLevel: "info",
});

// esbuild writes 0644 — a bin entry has to be executable.
await chmod(outfile, 0o755);
