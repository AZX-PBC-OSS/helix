import { type IncomingHttpHeaders } from "node:http";
import { Agent, request } from "undici";
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

/** Header names whose values are URLs that could echo back an injected query secret. */
const URL_VALUED_RESPONSE_HEADERS = new Set(["location", "content-location"]);

/**
 * Redact an injected `query`-recipe secret from a URL-valued response header
 * (issue #7). An upstream that reflects the request URL in `Location` would
 * otherwise carry `?<param>=<secret>` back to the app. Leaves other headers
 * untouched; if the value doesn't parse as a URL carrying the param, returns it
 * unchanged (a relative `Location` can't be resolved without the request base,
 * so a param match there is dropped by returning "REDACTED" only on parse hits).
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

/** Build the connect URL that points TCP at the validated IP, path/query intact. */
function connectUrlFor(target: URL, address: string, family: 4 | 6): string {
  const authority = family === 6 ? `[${address}]` : address;
  const port = target.port ? `:${target.port}` : "";
  return `${target.protocol}//${authority}${port}${target.pathname}${target.search}`;
}

export function makeProxyHandler(deps: ProxyDeps) {
  return async function proxyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.headers[INSTRUCTION_HEADER];
    const targetRaw = req.headers[TARGET_HEADER];
    const method = (req.headers[METHOD_HEADER] ?? "GET").toString().toUpperCase();
    if (typeof token !== "string" || typeof targetRaw !== "string") {
      return fail(reply, 400, "bad_target", "missing instruction or target");
    }

    const instruction = await verifyInstruction(token, deps.instructionKey);
    if (!instruction) return fail(reply, 401, "forbidden", "invalid attested instruction");

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
      );
      if (!resolved) {
        return fail(reply, 403, "forbidden", "connection not found or not granted");
      }
      injected = applyInjection(target, headers, resolved.injection, resolved.value);
    }

    // SSRF: resolve + validate every address, then pin the connection to it.
    let pinned;
    try {
      pinned = await resolveAndValidate(target.hostname, deps.allowPrivate);
    } catch (err) {
      if (err instanceof SsrfBlockedError) return fail(reply, 403, "blocked", err.message);
      return fail(reply, 502, "upstream_error", "target resolution failed");
    }

    // TCP to the validated IP; SNI/cert checked against the real hostname; Host
    // header carries the original authority. undici does not follow redirects by
    // default — a 302 to the IMDS IP is returned to the app as data, never chased.
    const dispatcher = new Agent({
      connect: { servername: target.hostname },
      headersTimeout: deps.limits.timeoutMs,
      bodyTimeout: deps.limits.timeoutMs,
    });
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
      const upstream = await request(connectUrlFor(target, pinned.address, pinned.family), {
        method,
        headers: { ...headers, host: target.host },
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
      // filter closes this — it is an accepted transparent-proxy residual.
      // Close the per-request dispatcher once the body has fully streamed.
      upstream.body.on("close", () => void dispatcher.close().catch(() => {}));
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
    } catch {
      await dispatcher.close().catch(() => {});
      if (requestCapTripped) {
        return fail(reply, 413, "too_large", "request body exceeds the size cap");
      }
      return fail(reply, 502, "upstream_error", "upstream request failed");
    }
  };
}
