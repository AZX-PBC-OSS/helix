import type { FastifyReply } from "fastify";

/**
 * Terminal responses for the app-serving path. Plain bodies, no app headers,
 * `no-store` — error responses must never stick in a cache.
 */

export function sendNotFound(reply: FastifyReply): void {
  // Unknown slug, no live version, rejected path and missing asset all answer
  // identically — don't disclose which.
  reply
    .status(404)
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Not found\n");
}

export function sendGone(reply: FastifyReply): void {
  // Archived app (architecture §7): 410 + Clear-Site-Data evicts cached UI
  // and storage. Values must be double-quoted per spec; browsers honor the
  // header on secure origins only (plain-HTTP dev: harmless no-op).
  reply
    .status(410)
    .header("cache-control", "no-store")
    .header("clear-site-data", '"cache", "storage"')
    .type("text/html; charset=utf-8")
    .send(
      "<!doctype html><html><body><h1>410</h1><p>This app has been archived.</p></body></html>\n",
    );
}

export function sendMethodNotAllowed(reply: FastifyReply): void {
  reply
    .status(405)
    .header("allow", "GET, HEAD")
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send("Method not allowed\n");
}

export function sendUnavailable(reply: FastifyReply, message: string): void {
  reply
    .status(503)
    .header("retry-after", "5")
    .header("cache-control", "no-store")
    .type("text/plain; charset=utf-8")
    .send(`${message}\n`);
}
