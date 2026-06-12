import type { FastifyReply, FastifyRequest } from "fastify";
import type { EdgeConfig } from "../config.js";
import type { BlobReader, BlobGetResult } from "../blob/client.js";
import type { RegistryReader } from "../registry/projection.js";
import { sendGone, sendNotFound, sendUnavailable } from "../errors.js";
import { normalizeRequestPath } from "./paths.js";
import { APP_CSP } from "./csp.js";

/**
 * The app-host request path (architecture §4.3): resolve slug → live version →
 * blob key, stream the asset. Single-page apps get `/` → index.html plus an
 * index.html fallback for HTML-accepting misses (client-side routers).
 */
export interface AssetHandlerDeps {
  config: EdgeConfig;
  registry: RegistryReader;
  blob: BlobReader;
}

export function makeAssetHandler(deps: AssetHandlerDeps) {
  const { config, registry, blob } = deps;

  return async function assetHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<void> {
    // M2 has no sessions; serving is gated on the dev bypass so the default
    // is fail-closed until M3 auth lands (project plan §4 M2).
    if (!config.allowUnauthenticated) {
      sendUnavailable(
        reply,
        "App serving requires authentication (M3). Set EDGE_DEV_ALLOW_UNAUTHENTICATED=true for local dev.",
      );
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

    const path = normalizeRequestPath(req.raw.url ?? "/");
    if (path === null) {
      sendNotFound(reply);
      return;
    }

    const method = req.method === "HEAD" ? "HEAD" : "GET";
    const relPath = path === "/" ? "index.html" : path.slice(1);
    const ifNoneMatch = firstHeader(req.headers["if-none-match"]);

    let result = await getUnderPrefix(blob, entry.blobPrefix, relPath, { method, ifNoneMatch });

    // SPA fallback: an HTML-navigation miss serves the app shell so deep
    // links into client-side routes work. Asset misses stay hard 404s.
    if (
      result.kind === "not-found" &&
      relPath !== "index.html" &&
      (req.headers.accept ?? "").includes("text/html")
    ) {
      result = await getUnderPrefix(blob, entry.blobPrefix, "index.html", { method, ifNoneMatch });
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
      reply.status(304).header("cache-control", "no-cache");
      if (result.etag) reply.header("etag", result.etag);
      reply.send();
      return;
    }

    reply
      .status(200)
      .header("content-type", result.contentType ?? "application/octet-stream")
      .header("cache-control", cacheControl)
      .header("x-content-type-options", "nosniff");
    if (result.contentLength) reply.header("content-length", result.contentLength);
    if (result.etag) reply.header("etag", result.etag);
    if (result.lastModified) reply.header("last-modified", result.lastModified);
    if (isHtml) reply.header("content-security-policy", APP_CSP);

    // Stop pulling from Blob if the client goes away mid-stream.
    req.raw.on("close", () => {
      if (req.raw.destroyed && result.kind === "found") result.body.destroy();
    });

    // Fastify pipes the stream — assets are never buffered (project plan §1).
    await reply.send(result.body);
  };
}

async function getUnderPrefix(
  blob: BlobReader,
  blobPrefix: string,
  relPath: string,
  opts: { method: "GET" | "HEAD"; ifNoneMatch?: string },
): Promise<BlobGetResult> {
  const key = `${blobPrefix}${relPath}`;
  // Bug trap, not input validation — normalizeRequestPath already rejected
  // traversal, so a violation here is a programming error.
  if (!key.startsWith(blobPrefix) || key.includes("..")) {
    throw new Error(`asset key escaped version prefix: ${key}`);
  }
  return blob.get(key, opts);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
