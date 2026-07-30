import { parseArgs } from "node:util";

/** Flag spec for every `helix` command (a superset; commands read what they need). */
const options = {
  slug: { type: "string" },
  "portal-url": { type: "string" },
  dir: { type: "string" },
  bundle: { type: "string" },
  token: { type: "string" },
  promote: { type: "boolean" },
  "display-name": { type: "string" },
  visibility: { type: "string" },
  help: { type: "boolean" },
} as const;

/**
 * Parse argv into flags + positionals.
 *
 * `pnpm --filter @azx-pbc/helix-cli helix -- <cmd> …` forwards the `--` separator
 * straight into argv. Node's `parseArgs` treats a *leading* `--` as the end-of-options
 * marker and would shove every following flag into positionals — so `--promote`
 * and friends would be silently dropped. Strip one leading `--` so flags parse
 * whether the CLI was invoked directly (`helix deploy --promote`) or through pnpm.
 * A `--` anywhere else is left alone and terminates options as usual.
 */
export function parseCliArgs(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  return parseArgs({ args, allowPositionals: true, options });
}
