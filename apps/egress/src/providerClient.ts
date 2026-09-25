import { Configuration, allowInsecureRequests, customFetch as CUSTOM_FETCH } from "openid-client";
import type { Agent } from "undici";
import type { ConnectionProvider } from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";
import { makePinnedFetch } from "./exchangeTransport.js";

/**
 * The openid-client Configuration for ONE provider revision — shared by both
 * vendor-facing operations (the code exchange, T-0019, and token renewal,
 * T-0021). Static metadata from the cached row, no discovery (ADR-0009
 * §Implementation Notes). This is the ONE place the library's setup findings
 * live; every vendor-facing operation gets the same transport, timeout, and
 * dev-flag gating by construction.
 */
export async function buildDelegatedClientConfiguration(
  provider: ConnectionProvider,
  credentialStore: SecretStore,
  opts: { allowInsecureConnection: boolean; timeoutMs: number; dispatcher: Agent },
): Promise<Configuration> {
  // Unsealed in-memory only, and only for this call — the row holds sealed
  // material and nothing writes it back.
  const clientId = await credentialStore.open(provider.clientIdMaterial);
  const clientSecret = await credentialStore.open(provider.clientSecretMaterial);
  const config = new Configuration(
    {
      issuer: new URL(provider.tokenEndpoint).origin,
      authorization_endpoint: provider.authorizeEndpoint,
      token_endpoint: provider.tokenEndpoint,
    },
    clientId,
    clientSecret,
  );
  // Version-verified against the pinned lockfile (6.8.4): `timeout` defaults
  // to undefined and NO AbortSignal is applied to the token request — the
  // docs' "default is 30 seconds" describes a later version. A hung token
  // endpoint would hang the operation forever without setting this.
  config.timeout = vendorTimeoutSeconds(opts.timeoutMs);
  // Also verified: a directly-constructed Configuration is `tlsOnly: true` —
  // http endpoints are refused outright unless this flips. The dev fixture
  // vendor and localhost endpoints are http (EGRESS_ALLOW_*; refused in prod).
  if (opts.allowInsecureConnection) allowInsecureRequests(config);
  // The ONE transport seam: every library HTTP call rides the same DNS-pinned
  // dispatcher the fetch-proxy uses, so the SSRF controls and the trace
  // boundary survive the library boundary (ADR-0009 §Shared ground).
  config[CUSTOM_FETCH] = makePinnedFetch(opts.dispatcher);
  return config;
}

/** The vendor token endpoint's timeout, in the seconds `Configuration.timeout`
 * wants. The whole operation must fit inside the request-timeout budget. */
function vendorTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}
