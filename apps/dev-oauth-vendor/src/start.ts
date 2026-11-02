import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  AuthorizeModeSchema,
  TokenModeSchema,
  VendorModesSchema,
  type AuthorizeMode,
  type TokenMode,
  type VendorModes,
} from "./modes.js";
import {
  buildVendor,
  VendorOptionsSchema,
  type DevOAuthVendorOptions,
  type TokenEndpointCall,
} from "./vendor.js";

export interface StartDevOAuthVendorOptions extends DevOAuthVendorOptions {
  /** 0 (default) binds an ephemeral port — parallel test files never collide. */
  port?: number;
  /** Host for the issuer URL; the port is always the bound one. */
  host?: string;
}

export interface RunningDevOAuthVendor {
  issuer: string;
  port: number;
  /** The instance's current modes (what `setModes` last set). */
  modes(): VendorModes;
  /**
   * Change modes on THIS instance only. Suites that need a fault mid-journey
   * (connect normally, then hang the renewal) flip it here — the state lives
   * per instance, so concurrent suites never see each other's modes.
   */
  setModes(modes: { tokenMode?: TokenMode; authorizeMode?: AuthorizeMode }): void;
  /**
   * The token endpoint's call log, oldest first: grant types and
   * whether a refresh token was presented — never token values. The
   * single-flight evidence lives here: a concurrent-renewal invariant is
   * exactly "the refresh token was presented once".
   */
  tokenCalls(): TokenEndpointCall[];
  /** Drop the call log — a suite's per-test reset. */
  resetTokenCalls(): void;
  close(): Promise<void>;
}

/**
 * Bind the vendor on an ephemeral port and return the handle test suites
 * drive — the `startDevIdp` pattern: one full HTTP surface per suite, no
 * external process, no shared state between suites.
 */
export async function startDevOAuthVendor(
  opts: StartDevOAuthVendorOptions = {},
): Promise<RunningDevOAuthVendor> {
  // The listen bind is deliberately explicit, never left to fastify's
  // default: the default resolved `localhost` and bound ONE address (`::1`,
  // IPv6 loopback only), so a fetch whose resolver handed it `127.0.0.1`
  // first could reach a DIFFERENT process's listener that took the same
  // ephemeral port number on IPv4 — a cross-family port collision that
  // answered 404 for the vendor's own routes under parallel load. The `::`
  // bind is dual-stack: one socket owns the port for both families, and
  // every spelling of the loopback reaches this vendor. The issuer keeps the
  // readable `localhost` name.
  const bindHost = opts.host ?? "::";
  const issuerHost = opts.host ?? "localhost";
  const parsed = VendorOptionsSchema.parse(opts ?? {});
  const modes: VendorModes = VendorModesSchema.parse({
    tokenMode: parsed.tokenMode,
    authorizeMode: parsed.authorizeMode,
  });

  const app = buildVendor(modes, opts);
  await app.listen({ port: opts.port ?? 0, host: bindHost });
  const port = (app.server.address() as AddressInfo).port;
  const issuer = `http://${issuerHost}:${port}`;

  let closing = false;
  return {
    issuer,
    port,
    modes: () => ({ ...modes }),
    setModes(partial) {
      if (partial.tokenMode !== undefined)
        modes.tokenMode = TokenModeSchema.parse(partial.tokenMode);
      if (partial.authorizeMode !== undefined) {
        modes.authorizeMode = AuthorizeModeSchema.parse(partial.authorizeMode);
      }
    },
    tokenCalls: () => [...app.tokenLog],
    resetTokenCalls: () => {
      app.tokenLog.length = 0;
    },
    close: async () => {
      if (closing) return;
      closing = true;
      const serverClosed = once(app.server, "close");
      // A `hang`-mode request never finishes on its own, and fastify's close
      // waits on in-flight requests — destroy the sockets first so shutdown
      // is clean even mid-hang.
      app.server.closeAllConnections();
      await app.close().catch(() => {});
      await serverClosed;
    },
  };
}
