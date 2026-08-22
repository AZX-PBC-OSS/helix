import { X509Certificate } from "node:crypto";
import * as oidc from "openid-client";
import { importPKCS8 } from "jose";
import type { AuthClientCredential, AuthConfig } from "../config.js";

/**
 * The edge's view of the IdP, behind a narrow interface (the fake in
 * test/fakes.ts drives unit tests; integration tests hit the real dev-idp).
 * openid-client does the heavy lifting — discovery, code exchange, ID-token
 * signature/nonce/state validation — and this wrapper reduces its surface to
 * exactly what the auth routes need.
 */

export interface AuthorizeParams {
  state: string;
  nonce: string;
  codeChallenge: string;
  /** Set for silent refresh (Appendix A.5). */
  prompt?: "none";
}

/** What a completed login tells us about the user — nothing else leaves. */
export interface OidcIdentity {
  /** IdP subject (Entra: the object id). */
  oid: string;
  displayName: string;
  groups: string[];
}

export type ExchangeOutcome =
  /** Code exchanged, ID token valid. */
  | { kind: "ok"; identity: OidcIdentity }
  /** A prompt=none round-trip needs interactive login instead. */
  | { kind: "interaction-required" }
  /** Tampered/expired/foreign response — no detail leaves this module. */
  | { kind: "invalid" };

export interface ExchangeChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcClient {
  /** False until discovery succeeds — auth routes 503 meanwhile. */
  isReady(): boolean;
  authorizationUrl(params: AuthorizeParams): string;
  exchangeCode(callbackUrl: URL, checks: ExchangeChecks): Promise<ExchangeOutcome>;
}

export function newOidcState(): string {
  return oidc.randomState();
}
export function newOidcNonce(): string {
  return oidc.randomNonce();
}
export function newCodeVerifier(): string {
  return oidc.randomPKCECodeVerifier();
}
export function codeChallengeFor(verifier: string): Promise<string> {
  return oidc.calculatePKCECodeChallenge(verifier);
}

/** Map a certificate key type to its JWS signing alg (Entra uploads are RSA or EC). */
function jwsAlgForKeyType(keyType: string | undefined): string {
  switch (keyType) {
    case "ec":
      return "ES256";
    case "ed25519":
      return "EdDSA";
    default:
      return "RS256";
  }
}

/**
 * Entra's `x5t`: the base64url-encoded SHA-1 thumbprint of the certificate,
 * placed in the client-assertion header so Entra can match the public key it
 * holds. `X509Certificate.fingerprint` is that SHA-1 digest in colon-hex.
 */
export function certThumbprintX5t(certificatePem: string): string {
  const cert = new X509Certificate(certificatePem);
  return Buffer.from(cert.fingerprint.replace(/:/g, ""), "hex").toString("base64url");
}

/**
 * Translate a configured client credential into openid-client's discovery
 * arguments. A shared secret is passed positionally (client_secret_post); a
 * certificate becomes private_key_jwt — the private key signs the assertion and
 * the cert's `x5t` thumbprint rides the header so Entra resolves the key.
 */
export async function buildClientAuth(
  credential: AuthClientCredential,
): Promise<{ secret?: string; clientAuth?: oidc.ClientAuth }> {
  if (credential.kind === "secret") {
    return { secret: credential.clientSecret };
  }
  const cert = new X509Certificate(credential.certificatePem);
  const alg = jwsAlgForKeyType(cert.publicKey.asymmetricKeyType);
  const key = await importPKCS8(credential.privateKeyPem, alg);
  const x5t = certThumbprintX5t(credential.certificatePem);
  const options: oidc.ModifyAssertionOptions = {
    [oidc.modifyAssertion]: (header) => {
      header.x5t = x5t;
    },
  };
  return { clientAuth: oidc.PrivateKeyJwt({ key }, options) };
}

const SILENT_LOGIN_ERRORS = new Set(["login_required", "interaction_required", "consent_required"]);

/**
 * What we're willing to retain about a failed code exchange (issue #20).
 *
 * `AuthorizationResponseError` carries `error_description` as an own enumerable
 * property, so pino's stock `err` serializer writes it verbatim — and that field
 * is free text chosen by whoever drove the IdP response. It is reachable: the
 * callback handler passes the raw query to `exchangeCode` with no short-circuit
 * on `error`, so anyone holding a valid flow cookie + state can hit
 * `/callback?error=invalid_request&error_description=<text>` (`invalid_request`
 * is not in SILENT_LOGIN_ERRORS) and place bounded text of their choosing into
 * 30 days of retained logs. Nothing redeemable leaks, but the whole point of the
 * URL redaction is that request-derived content doesn't reach the log.
 *
 * So an OAuth error is reduced to its **enumerated** code — which is what triage
 * actually keys on — while any other failure (IdP unreachable, discovery not
 * done, a bad nonce from `jose`) keeps its full `err` with the stack, since that
 * text is ours.
 */
export function summarizeExchangeError(err: unknown): object {
  if (err instanceof oidc.AuthorizationResponseError) {
    return { errName: err.name, oauthError: err.error };
  }
  return { err };
}

export interface OidcLogger {
  info(msg: string): void;
  warn(obj: object, msg: string): void;
}

/** openid-client implementation with never-throw boot discovery + retry. */
/**
 * Did Entra replace the configured groups claim with a `_claim_names` pointer?
 *
 * Above roughly 200 groups the claim is swapped for `_claim_names` /
 * `_claim_sources` referring the caller to Graph. The edge reads no groups in that
 * case and therefore denies every `group` app — fail-closed, which is right, but
 * indistinguishable from a bug, so it is worth a specific log line.
 *
 * The predicate asks whether the overage covers **our** claim, not merely whether
 * `_claim_names` exists at all. Testing for its bare presence attributed the wrong
 * cause on any deployment reading a different claim: on
 * `EDGE_OIDC_GROUPS_CLAIM=roles`, a user with no app-role assignment and an
 * unrelated `_claim_names` entry was told they had a group-overage problem —
 * sending an operator after Entra's 200-group limit when the real fix was one
 * assignment. Symmetrically, a genuine overage on a custom claim was missed.
 *
 * Extracted and exported only so it can be tested without standing up a token
 * exchange. The deny path does not consult it — `groups` is `[]` either way.
 */
export function groupsClaimOverflowed(
  claims: Record<string, unknown>,
  groupsClaim: string,
): boolean {
  if (claims[groupsClaim] !== undefined) return false;
  const names = claims._claim_names;
  return typeof names === "object" && names !== null && groupsClaim in names;
}

export class OpenIdConnectClient implements OidcClient {
  #auth: AuthConfig;
  #redirectUri: string;
  #log: OidcLogger;
  #config: oidc.Configuration | null = null;
  #retry: NodeJS.Timeout | null = null;
  #stopped = false;
  /** Cached discovery client-auth args (key import is done once, not per retry). */
  #clientAuth: { secret?: string; clientAuth?: oidc.ClientAuth } | null = null;

  constructor(auth: AuthConfig, redirectUri: string, log: OidcLogger) {
    this.#auth = auth;
    this.#redirectUri = redirectUri;
    this.#log = log;
  }

  /** Begin discovery; failures log and retry (mirrors LiveRegistry's stance). */
  async start(): Promise<void> {
    await this.#discoverOnce();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
  }

  async #discoverOnce(): Promise<void> {
    try {
      this.#clientAuth ??= await buildClientAuth(this.#auth.credential);
      this.#config = await oidc.discovery(
        new URL(this.#auth.issuerUrl),
        this.#auth.clientId,
        this.#clientAuth.secret,
        this.#clientAuth.clientAuth,
        this.#auth.allowInsecureIdp ? { execute: [oidc.allowInsecureRequests] } : undefined,
      );
      this.#log.info(`OIDC discovery complete for ${this.#auth.issuerUrl}`);
    } catch (err) {
      this.#log.warn({ err }, `OIDC discovery failed for ${this.#auth.issuerUrl}; retrying in 5s`);
      if (!this.#stopped) {
        this.#retry = setTimeout(() => void this.#discoverOnce(), 5000);
        this.#retry.unref();
      }
    }
  }

  isReady(): boolean {
    return this.#config !== null;
  }

  #requireConfig(): oidc.Configuration {
    if (!this.#config) throw new Error("OIDC discovery has not completed");
    return this.#config;
  }

  authorizationUrl(params: AuthorizeParams): string {
    return oidc
      .buildAuthorizationUrl(this.#requireConfig(), {
        redirect_uri: this.#redirectUri,
        scope: this.#auth.scopes,
        state: params.state,
        nonce: params.nonce,
        code_challenge: params.codeChallenge,
        code_challenge_method: "S256",
        ...(params.prompt ? { prompt: params.prompt } : {}),
      })
      .toString();
  }

  async exchangeCode(callbackUrl: URL, checks: ExchangeChecks): Promise<ExchangeOutcome> {
    try {
      const tokens = await oidc.authorizationCodeGrant(this.#requireConfig(), callbackUrl, {
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        pkceCodeVerifier: checks.codeVerifier,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== "string") {
        return { kind: "invalid" };
      }
      const rawGroups = claims[this.#auth.groupsClaim];
      const groups = Array.isArray(rawGroups)
        ? rawGroups.filter((g): g is string => typeof g === "string")
        : [];
      // Claim overage (ADR-0040 decision 10). Above roughly 200 groups Entra
      // drops the groups claim and substitutes `_claim_names`/`_claim_sources`
      // pointing at Graph. We read no groups in that case and therefore DENY
      // every `group` app — which is the right direction, but indistinguishable
      // from a bug from the outside, and the user just sees a 403 on an app they
      // are a member of. Log it specifically so the condition is diagnosable.
      //
      // v1 does not resolve overage: doing so means a Graph call on the sign-in
      // hot path, in the one plane ADR-0003 forbids a Graph client to. That is a
      // separate decision with a different shape, deferred until a real user
      // trips this line.
      if (groupsClaimOverflowed(claims, this.#auth.groupsClaim)) {
        this.#log.warn(
          { sub: claims.sub, groupsClaim: this.#auth.groupsClaim },
          "OIDC groups claim replaced by _claim_names (group overage) — no groups read, " +
            "so every group-scoped app will deny this session",
        );
      }
      const displayName =
        [claims.name, claims.preferred_username, claims.email].find(
          (v): v is string => typeof v === "string" && v.length > 0,
        ) ?? claims.sub;
      return { kind: "ok", identity: { oid: claims.sub, displayName, groups } };
    } catch (err) {
      if (
        err instanceof oidc.AuthorizationResponseError &&
        SILENT_LOGIN_ERRORS.has(err.error ?? "")
      ) {
        return { kind: "interaction-required" };
      }
      // Everything else — bad state, bad nonce, bad code, IdP down — is one
      // opaque failure to the caller; detail goes to logs only.
      this.#log.warn(summarizeExchangeError(err), "OIDC code exchange failed");
      return { kind: "invalid" };
    }
  }
}
