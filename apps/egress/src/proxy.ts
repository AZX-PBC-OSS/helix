import { type IncomingHttpHeaders } from "node:http";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { Agent, buildConnector, request } from "undici";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  type FetchErrorCode,
  type InjectionRecipe,
  INSTRUCTION_HEADER,
  METHOD_HEADER,
  OUTCOME_HEADER,
  REQUEST_HEADER_SAFELIST,
  RESPONSE_HEADER_BLOCKLIST,
  TARGET_HEADER,
  parseHmacCredential,
} from "@azx-pbc/shared";
import { capBody } from "@azx-pbc/shared/bodyCap";
import { hmacTimestampNow, renderHmacAuth, signTimestamp, substitute } from "./hmac.js";
import { verifyInstruction } from "./instruction.js";
import { RecipeDriftError, type SecretResolver } from "./secrets.js";
import { type InstructionBurnStore } from "./burn.js";
import {
  ATTR_APP_ID,
  ATTR_CAPABILITY,
  ATTR_CLIENT_DISCONNECTED,
  ATTR_CONNECTION,
  ATTR_ENV,
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_TARGET_ORIGIN,
  ATTR_TARGET_PATH,
  ATTR_UPSTREAM_STATUS,
  SPAN_EGRESS_PROXY,
} from "@azx-pbc/shared/telemetry";
import { instruments, tracer } from "./telemetry.js";
import { egressSpanAttributes } from "./spanAttributes.js";
import { SsrfBlockedError, resolveAndValidate } from "./ssrf.js";

/**
 * `POST /proxy` — the one route that touches plaintext secrets and the public
 * internet (architecture §3, fetch-proxy design §6/§7). It trusts the edge's
 * attested instruction, resolves a connection secret if named, applies SSRF
 * controls, injects the credential server-side, and streams the upstream
 * response straight back. Internal-only: never exposed to app users.
 */

export interface ProxyDeps {
  instructionKey: Buffer;
  /** null ⇒ no secret store configured; secret-backed calls are refused. */
  resolver: SecretResolver | null;
  /** null ⇒ replay protection disabled (tests only); prod always sets it. */
  burnStore: InstructionBurnStore | null;
  limits: { maxBodyBytes: number; timeoutMs: number };
  /** Dev/test seam — permit private/loopback targets (false in prod & adversarial tests). */
  allowPrivate: boolean;
  /** Dev/test seam — permit secret injection into a cleartext http target (false in prod). */
  allowInsecureConnection: boolean;
}

const REQUEST_SAFE = new Set(REQUEST_HEADER_SAFELIST);
const RESPONSE_BLOCKED = new Set(RESPONSE_HEADER_BLOCKLIST);
const BODYLESS = new Set(["GET", "HEAD"]);

function fail(reply: FastifyReply, status: number, code: FetchErrorCode, message: string): void {
  reply.header(OUTCOME_HEADER, status >= 500 ? "error" : "refusal");
  reply.code(status).send({ code, message });
}

/** Forward only the safelisted request headers; cookie/authorization never go out. */
function safeRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REQUEST_SAFE.has(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * What `applyInjection` wrote into the outbound request, so the response loop can
 * strip exactly that back out (issue #7). The `header` and `hmac-timestamp`
 * recipes take arbitrary configured names, so a static blocklist can never
 * enumerate every credential header — only recording what we injected covers it.
 *
 * `headerNames` is a list because `hmac-timestamp` writes two (the timestamp and
 * the signature). The strip set is built from exactly this list, so the property
 * holds by construction: whatever we wrote, we strip.
 */
interface Injected {
  headerNames: readonly string[];
  queryParam: string | null;
}

const NOTHING_INJECTED: Injected = { headerNames: [], queryParam: null };

/**
 * Apply the resolved credential to the outbound request.
 *
 * Recipe header names are normalised to lowercase by the schema, so the names
 * recorded here always match the lowercased keys of an upstream response — which
 * is what makes the reflection strip below able to find them.
 *
 * May throw (a malformed `hmac-timestamp` blob). The caller contains that: the
 * message can carry credential material, so it must reach neither the app nor the
 * log.
 */
function applyInjection(
  target: URL,
  headers: Record<string, string>,
  recipe: InjectionRecipe,
  value: string,
): Injected {
  switch (recipe.kind) {
    case "header-bearer":
      headers["authorization"] = `Bearer ${value}`;
      return { headerNames: ["authorization"], queryParam: null };
    case "header": {
      headers[recipe.name] = substitute(recipe.template, "{}", value);
      return { headerNames: [recipe.name], queryParam: null };
    }
    case "query":
      target.searchParams.set(recipe.param, value);
      return { headerNames: [], queryParam: recipe.param };
    case "hmac-timestamp": {
      const { credential, key } = parseHmacCredential(value);
      // One clock reading, used for both the signature and the header: two reads
      // would sign a timestamp that was never transmitted.
      const timestamp = hmacTimestampNow();
      headers[recipe.timestampHeader] = timestamp;
      headers[recipe.authHeader] = renderHmacAuth(
        recipe.template,
        credential,
        signTimestamp(key, timestamp),
      );
      return {
        headerNames: [recipe.timestampHeader, recipe.authHeader],
        queryParam: null,
      };
    }
  }
}

/**
 * Header names whose values are URLs that could echo back an injected query secret.
 * `location` is NOT here — it is stripped wholesale by the response blocklist so the
 * browser can't follow the redirect (ADR-0005, issue #10); only `content-location`
 * (which doesn't drive navigation) survives to be redacted.
 */
const URL_VALUED_RESPONSE_HEADERS = new Set(["content-location"]);

/**
 * Redact an injected `query`-recipe secret from a URL-valued response header
 * (issue #7). An upstream that reflects the request URL in `Content-Location`
 * would otherwise carry `?<param>=<secret>` back to the app. Leaves other headers
 * untouched; if the value doesn't parse as a URL carrying the param, returns it
 * unchanged (a relative URL can't be resolved without the request base, so a param
 * match there is dropped by returning "REDACTED" only on parse hits).
 */
function redactQueryParam(
  name: string,
  value: string | string[],
  param: string,
): string | string[] {
  if (!URL_VALUED_RESPONSE_HEADERS.has(name)) return value;
  const redactOne = (raw: string): string => {
    try {
      // Allow relative URLs by resolving against a throwaway base.
      const url = new URL(raw, "https://redacted.invalid");
      if (!url.searchParams.has(param)) return raw;
      url.searchParams.set(param, "REDACTED");
      // Preserve relative form: strip the throwaway base back off.
      return raw.startsWith(url.origin) ? url.href : url.href.slice(url.origin.length);
    } catch {
      return raw;
    }
  };
  return Array.isArray(value) ? value.map(redactOne) : redactOne(value);
}

/**
 * A shared connector that resolves + validates the target host and **pins the
 * socket to the validated IP** on every new connection, then hands off to
 * undici's default connector — so one long-lived {@link Agent} keeps connection
 * pooling (keep-alive across requests to the same origin) without losing the
 * SSRF IP-pin (ADR-0005 perf note). We dial the real origin (undici pools by
 * origin and sets SNI/Host from it); the connector only rewrites the socket
 * target to the validated IP.
 *
 * Validation runs per *new* socket. A pooled/keep-alive socket is already bonded
 * to a validated IP, so reuse can only ever reach that same address — a DNS
 * rebind between requests cannot redirect a live connection, and the next fresh
 * connection re-resolves and re-validates. `resolveAndValidate` throws
 * {@link SsrfBlockedError} for a blocked or unresolvable host; undici propagates
 * it verbatim to the `request()` rejection, where the handler maps it to a 403
 * `blocked` (preserving the old upfront-check semantics).
 */
function makeValidatingConnector(
  allowPrivate: boolean,
  timeoutMs: number,
): buildConnector.connector {
  const base = buildConnector({ timeout: timeoutMs });
  return function connect(opts, callback): void {
    resolveAndValidate(opts.hostname, allowPrivate).then(
      (pinned) => {
        // Dial the validated IP literal; keep SNI + cert identity on the real
        // hostname. undici leaves `servername` unset for the connector, so it
        // must be pinned here exactly as the old per-request `connect.servername`
        // did — otherwise the default connector would derive SNI from the IP.
        base(
          { ...opts, hostname: pinned.address, servername: opts.servername ?? opts.hostname },
          callback,
        );
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), null),
    );
  };
}

export interface ProxyHandler {
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** The shared dispatcher — close it on app teardown to drain pooled sockets. */
  dispatcher: Agent;
}

export function makeProxyHandler(deps: ProxyDeps): ProxyHandler {
  // One shared dispatcher for the process lifetime: the SSRF validate-and-pin
  // moved into the connector (see makeValidatingConnector), so pooling/keep-alive
  // is recovered without losing the IP-pin (ADR-0005 perf note). Redirects are
  // still NEVER followed: undici 7 chases a redirect only when a `redirect`
  // interceptor is composed onto the dispatcher, and we compose none — a plain
  // Agent returns the 3xx verbatim (belt-and-suspenders, `Location` is also
  // stripped by the response blocklist so the browser can't chase it — issue #10).
  const dispatcher = new Agent({
    connect: makeValidatingConnector(deps.allowPrivate, deps.limits.timeoutMs),
    headersTimeout: deps.limits.timeoutMs,
    bodyTimeout: deps.limits.timeoutMs,
  });

  async function runProxy(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.headers[INSTRUCTION_HEADER];
    const targetRaw = req.headers[TARGET_HEADER];
    const method = (req.headers[METHOD_HEADER] ?? "GET").toString().toUpperCase();
    if (typeof token !== "string" || typeof targetRaw !== "string") {
      return fail(reply, 400, "bad_target", "missing instruction or target");
    }

    const instruction = await verifyInstruction(token, deps.instructionKey);
    if (!instruction) return fail(reply, 401, "forbidden", "invalid attested instruction");

    // One-time use: burn the jti before doing any work, so a captured
    // instruction re-POSTed inside its TTL is refused before the secret is
    // resolved or the upstream is dialed (ADR-0013 Step 1, issue #3). An empty
    // insert result means the jti was already spent — a replay.
    if (deps.burnStore && !(await deps.burnStore.burn(instruction.requestId))) {
      return fail(reply, 409, "replay", "attested instruction already used");
    }

    // Edge-signed claims only: the edge matched this origin against the app's
    // manifest allowlist before signing, so these are values the operator
    // granted rather than values the app chose.
    trace.getActiveSpan()?.setAttributes(
      egressSpanAttributes({
        [ATTR_APP_ID]: instruction.appId,
        [ATTR_ENV]: instruction.env,
        [ATTR_CAPABILITY]: instruction.capability,
        [ATTR_TARGET_ORIGIN]: instruction.origin,
        [ATTR_TARGET_PATH]: instruction.path,
        [ATTR_METHOD]: method,
        [ATTR_CONNECTION]: instruction.connection,
      }),
    );

    let target: URL;
    try {
      target = new URL(targetRaw);
    } catch {
      return fail(reply, 400, "bad_target", "target is not a valid URL");
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return fail(reply, 400, "bad_target", "only http(s) targets are proxied");
    }
    // The instruction binds the origin the edge authorized — egress re-checks it.
    if (target.origin !== instruction.origin) {
      return fail(reply, 403, "forbidden", "target origin does not match the authorization");
    }
    // ...and (ADR-0013 step 2, issue #6) the method + pathname, so a captured
    // instruction can't be redirected to a different verb/resource on that origin.
    // Assert only when bound (an old-edge instruction may omit them — rollout
    // safety; only the edge can sign, so absence isn't tampering).
    if (instruction.method !== undefined && instruction.method !== method) {
      return fail(reply, 403, "forbidden", "method does not match the authorization");
    }
    if (instruction.path !== undefined && instruction.path !== target.pathname) {
      return fail(reply, 403, "forbidden", "path does not match the authorization");
    }

    // Request body cap, fast-path: a truthful oversized content-length is
    // refused before we resolve a secret or dial out. The real enforcement is
    // the byte counter on the re-stream below — this only avoids wasted work
    // (issue #8).
    if (!BODYLESS.has(method)) {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > deps.limits.maxBodyBytes) {
        return fail(reply, 413, "too_large", "request body exceeds the size cap");
      }
    }

    const headers = safeRequestHeaders(req.headers);

    // Resolve + inject the connection secret, if this call is secret-backed.
    let injected = NOTHING_INJECTED;
    // Set for a recipe whose credential is derived from the local clock, so the
    // response can be checked for skew (see below).
    let clockDerived = false;
    if (instruction.connection) {
      // A connection secret must never cross the wire in cleartext. Egress is the
      // credential broker, so it enforces this independently of the edge's origin
      // allowlist — an http origin approved as a connection binding is still
      // refused here (issue #11, ADR-0005). The secret is not even resolved for a
      // cleartext target. `allowInsecureConnection` is a dev/test-only seam.
      if (target.protocol !== "https:" && !deps.allowInsecureConnection) {
        return fail(reply, 403, "forbidden", "secret-backed calls require https");
      }
      if (!deps.resolver) {
        return fail(reply, 502, "upstream_error", "secret store not configured");
      }
      // Resolution can now fail on the network (Key Vault) or on custody (RBAC,
      // a material referencing a deleted vault entry), not just return "no such
      // connection". Contain it here: an uncaught throw would reach Fastify's
      // default handler as a 500 whose body could echo the vault host or secret
      // name back to the untrusted app. Log the detail, return an opaque 502.
      let resolved: Awaited<ReturnType<typeof deps.resolver.resolve>>;
      try {
        resolved = await deps.resolver.resolve(
          instruction.appId,
          instruction.connection,
          instruction.capability,
          instruction.env,
        );
      } catch (err) {
        if (err instanceof RecipeDriftError) {
          // Not a custody failure. Logging it beside the vault probes below would
          // point an operator at Key Vault for a bad row, so it gets the same
          // `reason` code the injection guard uses — the two are the same class of
          // fault, caught at different depths.
          req.log.error(
            {
              appId: instruction.appId,
              connection: instruction.connection,
              reason: "injection_failed",
            },
            "stored connection secret does not fit its injection recipe",
          );
          return fail(reply, 502, "upstream_error", "connection secret unavailable");
        }
        // Surface the vault's own status/code explicitly. `KeyVaultError` carries them
        // precisely so an operator can tell 403-RBAC from 403-SecretDisabled, and
        // 404-integrity (a row referencing a deleted entry) from a transport failure —
        // none of which is deducible from the opaque 502 the app receives.
        const kv = err as { status?: unknown; code?: unknown };
        req.log.error(
          {
            err,
            appId: instruction.appId,
            connection: instruction.connection,
            vaultStatus: typeof kv.status === "number" ? kv.status : undefined,
            vaultCode: typeof kv.code === "string" ? kv.code : undefined,
          },
          "connection secret resolution failed",
        );
        return fail(reply, 502, "upstream_error", "connection secret unavailable");
      }
      if (!resolved) {
        return fail(reply, 403, "forbidden", "connection not found or not granted");
      }
      clockDerived = resolved.injection.kind === "hmac-timestamp";
      try {
        injected = applyInjection(target, headers, resolved.injection, resolved.value);
      } catch {
        // Deliberately binds nothing. A throw here means the material did not fit
        // its recipe (an `hmac-timestamp` blob that isn't one), and the message
        // can carry credential material — V8 embeds a ~10-character prefix of its
        // input in a `JSON.parse` error, which for this value is the start of a
        // private key. A `reason` code is the whole diagnostic value; the message
        // would add only leak surface, to the log as well as the response. This is
        // the opposite call from the resolve `catch` above, where the Key Vault
        // status/code genuinely carry operator signal and carry no secret.
        req.log.error(
          {
            appId: instruction.appId,
            connection: instruction.connection,
            recipe: resolved.injection.kind,
            reason: "injection_failed",
          },
          "connection secret could not be applied to the outbound request",
        );
        // The same opaque 502 as a resolution failure: an app must not be able to
        // probe *why* a credential did not work.
        return fail(reply, 502, "upstream_error", "connection secret unavailable");
      }
    }

    // SSRF: the shared dispatcher's connector resolves + validates every address
    // and pins the socket to it (see makeValidatingConnector) — a blocked or
    // unresolvable host throws SsrfBlockedError, surfaced on the `request()`
    // rejection below and mapped to 403 `blocked`.

    // Count the request bytes on the way out: a chunked / CL-absent / lying-CL
    // upload can't stream unbounded egress-billed bandwidth past the cap. A trip
    // destroys req.raw and errors the undici upload → the catch maps it to 413.
    let requestCapTripped = false;
    const requestBody = BODYLESS.has(method)
      ? undefined
      : capBody(req.raw, deps.limits.maxBodyBytes, "request", () => {
          requestCapTripped = true;
        });

    try {
      // Dial the real origin: undici pools by origin (keep-alive), derives the
      // Host header and TLS SNI from it, and the connector rewrites the socket
      // target to the validated IP.
      const upstream = await request(target.href, {
        method,
        headers,
        body: requestBody,
        dispatcher,
      });

      // Response cap, fast-path: a truthful oversized content-length is rejected
      // cleanly (before any body is committed) without draining the connection.
      const len = Number(upstream.headers["content-length"]);
      if (Number.isFinite(len) && len > deps.limits.maxBodyBytes) {
        upstream.body.destroy();
        return fail(reply, 502, "upstream_error", "upstream response too large");
      }

      // A clock-derived credential signs `now`, so egress clock drift past the
      // upstream's tolerance makes *every* call to that origin fail — and it
      // presents as the vendor's own 401 passed through, with no reason to suspect
      // us. Nothing in-process can detect that; the upstream's own `Date` header
      // can. This turns a silent total outage into a one-line diagnosis.
      if (clockDerived) {
        const upstreamDate = Date.parse(String(upstream.headers["date"] ?? ""));
        const skewMs = Number.isNaN(upstreamDate) ? 0 : Math.abs(Date.now() - upstreamDate);
        if (skewMs > 60_000) {
          req.log.warn(
            { origin: instruction.origin, appId: instruction.appId, skewMs },
            "egress clock differs from the upstream by more than a minute — " +
              "a timestamp-signed credential will be rejected",
          );
        }
      }

      reply.header(OUTCOME_HEADER, "ok");
      reply.code(upstream.statusCode);
      // Dynamically strip the exact headers we injected so an upstream that
      // reflects them (echo/debug endpoints, CORS reflection) can't leak the
      // credential back to the app (issue #7). This covers the arbitrary
      // configured names — the `header` recipe's, and `hmac-timestamp`'s
      // timestamp and signature headers — that no static blocklist could
      // enumerate. For `hmac-timestamp` the reflected pair is not the private key,
      // but it *is* a working credential for the upstream's whole clock-skew
      // window against any path on that origin, re-harvestable on every call —
      // outside the manifest allowlist, the budget, and `gateway_calls`.
      const stripped = injected.headerNames.length
        ? new Set([...RESPONSE_BLOCKED, ...injected.headerNames])
        : RESPONSE_BLOCKED;
      for (const [k, v] of Object.entries(upstream.headers)) {
        // content-length is dropped: we re-stream, so Fastify frames the body.
        if (stripped.has(k) || k === "content-length" || v === undefined) continue;
        // For a `query`-recipe secret, a 3xx Location echoing the request URL
        // would carry the secret in its query string — redact that param.
        reply.header(k, injected.queryParam ? redactQueryParam(k, v, injected.queryParam) : v);
      }
      // The response body is streamed verbatim: an upstream that echoes the
      // secret (or a `?key=…` URL) into the body reaches the app. No header
      // filter closes this — it is an accepted transparent-proxy residual. The
      // dispatcher is shared and long-lived, so the socket returns to the pool
      // when the body drains — never closed per-request (that would defeat the
      // pooling this connector exists to recover).
      // Count the response bytes: a chunked / CL-absent / lying-CL body can't
      // stream past the cap uncounted. Status + headers are already committed,
      // so a trip *truncates* the body (not a 502) — accepted per issue #8; we
      // surface it out-of-band on the log rather than to the app.
      const cappedBody = capBody(upstream.body, deps.limits.maxBodyBytes, "response", () => {
        req.log.warn(
          { origin: instruction.origin, appId: instruction.appId, limit: deps.limits.maxBodyBytes },
          "egress response body exceeded the size cap — truncated",
        );
      });
      return reply.send(cappedBody);
    } catch (err) {
      if (requestCapTripped) {
        return fail(reply, 413, "too_large", "request body exceeds the size cap");
      }
      // The connector throws SsrfBlockedError for a blocked/unresolvable host;
      // undici propagates it verbatim, so the old upfront-check semantics hold.
      if (err instanceof SsrfBlockedError) {
        return fail(reply, 403, "blocked", err.message);
      }
      // Everything else — a transport failure, a timeout, or undici refusing a
      // header it considers invalid — reaches the app as an opaque 502, which
      // previously left no trace at all on the one service that can't be debugged
      // by reproducing locally. undici's message names only the offending header
      // *key*, never its value, so logging the error here carries no secret.
      req.log.warn(
        {
          err,
          appId: instruction.appId,
          connection: instruction.connection,
          origin: target.origin,
        },
        "upstream request failed",
      );
      return fail(reply, 502, "upstream_error", "upstream request failed");
    }
  }

  /**
   * The egress span, and the one place in the platform that **extracts** trace
   * context (ADR-0037 decision 7).
   *
   * Extracting here is what makes a `/_api/fetch` call one trace instead of two
   * unjoinable halves in two Log Analytics workspaces — the thing the ADR names
   * as unseeable today. It is sound precisely here and nowhere else: the caller
   * is the edge, over a hop whose authority already comes from the signed
   * attested instruction (ADR-0013). The `traceparent` rides alongside that
   * instruction as correlation only; it is never read for policy, and the
   * verifier does not know it exists.
   *
   * The duration is recorded in the same `finally` as the span end, so the two
   * can never disagree — and both land after the response body has drained,
   * because Fastify's `Reply` is thenable (see `apps/edge/src/telemetry.ts`).
   */
  async function proxyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer.startSpan(SPAN_EGRESS_PROXY, { kind: SpanKind.SERVER }, parent);
    const startedAt = performance.now();
    try {
      return await context.with(trace.setSpan(parent, span), () => runProxy(req, reply));
    } catch (err) {
      // Deliberately NOT `span.recordException(err)`. On this plane an error
      // message can embed credential material — the same reason `app.ts`
      // returns a fixed opaque body and the injection `catch` below binds
      // nothing. A span is a retained backend; the status code is the signal,
      // and the detail stays on the log line that already redacts for it.
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      const outcome = String(reply.getHeader(OUTCOME_HEADER) ?? "ok");
      span.setAttributes(
        egressSpanAttributes({
          [ATTR_OUTCOME]: outcome,
          [ATTR_UPSTREAM_STATUS]: reply.statusCode,
          [ATTR_CLIENT_DISCONNECTED]: reply.raw.writableEnded ? undefined : true,
        }),
      );
      instruments().proxyDuration.record(performance.now() - startedAt, {
        [ATTR_OUTCOME]: outcome,
      });
      span.end();
    }
  }

  return { handler: proxyHandler, dispatcher };
}
