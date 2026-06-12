import { SignJWT, jwtVerify } from "jose";

/**
 * OIDC round-trip state, carried in the signed `__Host-oidc-flow` cookie on
 * the auth host (no DB table, no GC, multi-replica safe). Holds everything
 * `/callback` needs to finish what `/start` began: the `state` it must match,
 * the `nonce` the ID token must carry, the PKCE verifier, and where the user
 * was headed. Signed so none of it is attacker-writable; HttpOnly+Secure so
 * no script reads the verifier.
 *
 * Known nuisance (accepted in plan): two concurrent logins in one browser
 * last-writer-win this cookie; the losing tab gets a clean restart page.
 */

const TYP = "helix-flow+jwt";
const ALG = "HS256";
const TTL_SEC = 10 * 60;

export interface FlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Target app slug — re-resolved against the registry at /callback. */
  app: string;
  /** Validated return path. */
  rd: string;
  /** True when this round-trip is a prompt=none silent refresh. */
  silent: boolean;
}

export const FLOW_TTL_SEC = TTL_SEC;

export async function mintFlowToken(flow: FlowState, key: Buffer): Promise<string> {
  return new SignJWT({ ...flow })
    .setProtectedHeader({ alg: ALG, typ: TYP })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SEC}s`)
    .sign(key);
}

export async function verifyFlowToken(token: string, key: Buffer): Promise<FlowState | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALG],
      typ: TYP,
      clockTolerance: 5,
    });
    if (typeof payload.exp !== "number") return null;
    const { state, nonce, codeVerifier, app, rd, silent } = payload;
    if (
      typeof state !== "string" ||
      typeof nonce !== "string" ||
      typeof codeVerifier !== "string" ||
      typeof app !== "string" ||
      typeof rd !== "string" ||
      typeof silent !== "boolean"
    ) {
      return null;
    }
    return { state, nonce, codeVerifier, app, rd, silent };
  } catch {
    return null;
  }
}
