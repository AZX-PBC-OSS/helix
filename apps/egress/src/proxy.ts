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
} from "@helix/shared";
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

function applyInjection(
  target: URL,
  headers: Record<string, string>,
  recipe: InjectionRecipe,
  value: string,
): void {
  switch (recipe.kind) {
    case "header-bearer":
      headers["authorization"] = `Bearer ${value}`;
      return;
    case "header":
      headers[recipe.name.toLowerCase()] = recipe.template.replace("{}", value);
      return;
    case "query":
      target.searchParams.set(recipe.param, value);
      return;
  }
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

    const headers = safeRequestHeaders(req.headers);

    // Resolve + inject the connection secret, if this call is secret-backed.
    if (instruction.connection) {
      if (!deps.resolver) {
        return fail(reply, 502, "upstream_error", "secret store not configured");
      }
      const resolved = await deps.resolver.resolve(instruction.appId, instruction.connection);
      if (!resolved) {
        return fail(reply, 403, "forbidden", "connection not found or not granted");
      }
      applyInjection(target, headers, resolved.injection, resolved.value);
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
    try {
      const upstream = await request(connectUrlFor(target, pinned.address, pinned.family), {
        method,
        headers: { ...headers, host: target.host },
        body: BODYLESS.has(method) ? undefined : req.raw,
        dispatcher,
      });

      const len = Number(upstream.headers["content-length"]);
      if (Number.isFinite(len) && len > deps.limits.maxBodyBytes) {
        upstream.body.destroy();
        return fail(reply, 502, "upstream_error", "upstream response too large");
      }

      reply.header(OUTCOME_HEADER, "ok");
      reply.code(upstream.statusCode);
      for (const [k, v] of Object.entries(upstream.headers)) {
        // content-length is dropped: we re-stream, so Fastify frames the body.
        if (!RESPONSE_BLOCKED.has(k) && k !== "content-length" && v !== undefined) {
          reply.header(k, v);
        }
      }
      // Close the per-request dispatcher once the body has fully streamed.
      upstream.body.on("close", () => void dispatcher.close().catch(() => {}));
      return reply.send(upstream.body);
    } catch {
      await dispatcher.close().catch(() => {});
      return fail(reply, 502, "upstream_error", "upstream request failed");
    }
  };
}
