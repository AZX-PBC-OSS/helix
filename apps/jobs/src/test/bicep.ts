import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/**
 * Text-level readers over the Azure templates, shared by the suites that pin
 * the deployed service wiring and by the suites that compose the local stack
 * from the same definitions. The parsers are deliberately narrow: each
 * asserts it found something, so a template reshaped past them fails loudly
 * instead of yielding an empty, vacuously passing set.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** One repository file's text, by repo-relative path. */
export function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const MAIN = readRepoFile("infra/azure/main.bicep");

/** The text of one `module <name> 'modules/containerapp.bicep'` call in main.bicep. */
export function appCall(name: string): string {
  const call = MAIN.match(
    new RegExp(
      `module ${name} 'modules/containerapp\\.bicep'[\\s\\S]*?(?=\\nmodule |\\n// -{10,})`,
    ),
  );
  expect(call, `main.bicep must declare the ${name} container app`).not.toBeNull();
  return call![0];
}

export interface EnvEntry {
  name: string;
  /** The raw `value:` expression, for a plain-value entry. */
  value?: string;
  /** The referenced secret name, for a secretRef entry. */
  secretRef?: string;
}

/**
 * Every env entry of a container app call, single-line or multi-line. The
 * `${...}` interpolations are flattened first: their braces would otherwise
 * cut a flat-object match short (they never carry an env name).
 */
export function envEntries(callText: string): EnvEntry[] {
  const flat = callText.replace(/\$\{[^}]*\}/g, "I");
  const entries: EnvEntry[] = [];
  for (const match of flat.matchAll(/\{([^{}]*)\}/g)) {
    const body = match[1]!;
    const name = body.match(/name:\s*'([A-Z0-9_]+)'/);
    if (!name) continue;
    // `value:` is each entry's last property, single-line or multi-line; the
    // match anchors to the end of the value's own line.
    const value = body.match(/value:[ \t]*([^\n]*?)[ \t]*$/m);
    const secretRef = body.match(/secretRef:\s*'([a-z0-9-]+)'/);
    entries.push({ name: name[1]!, value: value?.[1]?.trim(), secretRef: secretRef?.[1] });
  }
  expect(
    entries.length,
    `no env entries parsed from the call — extend the envEntries parser in test/bicep.ts`,
  ).toBeGreaterThan(0);
  return entries;
}
