import { readFileSync } from "node:fs";
import {
  createSecretStore,
  managedIdentityTokenProviderFromEnv,
  readDevKey,
  type SecretStore,
  type TokenProvider,
} from "@azx-pbc/secret-store";
import { startTelemetry } from "@azx-pbc/telemetry";
import { buildApp, SERVICE_NAME } from "./app.js";
import { loadConfig } from "./config.js";
import { deriveInstructionKey } from "./instruction.js";
import { FOUNDRY_TOKEN_RESOURCE, ManagedIdentityResolver } from "./managedIdentity.js";
import { PgSecretResolver, type SecretResolver } from "./secrets.js";
import { PgBurnStore } from "./burn.js";

/**
 * How often to drop expired `instruction_jti` rows. Shorter than the retention
 * so the table stays tiny; a jti that outlives its row can't verify anyway.
 */
const BURN_SWEEP_INTERVAL_MS = 60_000;

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

// Inert unless an OTLP endpoint is configured (ADR-0037). Mirrors the edge:
// after the dotenv load, before anything else comes up.
//
// `propagation: "full"` — egress is the ONE service that extracts trace context
// (ADR-0037 decision 7). Every other service is inject-only, because its callers
// are untrusted app code; egress's only caller is the edge, over a hop whose
// authority already comes from the signed attested instruction (ADR-0013). The
// `traceparent` rides alongside that instruction as correlation and is never
// read for policy — extracting it is what makes the edge → egress seam a single
// trace instead of two unjoinable halves in two Log Analytics workspaces.
const telemetry = startTelemetry(SERVICE_NAME, { propagation: "full" });

const config = loadConfig();
const instructionKey = deriveInstructionKey(config.instructionSecret);

// Build the secret-store custody (prod: Key Vault; dev: local envelope). If
// neither is configured the resolver stays null — keyless proxying still works,
// secret-backed calls 502 (fail-closed).
//
// Deliberately not wrapped in try/catch (unlike the portal plugin): egress cannot
// do its job without custody, so misconfiguration must crash the boot rather than
// silently degrade every secret-backed call to a 502.
let store: SecretStore | null = null;
let tokenProvider: TokenProvider | null = null;
let custody: "keyvault" | "dev" | "off" = "off";
if (config.keyVaultUrl) {
  // The mechanism plane stays off `@azure/identity` (ADR-0031 extends the edge's
  // dependency-minimal reasoning here by degree) — the managed-identity token
  // endpoint is a plain HTTP call we make ourselves.
  // 5s, below the store's own 8s `open()` budget. `KeyVaultSecretStore` bounds every
  // token wait anyway, so this governs how long an abandoned refresh lingers — but a
  // default larger than the budget it feeds is a contradiction worth not shipping.
  tokenProvider = managedIdentityTokenProviderFromEnv(process.env, { timeoutMs: 5_000 });
  if (!tokenProvider) {
    throw new Error(
      "AZURE_KEY_VAULT_URL is set but the managed-identity env is not " +
        "(need IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID)",
    );
  }
  const getToken = tokenProvider.getToken.bind(tokenProvider);
  store = createSecretStore({ keyVaultUrl: config.keyVaultUrl, getToken });
  custody = "keyvault";
} else if (config.devKeyPath) {
  store = createSecretStore({ devMasterKey: readDevKey(config.devKeyPath) });
  custody = "dev";
}
// Both pools are built before `buildApp`, so their reporting rides a late-bound
// ref (the same shape the edge uses). Without the `'error'` listener underneath
// this hook, an idle client dropping on a DB restart would be an unhandled
// `'error'` event and would kill the whole mechanism plane — a fetch-proxy outage.
const logRef: { current: (obj: Record<string, unknown>, msg: string) => void } = {
  current: () => {},
};
const onClientError = (err: unknown, label: string): void => {
  logRef.current(
    { event: "db.pool_client_error", pool: label, phase: "idle", err },
    `pooled DB client dropped (${label}, idle)`,
  );
};

const pgResolver: PgSecretResolver | null = store
  ? new PgSecretResolver(config.databaseUrl, store, {
      statementTimeoutMs: config.statementTimeoutMs,
      onIdleError: (err) => onClientError(err, "secrets"),
    })
  : null;

// Keyless LLM vendor auth (ADR-0046): when EGRESS_MANAGED_IDENTITY_CONNECTIONS
// names connections, wrap the resolver so an *absent* platform row falls back
// to a managed-identity Entra token (Foundry audience) instead of a 403. Same
// rule as the Key Vault custody above: configuring this without the MI env
// crashes boot rather than silently degrading every such call.
let resolver: SecretResolver | null = pgResolver;
let miTokenProvider: TokenProvider | null = null;
if (config.managedIdentityConnections.length > 0) {
  // …and the same rule again for custody: with no store, installing the
  // wrapper would leave deps.resolver non-null, so a secret-backed call off
  // the MI list would 403 "connection not found" (an authz read) instead of
  // 502 "secret store not configured" (the actual misconfiguration) — an
  // operator would hunt grants for a custody gap. Every real topology has a
  // store (KEK in dev, Key Vault in Azure), so this combination is never
  // legitimate.
  if (!pgResolver) {
    throw new Error(
      "EGRESS_MANAGED_IDENTITY_CONNECTIONS is set but no custody store is configured " +
        "(need AZURE_KEY_VAULT_URL or DEV_SECRETS_KEK_FILE)",
    );
  }
  miTokenProvider = managedIdentityTokenProviderFromEnv(process.env, {
    resource: config.managedIdentityResource ?? FOUNDRY_TOKEN_RESOURCE,
    timeoutMs: 5_000,
  });
  if (!miTokenProvider) {
    throw new Error(
      "EGRESS_MANAGED_IDENTITY_CONNECTIONS is set but the managed-identity env is not " +
        "(need IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID)",
    );
  }
  resolver = new ManagedIdentityResolver(
    pgResolver,
    miTokenProvider,
    config.managedIdentityConnections,
  );
}

// The replay burn always runs — it needs only the DB (helix_egress), not the
// secret store, and protects keyless calls too (issue #3).
const burnStore = new PgBurnStore(config.databaseUrl, {
  statementTimeoutMs: config.statementTimeoutMs,
  onIdleError: (err) => onClientError(err, "instruction-jti"),
});

const app = buildApp({ config, resolver, instructionKey, burnStore });
logRef.current = (obj, msg) => app.log.warn(obj, msg);

// GC expired burn rows on an interval; unref so it never holds the process open.
const burnSweep = setInterval(() => {
  void burnStore
    .sweep()
    .catch((err: unknown) => app.log.warn({ err }, "instruction_jti sweep failed"));
}, BURN_SWEEP_INTERVAL_MS);
burnSweep.unref();

app.addHook("onClose", async () => {
  clearInterval(burnSweep);
  await burnStore.close();
  // The wrapper owns the wrapped resolver (ManagedIdentityResolver.close), so
  // this one call covers both shapes.
  await resolver?.close();
  await tokenProvider?.close();
  await miTokenProvider?.close();
  await telemetry.shutdown();
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      event: "boot.serving",
      service: SERVICE_NAME,
      port: config.port,
      secretStore: custody,
      // Connection names + vendor host suffixes are operator-chosen config
      // labels, safe beside the connection names the error path already logs.
      managedIdentityConnections: config.managedIdentityConnections.map(
        (r) => `${r.connection}→${r.hostSuffix}`,
      ),
      managedIdentityResource: config.managedIdentityResource,
      allowPrivate: config.allowPrivate,
      allowInsecureConnection: config.allowInsecureConnection,
      telemetry: telemetry.enabled,
    },
    `${SERVICE_NAME} serving`,
  );
  if (config.allowPrivate) {
    app.log.warn("EGRESS_ALLOW_PRIVATE is set — private/loopback targets are NOT blocked");
  }
  // A sub-three-label suffix (azure.com, co.uk) is a public-suffix-class pin —
  // technically valid, practically a shared-zone grant. Warn, don't refuse: the
  // operator may mean it, but they should have to read it once at boot.
  for (const rule of config.managedIdentityConnections) {
    if (rule.hostSuffix.split(".").length < 3) {
      app.log.warn(
        { connection: rule.connection, hostSuffix: rule.hostSuffix },
        "managed-identity rule pinned to a broad host suffix — prefer the exact account host (contoso.services.ai.azure.com)",
      );
    }
  }
  if (config.allowInsecureConnection) {
    app.log.warn(
      "EGRESS_ALLOW_INSECURE_CONNECTION is set — connection secrets may be injected over cleartext http://",
    );
  }
  // Say it once at boot rather than making the operator infer it from N identical 502s.
  // A row sealed under the dev envelope cannot be opened here, and there is no migration
  // path between backends — the values have to be re-entered.
  if (custody === "keyvault" && pgResolver) {
    const foreign = await pgResolver.countForeignMaterial("kv");
    if (foreign) {
      app.log.warn(
        { count: foreign },
        "app_secrets rows hold non-Key-Vault material — these were sealed under a " +
          "different custody backend and every call resolving them will fail; re-enter them",
      );
    }
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
