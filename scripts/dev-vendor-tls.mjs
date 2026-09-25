#!/usr/bin/env node
// dev-vendor-tls.mjs — an HTTPS front for the dev fixture OAuth vendor.
//
// Why this exists: the fixture vendor (`pnpm dev:vendor`, apps/dev-oauth-vendor)
// speaks plain HTTP on localhost, but both consent entry points hard-enforce
// https on the redirect to the vendor's authorize screen (redirect hygiene, not
// OAuth client code), and the browser popup navigates it too. This terminator
// fronts the vendor on TLS so the authorize hop is https:// without touching
// the vendor: egress keeps exchanging tokens and calling the API against the
// vendor's plain-http issuer (dev relieves egress's https bar via
// EGRESS_ALLOW_INSECURE_CONNECTION), only the authorize hop rides TLS.
//
// The cert is the devcontainer's mkcert wildcard (`*.local.helix.azxlabs.io`
// resolves to 127.0.0.1 and the wildcard covers the vendor host), so the host
// browser needs no new trust ceremony beyond the one the app hosts already
// asked for.
//
// Usage: pnpm dev:vendor-tls   (start `pnpm dev:vendor` first)
// Env:   OAUTH_VENDOR_TLS_PORT (default 3443), OAUTH_VENDOR_PORT (default 3003),
//        OAUTH_VENDOR_TLS_HOST (default `vendor.local.helix.azxlabs.io` — the
//        hostname the cert is presented for; DNS resolves it to 127.0.0.1).
// Hand-rolled, no deps — matches the repo's dependency-minimal stance.

import { connect as tcpConnect } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tlsPort = Number(process.env.OAUTH_VENDOR_TLS_PORT ?? 3443);
const vendorPort = Number(process.env.OAUTH_VENDOR_PORT ?? 3003);
const tlsHost = process.env.OAUTH_VENDOR_TLS_HOST ?? "vendor.local.helix.azxlabs.io";
const certDir = join(import.meta.dirname, "../.devcontainer/certs");
const cert = readFileSync(join(certDir, "local-helix.pem"));
const key = readFileSync(join(certDir, "local-helix-key.pem"));

// Byte-honest pump, the connections-lane's pattern: TLS in, raw TCP out.
const server = createTlsServer({ key, cert }, (client) => {
  let upstream = null;
  const pending = [];
  client.on("data", (chunk) => {
    if (upstream) {
      upstream.write(chunk);
      return;
    }
    pending.push(chunk);
    if (pending.length === 1) {
      const u = tcpConnect(vendorPort, "127.0.0.1", () => {
        for (const b of pending) u.write(b);
        u.pipe(client);
      });
      u.on("error", () => client.destroy());
      upstream = u;
    }
  });
  client.on("error", () => upstream?.destroy());
});

server.listen(tlsPort, "0.0.0.0", () => {
  console.log(
    `[dev-vendor-tls] https://${tlsHost}:${tlsPort} -> http://localhost:${vendorPort} ` +
      `(mkcert wildcard cert; start pnpm dev:vendor if you have not)`,
  );
});
