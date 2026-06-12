import { readFileSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig, publicOrigin } from "./config.js";
import { createBlobReader } from "./blob/client.js";
import { LiveRegistry, type RegistryLogger } from "./registry/listener.js";
import { OpenIdConnectClient } from "./auth/oidc.js";
import { PgSessionStore, startSessionSweeper } from "./auth/sessions.js";

// Bind 0.0.0.0 — inside the container the port is reached across the Docker
// network / forwarded to the host.
const port = Number(process.env.EDGE_PORT ?? process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const config = loadConfig();
const blob = createBlobReader(config.blob);

// Dev TLS termination (mkcert): `__Host-` cookies require Secure, so the real
// cookie model must run locally (project plan §3). Prod stays plain HTTP
// behind Azure ingress and leaves `tls` unset.
let https: { cert: Buffer; key: Buffer } | null = null;
if (config.tls) {
  try {
    https = {
      cert: readFileSync(config.tls.certFile),
      key: readFileSync(config.tls.keyFile),
    };
  } catch (err) {
    throw new Error(
      "EDGE_TLS_* points at unreadable files — re-run .devcontainer/post-create.sh " +
        "to generate the mkcert certs",
      { cause: err },
    );
  }
}

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

// Auth stack — only when the config block is present (fail-closed otherwise).
const sessions = config.auth ? new PgSessionStore(config.databaseUrl) : null;
const oidc = config.auth
  ? new OpenIdConnectClient(config.auth, `${publicOrigin(config, "auth")}/callback`, {
      info: (msg) => logRef.current.info(msg),
      warn: (obj, msg) => logRef.current.warn(obj, msg),
    })
  : null;

const app = buildApp({ config, registry, blob, sessions, oidc, https });
logRef.current = {
  info: (msg) => app.log.info(msg),
  warn: (obj, msg) => app.log.warn(obj, msg),
};
const sweeper = sessions
  ? startSessionSweeper(sessions, {
      log: {
        info: (msg) => app.log.info(msg),
        warn: (obj, msg) => app.log.warn(obj, msg),
      },
    })
  : null;
app.addHook("onClose", async () => {
  sweeper?.stop();
  oidc?.stop();
  await registry.stop();
  await sessions?.close();
  await blob.close();
});

try {
  // First load attempt completes before we accept traffic; a down DB logs and
  // retries rather than blocking boot (LiveRegistry.start never throws, and
  // neither does OIDC discovery — auth routes 503 until it lands).
  await registry.start();
  await oidc?.start();
  await app.listen({ port, host });
  app.log.info(
    {
      baseDomain: config.baseDomain,
      allowUnauthenticated: config.allowUnauthenticated,
      tls: https !== null,
    },
    "azx-edge serving",
  );
  if (config.allowUnauthenticated) {
    app.log.warn("EDGE_DEV_ALLOW_UNAUTHENTICATED is set — app content is served without sessions");
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
