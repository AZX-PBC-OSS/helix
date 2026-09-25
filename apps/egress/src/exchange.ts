import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  Configuration,
  authorizationCodeGrant,
  allowInsecureRequests,
  customFetch as CUSTOM_FETCH,
} from "openid-client";
import type { Agent } from "undici";
import {
  EXCHANGE_AUTH_HEADER,
  type ConnectionProvider,
  type Env,
  ExchangeRequestSchema,
  type ExchangeRequest,
  type ExchangeResponse,
  type ExchangeRejectionReason,
} from "@azx-pbc/shared";
import { capBody } from "@azx-pbc/shared/bodyCap";
import {
  ATTR_ENV,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  ATTR_REASON,
  SPAN_EGRESS_EXCHANGE,
  type EgressExchangeOutcome,
} from "@azx-pbc/shared/telemetry";
import type { SecretStore } from "@azx-pbc/secret-store";
import type { ProviderCacheReader } from "./providerCache.js";
import { verifyExchangeToken } from "./internalJwt.js";
import { egressSpanAttributes } from "./spanAttributes.js";
import { instruments, tracer } from "./telemetry.js";
import { makePinnedFetch } from "./exchangeTransport.js";

/**
 * `POST /exchange` — the code-exchange operation (I-02 T-0019, architecture
 * ADR-0001): the portal's callback claims its pending attempt, then delegates
 * the vendor token exchange here, where the vendor is reachable and where
 * custody of delegated material lives. This is a NEW internal route,
 * deliberately not a bend of `POST /proxy` — that instruction contract binds
 * origin/method/path per app call, and an exchange has no app-side counterpart
 * for any of them.
 *
 * Order of operations, each fail-closed before anything riskier runs:
 *
 * 1. **Verify** the portal-minted exchange JWT (ADR-0003) — refused before any
 *    vendor call, before the body is even parsed.
 * 2. **Parse** the body through `ExchangeRequestSchema`.
 * 3. **Resolve** the provider from the revision-keyed cache (ADR-0004) — an
 *    unknown id, a stale revision stamp, or a wrong env answers
 *    `provider_unavailable` before any custody open.
 * 4. **Exchange** over the pinned transport (ADR-0009): the openid-client
 *    Configuration is assembled per provider revision from static metadata —
 *    no discovery — and every library HTTP call rides the same DNS-pinned
 *    dispatcher the fetch-proxy uses, so the SSRF controls and the trace
 *    boundary survive the library boundary.
 * 5. **Gate** the token response at receipt (criterion 27): a usable positive
 *    access-token lifetime, a refresh token present, every configured
 *    permission granted (an omitted granted-permissions field means granted).
 *    A rejection answers with a distinguishable, vendor-content-free reason
 *    and NOTHING is sealed — the delegated store receives no write.
 * 6. **Seal** both materials into the delegated store (ADR-0006) and return
 *    metadata plus sealed references — no plaintext token anywhere in the
 *    response.
 *
 * Token-endpoint failures follow the fixed-string discipline (ADR-0009): the
 * outcome word `exchange_failed` is the entire diagnostic on the wire, in
 * spans, and in logs — the library's error objects can embed vendor response
 * content, so they are never recorded, logged, or stringified here.
 */

/** The exchange body is protocol state (ids, a code, a verifier) — 16 KB is a
 * generous ceiling, and a body past it is malformed by definition. Not the
 * proxy's streaming cap; this one bounds a JSON parse. */
const EXCHANGE_MAX_BODY_BYTES = 16_384;

/** The vendor token endpoint's timeout, in the seconds `Configuration.timeout`
 * wants. The whole operation must fit inside the request-timeout budget. */
function vendorTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

export interface ExchangeDeps {
  /** HKDF-derived exchange-JWT verify key (shared derivation with the portal). */
  exchangeKey: Buffer;
  /** The revision-keyed provider cache; null ⇒ the operation is not wired. */
  providers: ProviderCacheReader | null;
  /** Opens the provider row's sealed client credentials (the existing app-secrets custody). */
  credentialStore: SecretStore | null;
  /** The delegated-custody store — seals the exchanged tokens (ADR-0006 part 1). */
  delegatedStore: SecretStore | null;
  allowPrivate: boolean;
  allowInsecureConnection: boolean;
  /** Bounds the vendor token-endpoint call (the request-timeout budget). */
  timeoutMs: number;
}

/** What the handler settled on — finalized onto the span + counter in `finally`. */
interface ExchangeRecord {
  outcome: EgressExchangeOutcome;
  env?: Env;
  reason?: ExchangeRejectionReason;
  providerRef?: string;
}

/**
 * The one refusal body shape for the transport-level answers (401/400/503) —
 * the same fixed-code convention the proxy's `fail()` uses. None of these
 * statuses is parsed through `ExchangeResponseSchema` by the caller; the
 * operation's outcome union rides 200 only.
 */
function refuse(reply: FastifyReply, status: number, code: string): void {
  reply.code(status).send({ code });
}

/** Read the request body under the byte cap and parse it through the schema. */
async function parseRequest(req: FastifyRequest): Promise<ExchangeRequest | null> {
  let text: string;
  try {
    const capped = capBody(req.raw, EXCHANGE_MAX_BODY_BYTES, "request", () => {});
    const chunks: Buffer[] = [];
    for await (const chunk of capped) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ExchangeRequestSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Assemble the library Configuration for ONE provider revision — static
 * metadata from the cached row, no discovery (ADR-0009 §Implementation
 * Notes). `issuer` is required to be a string by the library but is never
 * validated in a pure code flow (no id_token); the token endpoint's origin
 * stands in, because the provider row deliberately has no issuer field.
 */
async function buildConfiguration(
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

type TokenResponse = Awaited<ReturnType<typeof authorizationCodeGrant>>;

/**
 * The gate's verdict: the rejection reason, or the validated values the seal
 * step needs — narrowed once, so nothing past the gate re-derives or re-checks
 * them (the gate is the ONE place criterion 27 executes, ADR-0001 §Shared
 * ground).
 */
type GateVerdict =
  | { ok: false; reason: ExchangeRejectionReason }
  | {
      ok: true;
      expiresIn: number;
      refreshToken: string;
      /** What the vendor granted: the response's scopes, or the configured set
       * when the response omitted the field (omitted means granted). */
      grantedScopes: string[];
    };

/**
 * The criterion-27 compatibility gate, executed at receipt BEFORE sealing
 * (architecture ADR-0001 §Decision).
 */
function compatibilityGate(result: TokenResponse, provider: ConnectionProvider): GateVerdict {
  // A usable positive lifetime: `expires_in` may be absent (RFC 6749 makes it
  // RECOMMENDED and the library tolerates absence) — criterion 27 does not.
  if (
    typeof result.expires_in !== "number" ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0
  ) {
    return { ok: false, reason: "unusable_lifetime" };
  }
  if (typeof result.refresh_token !== "string" || result.refresh_token.length === 0) {
    return { ok: false, reason: "missing_refresh_token" };
  }
  // An omitted granted-permissions field means granted (criterion 27); a
  // present field must include every configured permission — a strict
  // superset is accepted, because vendors add scopes they always grant.
  if (result.scope === undefined) {
    return {
      ok: true,
      expiresIn: result.expires_in,
      refreshToken: result.refresh_token,
      grantedScopes: [...provider.requestedScopes],
    };
  }
  const granted = result.scope.split(" ").filter((s) => s.length > 0);
  if (provider.requestedScopes.some((scope) => !granted.includes(scope))) {
    return { ok: false, reason: "missing_permissions" };
  }
  return {
    ok: true,
    expiresIn: result.expires_in,
    refreshToken: result.refresh_token,
    grantedScopes: granted,
  };
}

export function makeExchangeHandler(deps: ExchangeDeps & { dispatcher: Agent }) {
  /**
   * The verified half — resolution, the vendor call, the gate, and sealing.
   * Every failure maps to a fixed outcome; nothing rethrows.
   */
  async function runExchange(
    req: FastifyRequest,
    reply: FastifyReply,
    parsed: ExchangeRequest,
    record: ExchangeRecord,
  ): Promise<void> {
    const { providers, credentialStore, delegatedStore } = deps;
    if (!providers || !credentialStore || !delegatedStore) {
      record.outcome = "unconfigured";
      return refuse(reply, 503, "exchange_unavailable");
    }

    // Provider resolution from the revision-keyed cache (ADR-0004): unknown,
    // deleted, or a stale revision stamp — all the one fixed word.
    const provider = providers.get(parsed.providerId);
    if (!provider || provider.revision !== parsed.providerRevision || provider.env !== parsed.env) {
      record.outcome = "provider_unavailable";
      return reply.code(200).send({ outcome: "provider_unavailable" } satisfies ExchangeResponse);
    }
    record.providerRef = provider.ref;

    let result: TokenResponse;
    try {
      const config = await buildConfiguration(provider, credentialStore, {
        allowInsecureConnection: deps.allowInsecureConnection,
        timeoutMs: deps.timeoutMs,
        dispatcher: deps.dispatcher,
      });
      // The redirect_uri is the callback exactly as configured (the consult's
      // edge-supplied value, ADR-0001 §Implementation Notes); the library
      // strips it back out of `currentUrl` for the token request's
      // `redirect_uri` parameter, and `code` is the only other parameter —
      // the attempt's `state` was already verified at the callback, and a
      // `state` present in currentUrl would fail the library's response
      // validation (verified against the pin: expectedState is undefined).
      const currentUrl = new URL(parsed.redirectUri);
      currentUrl.searchParams.set("code", parsed.code);
      result = await authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: parsed.codeVerifier,
      });
    } catch {
      // Deliberately NOT `span.recordException(err)` and deliberately not
      // inspected: the library's error text can embed the vendor's response
      // body (oauth4webapi carries the whole body in `cause`), and this
      // plane's error paths can embed credential material. The outcome word
      // is the signal; nothing about the error travels.
      req.log.warn(
        { event: "exchange.failed", reason: "vendor_exchange_failed" },
        "token endpoint exchange failed",
      );
      record.outcome = "exchange_failed";
      return reply.code(200).send({ outcome: "exchange_failed" } satisfies ExchangeResponse);
    }

    // The gate at receipt, BEFORE sealing — a rejection leaves the delegated
    // store untouched (observable, and the binding invariant of the gate's
    // placement).
    const verdict = compatibilityGate(result, provider);
    if (!verdict.ok) {
      record.outcome = "rejected";
      record.reason = verdict.reason;
      req.log.warn(
        { event: "exchange.rejected", reason: verdict.reason, provider: provider.ref },
        "token response failed the criterion-27 compatibility gate",
      );
      return reply
        .code(200)
        .send({ outcome: "rejected", reason: verdict.reason } satisfies ExchangeResponse);
    }

    // Seal both materials. A seal failure is a custody failure, not a vendor
    // one — the same fixed outcome (an operator checks the vault), and the
    // one-material orphan it can leave is ADR-0008's recorded residual class.
    try {
      const access = await delegatedStore.seal(result.access_token);
      const refresh = await delegatedStore.seal(verdict.refreshToken);
      record.outcome = "exchanged";
      return reply.code(200).send({
        outcome: "exchanged",
        access,
        refresh,
        grantedScopes: verdict.grantedScopes,
        accessExpiresAt: new Date(Date.now() + verdict.expiresIn * 1000).toISOString(),
      } satisfies ExchangeResponse);
    } catch {
      req.log.warn(
        { event: "exchange.failed", reason: "seal_failed", provider: provider.ref },
        "sealing the exchanged tokens failed",
      );
      record.outcome = "exchange_failed";
      return reply.code(200).send({ outcome: "exchange_failed" } satisfies ExchangeResponse);
    }
  }

  return async function exchangeHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const record: ExchangeRecord = { outcome: "exchange_failed" };

    // Authentication BEFORE the span parent (the proxyHandler pattern; ADR-0037
    // decision 7): the caller is the portal, over a hop whose authority is the
    // minted exchange token, so extraction joins the portal's trace only once
    // that token verifies.
    const header = req.headers[EXCHANGE_AUTH_HEADER];
    const token = typeof header === "string" ? header : undefined;
    const verified = await verifyExchangeToken(token, deps.exchangeKey);
    const parent = verified ? propagation.extract(context.active(), req.headers) : ROOT_CONTEXT;
    const span = tracer.startSpan(
      SPAN_EGRESS_EXCHANGE,
      { kind: SpanKind.SERVER, root: !verified },
      parent,
    );

    try {
      if (!verified) {
        record.outcome = "unauthorized";
        // No body parse, no provider lookup, no vendor call.
        return refuse(reply, 401, "forbidden");
      }

      const parsed = await parseRequest(req);
      if (!parsed) {
        record.outcome = "malformed";
        return refuse(reply, 400, "bad_request");
      }
      record.env = parsed.env;

      return await context.with(trace.setSpan(parent, span), () =>
        runExchange(req, reply, parsed, record),
      );
    } catch {
      // An unhandled throw (a custody open rejected, a body read failed in an
      // unexpected way). Same fixed-string discipline: the error is not
      // recorded on the span and not serialized anywhere — the fixed outcome
      // word is the entire answer.
      record.outcome = "exchange_failed";
      req.log.warn(
        { event: "exchange.failed", reason: "exchange_threw" },
        "exchange operation failed unexpectedly",
      );
      return reply.code(200).send({ outcome: "exchange_failed" } satisfies ExchangeResponse);
    } finally {
      span.setAttributes(
        egressSpanAttributes({
          [ATTR_OUTCOME]: record.outcome,
          [ATTR_ENV]: record.env,
          [ATTR_REASON]: record.reason,
          [ATTR_PROVIDER_REF]: record.providerRef,
        }),
      );
      if (record.outcome === "exchange_failed") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      const dims: Record<string, string> = { [ATTR_OUTCOME]: record.outcome };
      if (record.env !== undefined) dims[ATTR_ENV] = record.env;
      instruments().exchanges.add(1, dims);
      span.end();
    }
  };
}
