/**
 * Writes `spec/portal-api.json` and `spec/app-api.json` from the route
 * contracts. With `--check`, writes nothing and exits 1 when a committed file
 * differs from what the contracts generate (the `openapi` step of
 * check-and-lint.sh).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDocument, serialize } from "./build.js";

const check = process.argv.includes("--check");
const stale: string[] = [];

for (const api of ["portal", "app"] as const) {
  const file = fileURLToPath(new URL(`../spec/${api}-api.json`, import.meta.url));
  const next = serialize(buildDocument(api));
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current === next) continue;
  if (check) {
    stale.push(file);
  } else {
    writeFileSync(file, next);
    console.log(`wrote ${file}`);
  }
}

if (stale.length > 0) {
  console.error(
    `OpenAPI spec is out of date with the route contracts:\n  ${stale.join("\n  ")}\n` +
      "Run `pnpm openapi` and commit the result.",
  );
  process.exit(1);
}
