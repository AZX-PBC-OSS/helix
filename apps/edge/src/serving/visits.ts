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
 * True for a top-level document load. Browsers send `Sec-Fetch-Dest` on every
 * request; scanners and most bots do not, so a request without it is not
 * counted. That makes the header a cheap bot filter as well as the
 * document-vs-subresource test. Iframe embeds (`iframe`) are not counted.
 */
export function isDocumentLoad(req: FastifyRequest): boolean {
  return req.method === "GET" && req.headers["sec-fetch-dest"] === "document";
}

/**
 * The client IP's network: /24 for IPv4, /48 for IPv6. An IPv4-mapped IPv6
 * address is treated as the IPv4 it carries. Anything unparseable is null.
 */
export function truncateIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped?.[1] ?? ip;
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

export interface VisitRecorderDeps {
  store: VisitStore;
  /** Null when the edge has no auth secret: visits count, unique visitors don't. */
  key: Buffer | null;
}

/**
 * Build the call the asset handler makes once it has decided to send an HTML
 * document. It never awaits the write and never throws: a lost visit is
 * counted on `helix.app.visits{outcome="failed"}` and logged, and the
 * response is unaffected.
 */
export function makeVisitRecorder(deps: VisitRecorderDeps) {
  return function recordVisit(req: FastifyRequest, appId: string): void {
    const ip = req.ip;
    const visit: VisitRecord = {
      appId,
      visitorHash: deps.key && ip ? visitorHash(deps.key, appId, ip) : null,
      ipPrefix: truncateIp(ip),
    };
    const count = (outcome: VisitRecordOutcome): void => {
      instruments().appVisits.add(1, { [ATTR_APP_ID]: appId, [ATTR_OUTCOME]: outcome });
    };
    void deps.store.record(visit).then(
      () => count("recorded"),
      (err: unknown) => {
        count("failed");
        req.log.warn({ err, appId }, "app_visits insert failed");
      },
    );
  };
}

export type VisitRecorder = ReturnType<typeof makeVisitRecorder>;
