import { hkdfSync } from "node:crypto";

/**
 * One operator-supplied secret (`EDGE_AUTH_SECRET`), HKDF-derived into
 * purpose-bound keys so a token minted for one use can never verify as the
 * other. Symmetric is deliberate: the auth service and the app-host proxy
 * are the same deployment, so mint and verify share a process (Appendix A.2)
 * — if they ever split, swap HS256 for EdDSA inside handoff.ts only.
 */

export interface AuthKeys {
  /** Signs/verifies the one-time handoff token (Appendix A.3). */
  handoffKey: Buffer;
  /** Signs/verifies the `__Host-oidc-flow` state cookie. */
  flowKey: Buffer;
}

const HANDOFF_INFO = "helix-handoff-v1";
const FLOW_INFO = "helix-flow-v1";

export function deriveAuthKeys(secret: Buffer): AuthKeys {
  if (secret.length < 32) {
    throw new Error("auth secret must be at least 32 bytes");
  }
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), info, 32));
  return { handoffKey: derive(HANDOFF_INFO), flowKey: derive(FLOW_INFO) };
}
