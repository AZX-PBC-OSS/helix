import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createBlobReader } from "./blob/client.js";
import { LiveRegistry, type RegistryLogger } from "./registry/listener.js";

// Bind 0.0.0.0 — inside the container the port is reached across the Docker
// network / forwarded to the host.
const port = Number(process.env.EDGE_PORT ?? process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const config = loadConfig();
const blob = createBlobReader(config.blob);

// The registry logs through the app's logger, but buildApp needs the registry
// — bridge the cycle with a late-bound reference.
const logRef: { current: RegistryLogger } = {
  current: { info: () => {}, warn: () => {} },
};
const registry = new LiveRegistry({
  databaseUrl: config.databaseUrl,
  reconcileIntervalMs: config.reconcileIntervalMs,
  log: {
    info: (msg) => logRef.current.info(msg),
    warn: (obj, msg) => logRef.current.warn(obj, msg),
  },
});

const app = buildApp({ config, registry, blob });
logRef.current = {
  info: (msg) => app.log.info(msg),
  warn: (obj, msg) => app.log.warn(obj, msg),
};
app.addHook("onClose", async () => {
  await registry.stop();
  await blob.close();
});

try {
  // First load attempt completes before we accept traffic; a down DB logs and
  // retries rather than blocking boot (LiveRegistry.start never throws).
  await registry.start();
  await app.listen({ port, host });
  app.log.info(
    { baseDomain: config.baseDomain, allowUnauthenticated: config.allowUnauthenticated },
    "azx-edge serving",
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
