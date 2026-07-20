/**
 * azx-egress configuration, resolved once at boot (mirrors the edge's config
 * discipline — handlers never read process.env). The egress service is the
 * mechanism plane: it needs the DB (as `helix_egress`), the shared instruction
 * secret (to verify what the edge minted), a secret-store custody config, and
 * SSRF/limit knobs.
 */
export interface EgressConfig {
  port: number;
  host: string;
  /** Connects as `helix_egress` (EGRESS_DATABASE_URL); falls back to DATABASE_URL in dev. */
  databaseUrl: string;
  /** Shared with the edge; HKDF-derived into the instruction-verify key. >= 32 bytes. */
  instructionSecret: Buffer;
  /** Prod custody: Key Vault. */
  keyVaultUrl?: string;
  /** Dev custody: path to the locally-generated KEK file (post-create.sh). */
  devKeyPath?: string;
  limits: { maxBodyBytes: number; timeoutMs: number };
  /** Permit private/loopback targets — dev/test only; false in prod. */
  allowPrivate: boolean;
  /**
   * Permit injecting a connection secret into a cleartext `http://` target —
   * dev/test only (loopback echo upstreams); false in prod. Egress is the
   * credential broker and must not leak a secret over the wire in cleartext
   * (issue #11, ADR-0005), so the injection path requires `https://` unless this
   * seam is explicitly opened.
   */
  allowInsecureConnection: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EgressConfig {
  const instructionSecret = Buffer.from(required(env, "HELIX_INSTRUCTION_SECRET"));
  if (instructionSecret.byteLength < 32) {
    throw new Error("HELIX_INSTRUCTION_SECRET must be at least 32 bytes");
  }
  const databaseUrl = env.EGRESS_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("EGRESS_DATABASE_URL or DATABASE_URL is required");
  }
  return {
    port: Number(env.EGRESS_PORT ?? env.PORT ?? 8081),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl,
    instructionSecret,
    keyVaultUrl: env.AZURE_KEY_VAULT_URL || undefined,
    devKeyPath: env.DEV_SECRETS_KEK_FILE || undefined,
    limits: {
      maxBodyBytes: Number(env.EGRESS_MAX_BODY_BYTES ?? 10 * 1024 * 1024),
      timeoutMs: Number(env.EGRESS_TIMEOUT_MS ?? 30_000),
    },
    allowPrivate: env.EGRESS_ALLOW_PRIVATE === "true",
    allowInsecureConnection: env.EGRESS_ALLOW_INSECURE_CONNECTION === "true",
  };
}
