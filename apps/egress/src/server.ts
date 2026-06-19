import { readFileSync } from "node:fs";
import { createSecretStore, readDevKey, type SecretStore } from "@helix/secret-store";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { deriveInstructionKey } from "./instruction.js";
import { PgSecretResolver, type SecretResolver } from "./secrets.js";

/**
 * Dev convenience: load `apps/egress/.env.local` (gitignored) before config, so
 * the egress-specific env need not be exported by hand. Real env always wins.
 * Hand-rolled (no `dotenv`) — mirrors apps/edge/src/server.ts.
 */
function loadDotEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnvLocal();

const config = loadConfig();
const instructionKey = deriveInstructionKey(config.instructionSecret);

// Build the secret-store custody (prod: Key Vault; dev: local envelope). If
// neither is configured the resolver stays null — keyless proxying still works,
// secret-backed calls 502 (fail-closed).
let store: SecretStore | null = null;
if (config.keyVaultUrl) {
  store = createSecretStore({ keyVaultUrl: config.keyVaultUrl });
} else if (config.devKeyPath) {
  store = createSecretStore({ devMasterKey: readDevKey(config.devKeyPath) });
}
const resolver: SecretResolver | null = store
  ? new PgSecretResolver(config.databaseUrl, store)
  : null;

const app = buildApp({ config, resolver, instructionKey });
app.addHook("onClose", async () => {
  await resolver?.close();
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { port: config.port, secretStore: store ? "on" : "off", allowPrivate: config.allowPrivate },
    "azx-egress serving",
  );
  if (config.allowPrivate) {
    app.log.warn("EGRESS_ALLOW_PRIVATE is set — private/loopback targets are NOT blocked");
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
