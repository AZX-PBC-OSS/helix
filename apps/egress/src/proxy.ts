import { type IncomingHttpHeaders } from "node:http";
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
} from "@azx-pbc/shared";
import { capBody } from "@azx-pbc/shared/bodyCap";
import { verifyInstruction } from "./instruction.js";
import { type SecretResolver } from "./secrets.js";
import { type InstructionBurnStore } from "./burn.js";
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
 * strip exactly that back out (issue #7). The `header` recipe takes an arbitrary
 * app-defined name, so a static blocklist can never enumerate every credential
 * header — only recording what we injected covers it.
 */
interface Injected {
  headerName: string | null;
  queryParam: string | null;
}

const NOTHING_INJECTED: Injected = { headerName: null, queryParam: null };

function applyInjection(
  target: URL,
  headers: Record<string, string>,
  recipe: InjectionRecipe,
  value: string,
): Injected {
  switch (recipe.kind) {
    case "header-bearer":
      headers["authorization"] = `Bearer ${value}`;
      return { headerName: "authorization", queryParam: null };
    case "header": {
      const name = recipe.name.toLowerCase();
      headers[name] = recipe.template.replace("{}", value);
      return { headerName: name, queryParam: null };
    }
    case "query":
      target.searchParams.set(recipe.param, value);
      return { headerName: null, queryParam: recipe.param };
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

  async function proxyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
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
      const resolved = await deps.resolver.resolve(
        instruction.appId,
        instruction.connection,
        instruction.capability,
        instruction.env,
      );
      if (!resolved) {
        return fail(reply, 403, "forbidden", "connection not found or not granted");
      }
      injected = applyInjection(target, headers, resolved.injection, resolved.value);
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

      reply.header(OUTCOME_HEADER, "ok");
      reply.code(upstream.statusCode);
      // Dynamically strip the exact header we injected so an upstream that
      // reflects it (echo/debug endpoints, CORS reflection) can't leak the
      // credential back to the app (issue #7). This covers arbitrary `header`
      // recipe names that no static blocklist could enumerate.
      const stripped = injected.headerName
        ? new Set([...RESPONSE_BLOCKED, injected.headerName])
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
      return fail(reply, 502, "upstream_error", "upstream request failed");
    }
  }

  return { handler: proxyHandler, dispatcher };
}
