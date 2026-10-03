import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { type Pool } from "pg";
import type { FastifyRequest } from "fastify";
import { ATTR_APP_ID, ATTR_OUTCOME, type VisitRecordOutcome } from "@azx-pbc/shared/telemetry";
import { createEdgePool, type EdgePoolOpts } from "../db/pool.js";
import { withPartition } from "../db/partition.js";
import { instruments } from "../telemetry.js";

/**
 * Hosted-app visit recording (ADR-0050). One `app_visits` row per top-level
 * HTML document the edge serves past the session gate. The row carries a keyed
 * hash of the client IP and the IP truncated to a network prefix — never the
 * IP itself, a user identity, the path or the user agent. The edge holds an
 * INSERT-only grant, so it can append visits but never read them back.
 */

export interface VisitRecord {
  appId: string;
  /** HMAC of `appId|ip`, or null when the edge has no key to compute it. */
  visitorHash: string | null;
  /** `a.b.c.0/24` or an IPv6 `/48`; null when no client IP was seen. */
  ipPrefix: string | null;
}

export interface VisitStore {
  record(visit: VisitRecord): Promise<void>;
  close(): Promise<void>;
}

export class PgVisitStore implements VisitStore {
  #pool: Pool;

  constructor(databaseUrl: string, opts: EdgePoolOpts = {}) {
    this.#pool = createEdgePool(databaseUrl, {
      ...opts,
      max: opts.max ?? 4,
      label: opts.label ?? "visits",
      // Nothing awaits these writes, so a waiter must give up rather than queue
      // behind a slow database at request rate.
      connectionTimeoutMs: opts.connectionTimeoutMs ?? 2_000,
    });
  }

  async record(visit: VisitRecord): Promise<void> {
    // Only the prod edge serves documents; the RLS policy pins env = 'prod'.
    await withPartition(this.#pool, visit.appId, null, "prod", async (client) => {
      await client.query(
        `INSERT INTO app_visits (id, "appId", env, "visitorHash", "ipPrefix")
         VALUES (gen_random_uuid(), $1, 'prod', $2, $3)`,
        [visit.appId, visit.visitorHash, visit.ipPrefix],
      );
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/**
 * True for a top-level document load a person asked for. Browsers send
 * `Sec-Fetch-Dest` on every request; scanners and most bots do not, so a
 * request without it is not counted. That makes the header a cheap bot filter
 * as well as the document-vs-subresource test. Iframe embeds (`iframe`) are not
 * counted, and neither are speculative loads: prefetch and prerender send
 * `Sec-Purpose` (or the legacy `Purpose`) even when the page is never opened.
 */
export function isDocumentLoad(req: FastifyRequest): boolean {
  return (
    req.method === "GET" &&
    req.headers["sec-fetch-dest"] === "document" &&
    req.headers["sec-purpose"] === undefined &&
    req.headers.purpose === undefined
  );
}

/**
 * The address as the IPv4 it carries when it is IPv4-mapped (`::ffff:a.b.c.d`).
 * Both the hash and the prefix take this form, so one client seen both ways is
 * one visitor.
 */
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

/**
 * The client IP's network: /24 for IPv4, /48 for IPv6. An IPv4-mapped IPv6
 * address is treated as the IPv4 it carries. Anything unparseable is null.
 */
export function truncateIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = normalizeIp(ip);
  if (isIPv4(v4)) {
    const [a, b, c] = v4.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIPv6(ip)) {
    const groups = expandIPv6(ip);
    if (!groups) return null;
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return null;
}

/** The eight 16-bit groups of an IPv6 address, without leading zeros. */
function expandIPv6(ip: string): string[] | null {
  // A zone id (`fe80::1%eth0`) names an interface, not a network.
  const bare = ip.split("%")[0] ?? "";
  const [head, tail] = bare.split("::");
  const parse = (s: string | undefined): string[] => (s ? s.split(":") : []);
  const left = parse(head);
  const right = parse(tail);
  // An embedded dotted quad occupies the last two groups, which a /48 never reads.
  const rightLen = right.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const fill = tail === undefined ? 0 : 8 - left.length - rightLen;
  if (fill < 0) return null;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  return groups.map((g) => (g.includes(".") ? g : (parseInt(g, 16) || 0).toString(16)));
}

/** Keyed so the hash can't be reversed by enumerating the IPv4 space. */
export function visitorHash(key: Buffer, appId: string, ip: string): string {
  return createHmac("sha256", key).update(`${appId}|${ip}`).digest("hex").slice(0, 32);
}

/** Writes in flight past which a visit is dropped rather than queued. */
export const MAX_VISITS_IN_FLIGHT = 64;
/** A repeat load by the same visitor within this window is not re-recorded. */
export const VISIT_DEDUPE_MS = 60_000;
/** Bound on the per-replica dedupe map; the oldest entry is evicted first. */
export const VISIT_DEDUPE_ENTRIES = 10_000;

export interface VisitRecorderDeps {
  store: VisitStore;
  /** Null when the edge has no auth secret: visits count, unique visitors don't. */
  key: Buffer | null;
  /** Clock seam for the dedupe window (tests). */
  now?: () => number;
}

/**
 * Build the call the asset handler makes once it has decided to send an HTML
 * document. It never awaits the write and never throws, and it bounds the work
 * before it reaches the pool:
 *
 * - A repeat load by the same visitor within {@link VISIT_DEDUPE_MS} is skipped.
 *   The 30-minute visit grouping makes that row redundant, and skipping it
 *   absorbs refresh spam and a single-address flood. The map is per replica, so
 *   a visitor alternating between replicas can still write one row per replica.
 * - Past {@link MAX_VISITS_IN_FLIGHT} pending writes, a visit is dropped. That
 *   bounds memory under a slow database or a many-address flood.
 *
 * Every outcome is counted on `helix.app.visits`; a failed write is also logged.
 */
export function makeVisitRecorder(deps: VisitRecorderDeps) {
  const now = deps.now ?? Date.now;
  const lastRecorded = new Map<string, number>();
  let inFlight = 0;

  return function recordVisit(req: FastifyRequest, appId: string): void {
    const count = (outcome: VisitRecordOutcome): void => {
      instruments().appVisits.add(1, { [ATTR_APP_ID]: appId, [ATTR_OUTCOME]: outcome });
    };
    const ip = req.ip ? normalizeIp(req.ip) : undefined;
    const hash = deps.key && ip ? visitorHash(deps.key, appId, ip) : null;

    const key = hash === null ? null : `${appId}|${hash}`;
    const at = now();
    if (key !== null) {
      const seen = lastRecorded.get(key);
      if (seen !== undefined && at - seen < VISIT_DEDUPE_MS) {
        count("deduplicated");
        return;
      }
    }
    if (inFlight >= MAX_VISITS_IN_FLIGHT) {
      // Not marked as seen: the visitor's next load should still get a row.
      count("dropped");
      return;
    }
    if (key !== null) {
      // Delete then set, so the Map's insertion order stays oldest-first.
      lastRecorded.delete(key);
      lastRecorded.set(key, at);
      if (lastRecorded.size > VISIT_DEDUPE_ENTRIES) {
        const oldest = lastRecorded.keys().next().value;
        if (oldest !== undefined) lastRecorded.delete(oldest);
      }
    }
    inFlight++;
    void deps.store
      .record({ appId, visitorHash: hash, ipPrefix: truncateIp(ip) })
      .then(
        () => count("recorded"),
        (err: unknown) => {
          count("failed");
          req.log.warn({ err, appId }, "app_visits insert failed");
        },
      )
      .finally(() => {
        inFlight--;
      });
  };
}

export type VisitRecorder = ReturnType<typeof makeVisitRecorder>;
