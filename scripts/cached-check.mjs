#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const [tool, ...args] = process.argv.slice(2);
if (tool !== "eslint" && tool !== "prettier") {
  throw new Error("usage: node scripts/cached-check.mjs <eslint|prettier> [args...]");
}

// Native caches track file contents and configuration, but plugin upgrades
// also need invalidation. Key both caches by the workspace dependency lock
// and Node version, including when switching branches.
const key = createHash("sha256")
  .update(readFileSync(join(root, "pnpm-lock.yaml")))
  .update(process.version)
  .digest("hex");
const cacheDir = join(root, "node_modules/.cache/helix-checks", key);
mkdirSync(cacheDir, { recursive: true });

const manifestPath = require.resolve(`${tool}/package.json`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[tool];
const result = spawnSync(
  process.execPath,
  [
    join(dirname(manifestPath), bin),
    "--cache",
    "--cache-strategy",
    "content",
    "--cache-location",
    join(cacheDir, tool),
    ...args,
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
