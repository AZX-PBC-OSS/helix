import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { EdgeConfig } from "../config.js";
import type { BlobReader, BlobGetResult } from "../blob/client.js";
import type { RegistryEntry, RegistryReader } from "../registry/projection.js";
import type { SessionGate } from "../auth/gate.js";
import { visibilityModeAllowed } from "../auth/validate.js";
import { sendForbidden, sendGone, sendNotFound, sendUnavailable } from "../errors.js";
import { normalizeRequestPath } from "./paths.js";
import { buildAppCsp } from "./csp.js";
import { SHIM_PATH, injectHeadScripts } from "./shim.js";
import { SW_REGISTER_PATH } from "./serviceWorker.js";

/**
 * The app-host request path (architecture §4.3): resolve slug → live version
 * → session gate → blob key, stream the asset. Single-page apps get `/` →
 * index.html plus an index.html fallback for HTML-accepting misses
 * (client-side routers). Assets are served only after the auth check — there
 * are no public blob endpoints.
 */
export interface AssetHandlerDeps {
  config: EdgeConfig;
  registry: RegistryReader;
  blob: BlobReader;
  /** The session gate; absent only when the auth stack isn't wired. */
  gate?: SessionGate | null;
}

export function makeAssetHandler(deps: AssetHandlerDeps) {
  const { config, registry, blob, gate } = deps;

  return async function assetHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    // App-supplied service workers are refused: a root-scoped worker sees every
    // same-origin navigation — including the one-time handoff token on
    // `/_auth/complete?token=…` — before the edge does, and could convert a
    // user's in-browser login into a durable headless session. Browsers send
    // `Service-Worker: script` on every registration fetch, so refusing it here
    // kills registration while ordinary web workers keep working.
    //
    // The offline capability (ADR-0035) is the one exception, and it does not
    // widen this check: the worker it registers is **platform code** served from
    // a reserved `/_helix/` route that never reaches this handler, confined to a
    // validated non-root scope. No app bytes are ever registrable.
    if (req.headers["service-worker"] !== undefined) {
      sendForbidden(reply);
      return;
    }

    if (!registry.isLoaded()) {
      sendUnavailable(reply, "Registry unavailable; try again shortly.");
      return;
    }

    const entry = registry.getApp(slug);
    if (!entry) {
      sendNotFound(reply);
      return;
    }
    if (entry.archived) {
      sendGone(reply);
      return;
    }
    // Unknown slug and known-but-nothing-live answer identically.
    if (!entry.blobPrefix) {
      sendNotFound(reply);
      return;
    }

    // Operator policy: `public`/`password` are open surfaces this deployment
    // may forbid (EDGE_ALLOW_*_APPS). A disallowed mode is refused outright —
    // even an app already set that way — 403, never served. The owner migrates
    // it down to private/group in the portal to restore service.
    if (!visibilityModeAllowed(entry.visibilityMode, config)) {
      sendForbidden(reply);
      return;
    }

    // The session gate (architecture §4.2). The dev bypass narrows its M2
    // meaning to "skip the gate" — serving still requires the registry entry
    // above, and loadConfig refuses the flag in production. `public` apps
    // (app-data design §6) are served to everyone with no session and never
    // touch the gate; every other mode stays behind it.
    if (!config.allowUnauthenticated && entry.visibilityMode !== "public") {
      if (!gate) {
        sendUnavailable(
          reply,
          "App serving requires authentication. Configure EDGE_OIDC_* (or set EDGE_DEV_ALLOW_UNAUTHENTICATED=true for local dev).",
        );
        return;
      }
      const session = await gate(req, reply, entry);
      if (!session) return; // the gate already responded (302/401)
    }

    const path = normalizeRequestPath(req.raw.url ?? "/");
    if (path === null) {
      sendNotFound(reply);
      return;
    }

    const method = req.method === "HEAD" ? "HEAD" : "GET";
    const relPath = path === "/" ? "index.html" : path.slice(1);
    const ifNoneMatch = firstHeader(req.headers["if-none-match"]);
    // Per-app CSP: baseline widened with this app's approved external origins.
    const csp = buildAppCsp(entry.externalOrigins);

    // Serve-time HTML rewrites: the fetch-proxy shim (§3.2) and/or the offline
    // capability's service-worker registration (ADR-0035). Either one means we
    // rewrite the document, so force the full body for the doc we'll inject into
    // (a 304 would skip injection) and serve it without an etag below. Only the
    // GET of an HTML-ish path is affected; other assets keep their conditional
    // path. An app may hold both grants, so the tags compose.
    const injectSrcs: string[] = [];
    if (method === "GET") {
      if (entry.fetch.shim) injectSrcs.push(SHIM_PATH);
      if (entry.offline) injectSrcs.push(SW_REGISTER_PATH);
    }
    const wantsInjection = injectSrcs.length > 0;
    const likelyHtml = relPath === "index.html" || (req.headers.accept ?? "").includes("text/html");
    const effectiveInm = wantsInjection && likelyHtml ? undefined : ifNoneMatch;

    let result = await getUnderPrefix(blob, entry.blobPrefix, relPath, {
      method,
      ifNoneMatch: effectiveInm,
    });

    // SPA fallback: an HTML-navigation miss serves the app shell so deep
    // links into client-side routes work. Asset misses stay hard 404s.
    //
    // Scope-aware for an offline app (ADR-0035 §10): such an app is served from
    // a prefix and its bundle has no *root* `index.html`, so falling back to the
    // bundle root would 404 every deep link. A miss under the granted scope
    // falls back to that scope's own shell instead.
    const shellPath = shellFor(entry, path);
    if (
      result.kind === "not-found" &&
      relPath !== shellPath &&
      (req.headers.accept ?? "").includes("text/html")
    ) {
      result = await getUnderPrefix(blob, entry.blobPrefix, shellPath, {
        method,
        ifNoneMatch: effectiveInm,
      });
    }

    if (result.kind === "not-found") {
      sendNotFound(reply);
      return;
    }

    const isHtml = (result.kind === "found" ? (result.contentType ?? "") : "").startsWith(
      "text/html",
    );
    // HTML revalidates every time so pointer flips are immediately visible;
    // other assets may be 5 minutes stale (`private`: app content becomes
    // authenticated in M3 and must never land in shared caches).
    const cacheControl = result.kind === "found" && !isHtml ? "private, max-age=300" : "no-cache";

    if (result.kind === "not-modified") {
      reply.status(304).header("cache-control", "no-cache").header("content-security-policy", csp);
      if (result.etag) reply.header("etag", result.etag);
      reply.send();
      return;
    }

    // Injection: buffer this one HTML doc, insert the platform `<script>` tags,
    // and send it as a string. No etag/last-modified — the injected bytes differ
    // from the Blob's, so a conditional 304 must never short-circuit injection.
    // Bounded to opt-in HTML (small); every other asset keeps streaming.
    if (wantsInjection && isHtml) {
      const injected = injectHeadScripts(await streamToString(result.body), injectSrcs);
      reply
        .status(200)
        .header("content-type", result.contentType ?? "text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", csp)
        .header("content-length", Buffer.byteLength(injected));
      await reply.send(injected);
      return;
    }

    reply
      .status(200)
      .header("content-type", result.contentType ?? "application/octet-stream")
      .header("cache-control", cacheControl)
      .header("x-content-type-options", "nosniff")
      // On EVERY response, not just HTML: any browser-active document type
      // (SVG, XML, …) can carry script, and CSP on inert assets is harmless.
      .header("content-security-policy", csp);
    if (result.contentLength) reply.header("content-length", result.contentLength);
    if (result.etag) reply.header("etag", result.etag);
    if (result.lastModified) reply.header("last-modified", result.lastModified);

    // Stop pulling from Blob if the client goes away mid-stream.
    req.raw.on("close", () => {
      if (req.raw.destroyed && result.kind === "found") result.body.destroy();
    });

    // Fastify pipes the stream — assets are never buffered (project plan §1).
    await reply.send(result.body);
  };
}

/**
 * The bundle-relative shell an HTML miss falls back to (ADR-0035 §10).
 *
 * Normally the bundle root's `index.html`. For an app holding the offline grant,
 * a miss *inside* its scope falls back to that scope's own shell instead —
 * because such an app is served from a prefix, its zip nests under that prefix
 * (URL path maps literally to blob key), and there is no root `index.html` to
 * find. A miss outside the scope keeps the root behaviour, so an app that also
 * ships a landing page at `/` is unaffected.
 */
function shellFor(entry: RegistryEntry, path: string): string {
  const scope = entry.offline?.scope;
  if (scope !== undefined && `${path}/`.startsWith(scope)) {
    return `${scope.slice(1)}index.html`;
  }
  return "index.html";
}

async function getUnderPrefix(
  blob: BlobReader,
  blobPrefix: string,
  relPath: string,
  opts: { method: "GET" | "HEAD"; ifNoneMatch?: string },
): Promise<BlobGetResult> {
  const key = `${blobPrefix}${relPath}`;
  // Bug trap, not input validation — normalizeRequestPath already rejected
  // traversal, so a violation here is a programming error. Detect an actual
  // `..` path segment, not the substring: `vendor..min.js` is a legal name.
  if (!key.startsWith(blobPrefix) || key.includes("/../") || key.endsWith("/..")) {
    throw new Error(`asset key escaped version prefix: ${key}`);
  }
  return blob.get(key, opts);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Drain a Blob body to a string — only for the opt-in shim HTML rewrite. */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
