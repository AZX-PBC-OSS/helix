import type { AuthConfig, EdgeConfig } from "../config.js";

/** The well-known unit-test auth secret (32 bytes). Tests may derive keys
 *  from it to forge tokens — proving forgery still requires the key. */
export const TEST_AUTH_SECRET = Buffer.from("0123456789abcdef0123456789abcdef");

export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    issuerUrl: "https://idp.example",
    clientId: "helix-edge",
    credential: { kind: "secret", clientSecret: "test-secret" },
    groupsClaim: "groups",
    scopes: "openid profile email groups",
    allowInsecureIdp: false,
    secret: TEST_AUTH_SECRET,
    sessionTtlMs: 8 * 60 * 60 * 1000,
    refreshAfterMs: 60 * 60 * 1000,
    handoffTtlSec: 30,
    clockToleranceSec: 5,
    ...overrides,
  };
}

/** Full EdgeConfig for unit tests (no real services behind it). */
export function testEdgeConfig(overrides: Partial<EdgeConfig> = {}): EdgeConfig {
  return {
    baseDomain: "localtest.me",
    databaseUrl: "postgresql://unused",
    blob: {
      provider: "azure",
      accountName: "devstoreaccount1",
      accountKey: Buffer.from("dGVzdA==", "base64"),
      endpoint: "http://azurite:10000/devstoreaccount1",
      container: "app-bundles",
    },
    auth: null,
    allowUnauthenticated: true,
    publicScheme: "https",
    publicPort: 8080,
    tls: null,
    reconcileIntervalMs: 60_000,
    llm: {
      endpoint: "https://api.anthropic.com",
      anthropicVersion: "2023-06-01",
      connection: "anthropic",
    },
    // Off by default in unit tests; suites that exercise it pass a low `max`.
    anonRateLimit: { max: 0, windowMs: 60_000 },
    // Builder endpoint off by default; its suite sets a key.
    builder: { apiKey: null },
    // Fetch-proxy off by default; suites that exercise it set egressUrl +
    // instructionSecret (and pass an egress provider into buildApp).
    fetch: { egressUrl: null, instructionSecret: null, timeoutMs: 30_000 },
    ...overrides,
  };
}
